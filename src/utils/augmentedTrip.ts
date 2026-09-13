import * as qdf from "qdf-gtfs";
import { getServiceDatesByTrip } from "./calendar.js";
import { AugmentedStopTime, augmentStopTimes } from "./augmentedStopTime.js";
import * as cache from "../cache/index.js";
import { getServiceCapacity, ServiceCapacity } from "./serviceCapacity.js";
import type { ExpressInfo } from "./SRT.js";
import {
	createJourneyContext,
	createRealtimeJourneyContext,
	expressInfoFromCorridor,
	resolveJourneyCorridor,
} from "./corridor/resolver.js";
import type { CorridorResolution, JourneyContext } from "./corridor/types.js";
import { getFeedTimeZone, resolveTripNumber } from "../config.js";
import { addDaysToServiceDate, getEpochDayFromServiceDate, getServiceDateFromEpochDay, getServiceDayStart, getToday } from "./time.js";
import { encodeTripInstanceId, entityKey } from "../identity.js";
import { isNonRevenueTrip } from "./considered.js";
import { pluginSupportsFeed } from "../plugins/types.js";

export type AugmentedTripInstance = qdf.Trip & {
	instance_id: string;
	trip_id: string;
	serviceDate: string;
	schedule_relationship: qdf.TripScheduleRelationship;
	stopTimes: AugmentedStopTime[];
	realtime_update: qdf.RealtimeTripUpdate | null;
	expressInfo: ExpressInfo[];
	vehicle_model: string | null;
	vehicle_id: string | null;
	vehicle_details?: unknown | null;
	_seq_direction_data?: { centralIndex: number; romaIndex: number; firstCityIndex: number } | null;
	passenger_cars: number | null;
	scheduled_passenger_cars: number | null;
	consist: string[] | null;
	nonRevenue: boolean;

	scheduledTripDates: string[];
	actualTripDates: string[];

	trip_number: string;

	rt_start_date: string | null;
	/** Frequency-template metadata. Times remain GTFS service-day seconds. */
	frequency_start_time: number | null;
	frequency_headway_secs: number | null;
	frequency_exact: boolean | null;

	/** AU/SEQ diagram (same vehicle / line-of-route block), static + realtime validity */
	seq_diagram_prev_trip_id: string | null;
	seq_diagram_next_trip_id: string | null;
	/** Inferred diagram block id (string; same type as GTFS `trips.block_id`). */
	seq_diagram_block_id: string | null;
	seq_diagram_prev_instance_id: string | null;
	seq_diagram_next_instance_id: string | null;
	seq_diagram_prev_link_broken: boolean;
	seq_diagram_next_link_broken: boolean;
};

export type AugmentedTrip = qdf.Trip & {
	scheduledStartServiceDates: string[];
	instances: AugmentedTripInstance[];
};

export type RunSeries = {
	series: string;
	date: string;
	trips: string[];
	vehicle_sightings: { vehicle_id: string; trip_id: string }[];
};

export const OPERATIONAL_HORIZON_PAST_DAYS = 1;
export const OPERATIONAL_HORIZON_FUTURE_DAYS = 1;

/**
 * Explicit bound for exact_times=1 frequency expansion, per service day.
 * Replaces the previous silent 10k truncation: pathological feeds now throw
 * a RangeError instead of silently dropping runs.
 */
export const MAX_FREQUENCY_RUNS_PER_DAY = 10_000;

/**
 * Explicit finite bound for trip lookback (service-day spillover).
 * Non-finite stop-time/frequency bounds must never produce Infinity and hang
 * date loops; lookback is clamped to this many days.
 */
export const MAX_TRIP_LOOKBACK_DAYS = 7;

function clampLookbackDays(days: number): number {
	if (!Number.isFinite(days)) return 1;
	return Math.min(MAX_TRIP_LOOKBACK_DAYS, Math.max(1, Math.floor(days)));
}

function frequencyExtent(rows: readonly qdf.Frequency[]): { start_time: number; end_time: number } | null {
	let start: number | null = null;
	let end: number | null = null;
	for (const row of rows) {
		const s = row.start_time;
		const e = row.end_time;
		if (typeof s === "number" && Number.isFinite(s)) {
			if (start === null || s < start) start = s;
		}
		if (typeof e === "number" && Number.isFinite(e)) {
			if (end === null || e > end) end = e;
		}
	}
	if (start === null || end === null) return null;
	return { start_time: start, end_time: end };
}

export function normalizeGtfsClockString(value: string | null | undefined): string {
	if (value == null) return "";
	const trimmed = String(value).trim();
	if (trimmed === "") return "";
	const match = /^(\d+):(\d{2})(?::(\d{2}))?$/.exec(trimmed);
	if (!match) return trimmed;
	const hours = Number(match[1]);
	const minutes = Number(match[2]);
	const seconds = Number(match[3] ?? "0");
	if (!Number.isFinite(hours) || !Number.isFinite(minutes) || !Number.isFinite(seconds)) return trimmed;
	if (minutes > 59 || seconds > 59 || hours < 0) return trimmed;
	const total = hours * 3600 + minutes * 60 + seconds;
	if (!Number.isFinite(total) || total < 0) return trimmed;
	const hh = Math.floor(total / 3600);
	const mm = Math.floor((total % 3600) / 60);
	const ss = total % 60;
	return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

export function parseGtfsClockToSeconds(value: string | null | undefined): number | null {
	if (value == null) return null;
	const trimmed = String(value).trim();
	if (trimmed === "") return null;
	const match = /^(\d+):(\d{2})(?::(\d{2}))?$/.exec(trimmed);
	if (!match) return null;
	const hours = Number(match[1]);
	const minutes = Number(match[2]);
	const seconds = Number(match[3] ?? "0");
	if (!Number.isFinite(hours) || !Number.isFinite(minutes) || !Number.isFinite(seconds)) return null;
	if (minutes > 59 || seconds > 59 || hours < 0) return null;
	const total = hours * 3600 + minutes * 60 + seconds;
	if (!Number.isFinite(total) || total < 0) return null;
	return total;
}

function formatGtfsClock(seconds: number): string {
	const total = Math.floor(seconds);
	const hh = Math.floor(total / 3600);
	const mm = Math.floor((total % 3600) / 60);
	const ss = total % 60;
	return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

export type AugmentTripOptions = {
	/** Restrict construction to explicit start service dates for lazy materialization. */
	serviceDates?: readonly string[];
	/** Restrict realtime updates independently from scheduled calendar dates. */
	realtimeDates?: readonly string[];
};

/** Build the minimal static-shaped record needed to expose a realtime-only trip. */
export function createRealtimeOnlyTrip(update: qdf.RealtimeTripUpdate): qdf.Trip {
	return {
		trip_id: update.trip.trip_id,
		route_id: update.trip.route_id,
		service_id: `realtime-${update.trip.start_date ?? "unknown"}`,
		trip_headsign: null,
		trip_short_name: null,
		direction_id: update.trip.direction_id,
		block_id: null,
		shape_id: null,
		wheelchair_accessible: null,
		bikes_allowed: null,
		feed_id: update.feed_id,
	};
}

function dateToEpochDays(ymd: number | string): number {
	const ymdStr = ymd.toString();
	let y = Number.parseInt(ymdStr.slice(0, 4));
	let m = Number.parseInt(ymdStr.slice(4, 6));
	let d = Number.parseInt(ymdStr.slice(6, 8));
	m = (m + 9) % 12;
	y = y - Math.floor(m / 10);
	return (
		365 * y +
		Math.floor(y / 4) -
		Math.floor(y / 100) +
		Math.floor(y / 400) +
		Math.floor((m * 306 + 5) / 10) +
		(d - 1)
	);
}

/** Select scheduled starts whose full GTFS interval overlaps today +/- one day. */
export function getOperationalServiceDatesForTrip(
	trip: qdf.Trip,
	ctx: cache.CacheContext,
	bounds: qdf.TripStopTimeBounds | undefined = ctx.raw.tripStopTimeBoundsByKey.get(
		entityKey({ feedId: trip.feed_id, localId: trip.trip_id }),
	),
): string[] {
	if (!bounds) return [];
	if (!Number.isFinite(bounds.start_time) || !Number.isFinite(bounds.end_time)) return [];
	const tripKey = entityKey({ feedId: trip.feed_id, localId: trip.trip_id });
	const frequencyRows = ctx.raw.frequenciesByTripKey?.get(tripKey) ?? [];
	let effectiveBounds: { start_time: number; end_time: number } = bounds;
	if (frequencyRows.length > 0) {
		const extent = frequencyExtent(frequencyRows);
		if (extent) {
			const duration = bounds.end_time - bounds.start_time;
			const safeDuration = Number.isFinite(duration) ? Math.max(0, duration) : 0;
			const end = extent.end_time + safeDuration;
			if (Number.isFinite(extent.start_time) && Number.isFinite(end)) {
				effectiveBounds = { start_time: extent.start_time, end_time: end };
			}
		}
	}
	if (!Number.isFinite(effectiveBounds.start_time) || !Number.isFinite(effectiveBounds.end_time)) return [];
	const timezone = getFeedTimeZone(ctx.config, trip.feed_id);
	const serviceDayStart = (serviceDate: string) => {
		const key = `${timezone}\0${serviceDate}`;
		let value = ctx.runtimeState.serviceDayStarts.get(key);
		if (value === undefined) {
			value = getServiceDayStart(serviceDate, timezone);
			ctx.runtimeState.serviceDayStarts.set(key, value);
		}
		return value;
	};
	let window = ctx.runtimeState.operationalWindows.get(trip.feed_id);
	if (!window) {
		const today = getToday(timezone);
		window = {
			todayEpochDay: getEpochDayFromServiceDate(today),
			horizonStart: serviceDayStart(addDaysToServiceDate(today, -OPERATIONAL_HORIZON_PAST_DAYS)),
			horizonEnd: serviceDayStart(addDaysToServiceDate(today, OPERATIONAL_HORIZON_FUTURE_DAYS + 1)),
		};
		ctx.runtimeState.operationalWindows.set(trip.feed_id, window);
	}
	const lookbackDays = clampLookbackDays(Math.ceil(effectiveBounds.end_time / 86_400) + 1);
	// Fast path: use runtime-scoped inverse indexes when available.
	if (ctx.runtimeState.servicesByDateHandle.size > 0 && ctx.runtimeState.tripsByServiceHandle.size > 0) {
		const serviceHandle = entityKey({ feedId: trip.feed_id, localId: trip.service_id });
		const overlapping: string[] = [];
		for (let epochDay = window.todayEpochDay - OPERATIONAL_HORIZON_PAST_DAYS - lookbackDays; epochDay <= window.todayEpochDay + OPERATIONAL_HORIZON_FUTURE_DAYS + 1; epochDay++) {
			const date = getServiceDateFromEpochDay(epochDay);
			// Check if this service is active for this date via the qualified key index.
			const servicesForDate = ctx.runtimeState.servicesByDateHandle.get(date);
			if (!servicesForDate || !servicesForDate.has(serviceHandle)) continue;
			const start = serviceDayStart(date);
			if (start + effectiveBounds.end_time >= window.horizonStart && start + effectiveBounds.start_time < window.horizonEnd) overlapping.push(date);
		}
		for (const serviceDate of overlapping) ctx.runtimeState.operationalServiceDates.add(serviceDate);
		return overlapping;
	}
	const candidateDates = getServiceDatesByTrip(
		{ feedId: trip.feed_id, localId: trip.trip_id },
		ctx,
		window.todayEpochDay - OPERATIONAL_HORIZON_PAST_DAYS - lookbackDays,
		window.todayEpochDay + OPERATIONAL_HORIZON_FUTURE_DAYS + 1,
	);
	const overlapping = candidateDates.filter((serviceDate) => {
		const start = serviceDayStart(serviceDate);
		return start + effectiveBounds.end_time >= window!.horizonStart && start + effectiveBounds.start_time < window!.horizonEnd;
	});
	for (const serviceDate of overlapping) ctx.runtimeState.operationalServiceDates.add(serviceDate);
	return overlapping;
}

export function augmentTrip(
	trip: qdf.Trip,
	ctx: cache.CacheContext,
	tripUpdatesCache?: Map<string, qdf.RealtimeTripUpdate[]>,
	reuseInstancesFrom?: AugmentedTrip,
	options: AugmentTripOptions = {},
): AugmentedTrip {
	ctx.augmented.timer.start("augmentTrip");
	const requestedServiceDates = options.serviceDates ?? getOperationalServiceDatesForTrip(trip, ctx);
	const serviceDateSet = new Set(requestedServiceDates);
	// Realtime refreshes must preserve lazily materialized scheduled dates which
	// are still resident. Explicit lazy calls intentionally build only their date.
	if (!options.serviceDates) {
		for (const instance of reuseInstancesFrom?.instances ?? []) {
			if (
				instance.realtime_update === null &&
				instance.schedule_relationship === qdf.TripScheduleRelationship.SCHEDULED
			) {
				serviceDateSet.add(instance.serviceDate);
			}
		}
		for (const retainedDate of ctx.runtimeState.lazyServiceDates.keys()) {
			const epochDay = dateToEpochDays(retainedDate);
			if (
				getServiceDatesByTrip(
					{ feedId: trip.feed_id, localId: trip.trip_id },
					ctx,
					epochDay,
					epochDay,
				).includes(retainedDate)
			) {
				serviceDateSet.add(retainedDate);
			}
		}
	}
	const serviceDates = Array.from(serviceDateSet).sort();

	ctx.augmented.timer.start("augmentTrip:getRawStopTimes");
	const tripRef = { feedId: trip.feed_id, localId: trip.trip_id };
	const tripKey = entityKey(tripRef);
	const route = cache.getRawRoute(ctx, { feedId: trip.feed_id, localId: trip.route_id });
	const rawStopTimes = cache.getRawStopTimes(ctx, tripRef).sort((a, b) => a.stop_sequence - b.stop_sequence);
	const frequencyRows = ctx.raw.frequenciesByTripKey?.get(tripKey) ?? [];
	const firstTemplateTimeRaw = rawStopTimes[0]?.departure_time ?? rawStopTimes[0]?.arrival_time ?? 0;
	const firstTemplateTime = Number.isFinite(firstTemplateTimeRaw) ? firstTemplateTimeRaw : 0;
	const formatStartTime = formatGtfsClock;
	const parseStartTime = parseGtfsClockToSeconds;
	const normalizeStartTime = (raw: string | null | undefined, frequencyRun?: { startTime: number }): string => {
		if (raw != null && String(raw).trim() !== "") {
			const parsed = parseGtfsClockToSeconds(raw);
			if (parsed !== null) return formatGtfsClock(parsed);
			return normalizeGtfsClockString(raw);
		}
		if (frequencyRun && Number.isFinite(frequencyRun.startTime)) return formatGtfsClock(frequencyRun.startTime);
		return "";
	};
	const frequencyStartsByTime = new Map<number, { frequency: qdf.Frequency; startTime: number }>();
	// GTFS contract: only exact_times=1 rows are compressed fixed schedules and
	// expand to discrete runs. exact_times=0 rows are headway-only service and
	// must not be materialized as exact discrete trips.
	const exactFrequencyRows = frequencyRows.filter(
		(row) =>
			row.exact_times === 1 &&
			Number.isFinite(row.start_time) &&
			Number.isFinite(row.end_time) &&
			Number.isFinite(row.headway_secs),
	);
	const hasFrequencyRows = frequencyRows.length > 0;
	for (const frequency of exactFrequencyRows) {
		if (!Number.isFinite(frequency.headway_secs) || frequency.headway_secs <= 0) continue;
		if (!Number.isFinite(frequency.start_time) || !Number.isFinite(frequency.end_time)) continue;
		if (frequency.end_time <= frequency.start_time) continue;
		for (let startTime = frequency.start_time; startTime < frequency.end_time; startTime += frequency.headway_secs) {
			if (frequencyStartsByTime.size >= MAX_FREQUENCY_RUNS_PER_DAY) {
				throw new RangeError(
					`frequency expansion for ${trip.feed_id}/${trip.trip_id} exceeds explicit bound of ${MAX_FREQUENCY_RUNS_PER_DAY} runs per day ` +
						`(start_time=${frequency.start_time} end_time=${frequency.end_time} headway_secs=${frequency.headway_secs})`,
				);
			}
			if (!frequencyStartsByTime.has(startTime)) frequencyStartsByTime.set(startTime, { frequency, startTime });
		}
	}
	const frequencyStarts = [...frequencyStartsByTime.values()].sort((left, right) => left.startTime - right.startTime);
	const hasExactFrequencyRuns = frequencyStarts.length > 0;
	if (hasExactFrequencyRuns) {
		const plannedInstances = frequencyStarts.length * serviceDates.length;
		if (plannedInstances > MAX_FREQUENCY_RUNS_PER_DAY) {
			throw new RangeError(
				`frequency expansion for ${trip.feed_id}/${trip.trip_id} exceeds explicit bound: ` +
					`${frequencyStarts.length} runs/day x ${serviceDates.length} service dates = ${plannedInstances} instances ` +
					`(bound ${MAX_FREQUENCY_RUNS_PER_DAY})`,
			);
		}
	}
	const nonRevenue = isNonRevenueTrip(route, rawStopTimes, ctx);
	ctx.augmented.timer.stop("augmentTrip:getRawStopTimes");

	const journey = createJourneyContext(trip, rawStopTimes, ctx);

	ctx.augmented.timer.start("augmentTrip:getTripUpdates");
	const allUpdates = tripUpdatesCache ? (tripUpdatesCache.get(tripKey) ?? []) : cache.getTripUpdates(ctx, tripRef);
	const realtimeDateSet = options.realtimeDates ? new Set(options.realtimeDates) : null;
	const updates = realtimeDateSet
		? allUpdates.filter((update) => {
				const startDate = update.trip.start_date;
				return startDate != null && realtimeDateSet.has(startDate);
			})
		: allUpdates;
	ctx.augmented.timer.stop("augmentTrip:getTripUpdates");
	let reusableStaticCorridor: CorridorResolution | null = null;
	const replacementHasConflictingSequences = (update: qdf.RealtimeTripUpdate): boolean => {
		const seen = new Set<number>();
		for (const stopTime of update.stop_time_updates) {
			if (stopTime.stop_sequence == null) continue;
			if (seen.has(stopTime.stop_sequence)) return true;
			seen.add(stopTime.stop_sequence);
		}
		return false;
	};

	const createInstance = (
		serviceDate: string,
		update: qdf.RealtimeTripUpdate | null,
		scheduleRelationship: qdf.TripScheduleRelationship,
		frequencyRun?: { frequency: qdf.Frequency; startTime: number },
	): AugmentedTripInstance => {
		ctx.augmented.timer.start("createInstance");
		const startDate = update?.trip.start_date ?? serviceDate;
		const rawStartTime = update?.trip.start_time;
		// Normalize equivalent raw forms (6:00:00 vs 06:00:00) to one canonical
		// clock so instance and dedupe identity do not split.
		const startTime = normalizeStartTime(rawStartTime, frequencyRun);

		const instance_id = encodeTripInstanceId({
			networkId: ctx.config.network.id,
			feedId: trip.feed_id,
			kind: "trip",
			localId: trip.trip_id,
			serviceDate: startDate,
			realtimeStartTime: startTime,
		});

		// A replacement must describe one unambiguous stop order before it can own
		// the whole instance. Some feeds publish a current segment with reset stop
		// sequences; retain the static trip in that case and apply updates by stop.
		const realtimeOwnsStopSequence =
			scheduleRelationship === qdf.TripScheduleRelationship.ADDED ||
			scheduleRelationship === qdf.TripScheduleRelationship.UNSCHEDULED ||
			(scheduleRelationship === qdf.TripScheduleRelationship.REPLACEMENT &&
				update !== null &&
				!replacementHasConflictingSequences(update));
		const frequencyOffset = frequencyRun ? frequencyRun.startTime - firstTemplateTime : 0;
		const shiftedStopTimes = frequencyOffset === 0
			? rawStopTimes
			: rawStopTimes.map((stopTime) => ({
				...stopTime,
				arrival_time: stopTime.arrival_time == null ? null : stopTime.arrival_time + frequencyOffset,
				departure_time: stopTime.departure_time == null ? null : stopTime.departure_time + frequencyOffset,
			}));
		const staticStopTimesForInstance = realtimeOwnsStopSequence ? null : shiftedStopTimes;
		const journeyForDate: JourneyContext =
			staticStopTimesForInstance === null && update
				? createRealtimeJourneyContext(update, ctx)
				: { ...journey, serviceDate };
		let corridor: CorridorResolution;
		if (journeyForDate.anchors.length < 2) {
			corridor = { gaps: [], nodes: [] };
		} else if (staticStopTimesForInstance !== null && reusableStaticCorridor) {
			corridor = reusableStaticCorridor;
		} else {
			corridor = resolveJourneyCorridor(journeyForDate, ctx);
			if (
				staticStopTimesForInstance !== null &&
				corridor.gaps.length === journeyForDate.anchors.length - 1 &&
				corridor.gaps.every((gap) => gap.status === "resolved" && gap.evidence === "exact-shape")
			) {
				reusableStaticCorridor = corridor;
			}
		}
		const expressInfo = expressInfoFromCorridor(corridor);

		ctx.augmented.timer.start("createInstance:augmentStopTimes");
		const stopTimes = augmentStopTimes(
			staticStopTimesForInstance,
			{
				serviceDate,
				tripUpdate: update,
				scheduleRelationship,
				journey: journeyForDate,
				corridor,
			},
			ctx,
		);
		ctx.augmented.timer.stop("createInstance:augmentStopTimes");

		ctx.augmented.timer.start("createInstance:calculateTripDates");
		const getUniqueDates = (times: AugmentedStopTime[], type: "scheduled" | "actual") => {
			const dates = new Set<string>();
			for (let i = 0; i < times.length; i++) {
				const st = times[i];
				const arr = type === "scheduled" ? st.scheduled_arrival_dates : st.actual_arrival_dates;
				const dep = type === "scheduled" ? st.scheduled_departure_dates : st.actual_departure_dates;
				if (arr) for (let j = 0; j < arr.length; j++) dates.add(arr[j]);
				if (dep) for (let j = 0; j < dep.length; j++) dates.add(dep[j]);
			}
			if (dates.size === 1) {
				const singleDate = dates.values().next().value as string;
				if (singleDate === serviceDate)
					return (type === "scheduled" ? scheduled_dates : actual_dates) ?? [singleDate];
				return [singleDate];
			}
			return Array.from(dates).sort((a, b) => Number.parseInt(a) - Number.parseInt(b));
		};

		// Common case pre-check to avoid Set creation
		let scheduled_dates: string[] | null = null;
		let actual_dates: string[] | null = null;

		const scheduledTripDates = getUniqueDates(stopTimes, "scheduled");
		const actualTripDates = getUniqueDates(stopTimes, "actual");
		ctx.augmented.timer.stop("createInstance:calculateTripDates");

		const trip_number = resolveTripNumber(ctx.config.network, trip, {
			vehicleLabel: update?.vehicle?.label ?? null,
		});

		let instance: AugmentedTripInstance = {
			...trip,
			instance_id,
			serviceDate,
			schedule_relationship: scheduleRelationship,
			stopTimes,
			realtime_update: update,
			expressInfo,
			trip_number,
			vehicle_model: null,
			vehicle_id: null,
			passenger_cars: null,
			scheduled_passenger_cars: null,
			consist: null,
			nonRevenue,
			scheduledTripDates,
			actualTripDates,
			rt_start_date: update?.trip.start_date ?? null,
			frequency_start_time: frequencyRun?.startTime ?? null,
			frequency_headway_secs: frequencyRun?.frequency.headway_secs ?? null,
			frequency_exact: frequencyRun ? frequencyRun.frequency.exact_times === 1 : null,
			seq_diagram_prev_trip_id: null,
			seq_diagram_next_trip_id: null,
			seq_diagram_block_id: null,
			seq_diagram_prev_instance_id: null,
			seq_diagram_next_instance_id: null,
			seq_diagram_prev_link_broken: false,
			seq_diagram_next_link_broken: false,
		};

		for (const plugin of ctx.config.network.plugins) {
			if (!pluginSupportsFeed(plugin, instance.feed_id) || !plugin.enrichTrip) continue;
			instance = plugin.enrichTrip(instance, ctx) ?? instance;
		}

		ctx.augmented.timer.start("createInstance:serviceCapacity");
		let prev_cap: ServiceCapacity = ServiceCapacity.UNKNOWN;

		for (let i = 0; i < instance.stopTimes.length; i++) {
			const st = instance.stopTimes[i];
			if (!st.passing) {
				st.service_capacity = getServiceCapacity(instance, st, serviceDate, undefined, ctx, ctx.config);
				if (st.service_capacity !== ServiceCapacity.NOT_CALCULATED) prev_cap = st.service_capacity;
				else st.service_capacity = prev_cap;
			}

			st.instance_id = instance.instance_id;
			st.service_date = instance.serviceDate;
			st.schedule_relationship = instance.schedule_relationship;
		}
		ctx.augmented.timer.stop("createInstance:serviceCapacity");

		ctx.augmented.timer.stop("createInstance");
		return instance;
	};

	ctx.augmented.timer.start("augmentTrip:createInstances");
	const instances: AugmentedTripInstance[] = [];
	const coveredServiceDates = new Set<string>();
	const coveredFrequencyRuns = new Set<string>();
	type Winner = {
		update: qdf.RealtimeTripUpdate;
		frequencyRun?: { frequency: qdf.Frequency; startTime: number };
		relationship: qdf.TripScheduleRelationship;
	};
	const instanceWinners = new Map<string, Winner>();
	const pickWinner = (left: Winner, right: Winner): Winner => {
		const leftTime = left.update.timestamp ?? 0;
		const rightTime = right.update.timestamp ?? 0;
		if (leftTime !== rightTime) return leftTime > rightTime ? left : right;
		const leftId = left.update.update_id ?? "";
		const rightId = right.update.update_id ?? "";
		if (leftId !== rightId) return leftId < rightId ? left : right;
		return JSON.stringify(left.update) <= JSON.stringify(right.update) ? left : right;
	};
	const offerWinner = (
		update: qdf.RealtimeTripUpdate,
		frequencyRun: { frequency: qdf.Frequency; startTime: number } | undefined,
		relationship: qdf.TripScheduleRelationship,
	): void => {
		const startDate = update.trip.start_date!;
		const normalized = normalizeStartTime(update.trip.start_time, frequencyRun);
		const dedupeKey = `${tripKey}\0${startDate}\0${normalized}`;
		const candidate: Winner = { update, frequencyRun, relationship };
		const existing = instanceWinners.get(dedupeKey);
		if (!existing) instanceWinners.set(dedupeKey, candidate);
		else instanceWinners.set(dedupeKey, pickWinner(existing, candidate));
	};
	const reusableScheduledInstances = new Map<string, AugmentedTripInstance>();
	for (const instance of reuseInstancesFrom?.instances ?? []) {
		if (
			instance.realtime_update === null &&
			instance.schedule_relationship === qdf.TripScheduleRelationship.SCHEDULED
		) {
			reusableScheduledInstances.set(`${instance.serviceDate}\0${instance.frequency_start_time ?? ""}`, instance);
		}
	}

	for (const update of updates) {
		const rel = update.trip.schedule_relationship;
		const startDate = update.trip.start_date;

		if (!startDate) continue;
		const updateStart = parseStartTime(update.trip.start_time);
		const frequencyRun = updateStart == null
			? undefined
			: frequencyStarts.find((run) => run.startTime === updateStart) ??
				exactFrequencyRows
					.filter(
						(row) =>
							Number.isFinite(row.start_time) &&
							Number.isFinite(row.end_time) &&
							row.start_time <= updateStart &&
							updateStart < row.end_time,
					)
					.map((frequency) => ({ frequency, startTime: updateStart }))[0] ??
				// Headway-only (exact_times=0) realtime runs carry arbitrary start
				// times. Accept them within their inexact interval so UNSCHEDULED
				// headway service is not silently dropped.
				frequencyRows
					.filter(
						(row) =>
							row.exact_times !== 1 &&
							Number.isFinite(row.start_time) &&
							Number.isFinite(row.end_time) &&
							row.start_time <= updateStart &&
							updateStart < row.end_time,
					)
					.map((frequency) => ({ frequency, startTime: updateStart }))[0];
		if (hasFrequencyRows && !frequencyRun) {
			if (rel === qdf.TripScheduleRelationship.CANCELED) {
				// Date-level template cancel (GTFS-RT normally requires start_time
				// for frequency trips, but producers emit date-level cancels).
				// Dropping it would leave ghost service, so cancel the date's runs.
				if (hasExactFrequencyRuns) {
					for (const run of frequencyStarts) {
						const key = `${startDate}\0${run.startTime}`;
						if (coveredFrequencyRuns.has(key)) continue;
						coveredFrequencyRuns.add(key);
						const perRunUpdate: qdf.RealtimeTripUpdate = {
							...update,
							trip: { ...update.trip, start_time: formatStartTime(run.startTime), start_date: startDate },
						};
						offerWinner(perRunUpdate, run, rel);
					}
				} else if (!coveredServiceDates.has(startDate)) {
					// Headway-only has no discrete runs; record a single
					// date-level marker so the cancellation is visible.
					coveredServiceDates.add(startDate);
					offerWinner(update, undefined, rel);
				}
				continue;
			}
			// A frequency template can have several instances on one service date.
			// Applying an update without a matching start_time would pick one at random.
			continue;
		}
		if (frequencyRun) coveredFrequencyRuns.add(`${startDate}\0${frequencyRun.startTime}`);

		if (rel === qdf.TripScheduleRelationship.SCHEDULED) {
			if (!frequencyRun) coveredServiceDates.add(startDate);
			offerWinner(update, frequencyRun, rel);
		} else if (rel === qdf.TripScheduleRelationship.UNSCHEDULED) {
			coveredServiceDates.add(startDate);
			offerWinner(update, frequencyRun, rel);
		} else if (rel === qdf.TripScheduleRelationship.CANCELED) {
			if (!frequencyRun) coveredServiceDates.add(startDate);
			offerWinner(update, frequencyRun, rel);
		} else if (rel === qdf.TripScheduleRelationship.DUPLICATED) {
			// DUPLICATED adds a start-time-qualified instance and leaves the
			// scheduled instance for the service date in place. Duplicate
			// same-key DUPLICATED updates share one identity and must dedupe
			// deterministically like REPLACEMENT without losing distinct runs.
			offerWinner(update, frequencyRun, rel);
		} else if (rel === qdf.TripScheduleRelationship.REPLACEMENT) {
			// Same-key REPLACEMENT updates share one qualified instance identity
			// (trip + service date + realtime start time). Creating one instance
			// per update would duplicate instance_id and corrupt instancesRec.
			// Keep a single deterministic winner per key: latest timestamp,
			// then smallest update_id, then smallest payload.
			offerWinner(update, frequencyRun, rel);
			if (!frequencyRun) coveredServiceDates.add(startDate);
		} else if (rel === qdf.TripScheduleRelationship.ADDED) {
			if (!frequencyRun) coveredServiceDates.add(startDate);
			offerWinner(update, frequencyRun, rel);
		}
	}
	for (const { update, frequencyRun, relationship } of [...instanceWinners.values()].sort(
		(a, b) =>
			(a.update.trip.start_date ?? "").localeCompare(b.update.trip.start_date ?? "") ||
			normalizeStartTime(a.update.trip.start_time, a.frequencyRun).localeCompare(
				normalizeStartTime(b.update.trip.start_time, b.frequencyRun),
			) ||
			(a.update.update_id ?? "").localeCompare(b.update.update_id ?? ""),
	)) {
		instances.push(createInstance(update.trip.start_date!, update, relationship, frequencyRun));
	}

	for (const sDate of serviceDates) {
		if (hasExactFrequencyRuns) {
			for (const frequencyRun of frequencyStarts) {
				if (coveredFrequencyRuns.has(`${sDate}\0${frequencyRun.startTime}`)) continue;
				const reusable = reusableScheduledInstances.get(`${sDate}\0${frequencyRun.startTime}`);
				instances.push(
					reusable ?? createInstance(sDate, null, qdf.TripScheduleRelationship.SCHEDULED, frequencyRun),
				);
			}
		} else if (!hasFrequencyRows && !coveredServiceDates.has(sDate)) {
			const reusable = reusableScheduledInstances.get(`${sDate}\0`);
			instances.push(reusable ?? createInstance(sDate, null, qdf.TripScheduleRelationship.SCHEDULED));
		}
		// Headway-only (hasFrequencyRows && !hasExactFrequencyRuns) intentionally
		// produces no discrete SCHEDULED instances: exact_times=0 is headway
		// service, not a fixed schedule, so materializing template times would
		// fabricate exact departures.
	}
	ctx.augmented.timer.stop("augmentTrip:createInstances");

	const augmentedTrip: AugmentedTrip = {
		...trip,
		scheduledStartServiceDates: serviceDates,
		instances,
	};

	ctx.augmented.timer.stop("augmentTrip");
	return augmentedTrip;
}

export function calculateRunSeries(instance: AugmentedTripInstance, ctx: cache.CacheContext): RunSeries {
	const seriesRaw =
		instance.trip_number ||
		resolveTripNumber(ctx.config.network, instance, {
			vehicleLabel: instance.realtime_update?.vehicle?.label ?? null,
		});
	const series = seriesRaw.toUpperCase();
	const tripKey = entityKey({ feedId: instance.feed_id, localId: instance.trip_id });
	const vehicle_sightings: { vehicle_id: string; trip_id: string }[] = [];
	if (instance.vehicle_id) vehicle_sightings.push({ vehicle_id: instance.vehicle_id, trip_id: tripKey });
	if (instance.consist) {
		for (const carId of instance.consist) {
			vehicle_sightings.push({ vehicle_id: carId, trip_id: tripKey });
		}
	}
	// Merge with any existing entry for the same series/date so repeated calls
	// for distinct frequency instances accumulate instead of overwriting.
	const existing = ctx.augmented.runSeriesCache.get(instance.serviceDate)?.get(series);
	const trips = existing ? [...existing.trips] : [] as string[];
	if (!trips.includes(tripKey)) trips.push(tripKey);
	const mergedSightings = existing ? [...existing.vehicle_sightings] : [] as { vehicle_id: string; trip_id: string }[];
	const seenSightings = new Set(mergedSightings.map((s) => `${s.vehicle_id}\0${s.trip_id}`));
	for (const sighting of vehicle_sightings) {
		const key = `${sighting.vehicle_id}\0${sighting.trip_id}`;
		if (!seenSightings.has(key)) {
			seenSightings.add(key);
			mergedSightings.push(sighting);
		}
	}
	// Also track distinct frequency instances via their instance IDs so callers
	// can verify every run was indexed even when tripKeys collide.
	const runSeries: RunSeries = {
		series,
		date: instance.serviceDate,
		trips,
		vehicle_sightings: mergedSightings,
	};
	cache.setRunSeries(instance.serviceDate, series, runSeries, ctx);
	return runSeries;
}
