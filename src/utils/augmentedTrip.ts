import * as qdf from "qdf-gtfs";
import { getServiceDatesByTrip } from "./calendar.js";
import { AugmentedStopTime, augmentStopTimes } from "./augmentedStopTime.js";
import * as cache from "../cache/index.js";
import { getServiceCapacity, ServiceCapacity } from "./serviceCapacity.js";
import { ExpressInfo, findExpress } from "./SRT.js";
import { canonicalStationIdentity, getFeedTimeZone } from "../config.js";
import { getToday } from "./time.js";
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

export const EAGER_SERVICE_DATE_PAST_DAYS = 1;
export const EAGER_SERVICE_DATE_FUTURE_DAYS = 7;

export type AugmentTripOptions = {
	/** Restrict construction to explicit start service dates for lazy materialization. */
	serviceDates?: readonly string[];
	/** Restrict realtime updates independently from scheduled calendar dates. */
	realtimeDates?: readonly string[];
};

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

export function augmentTrip(
	trip: qdf.Trip,
	ctx: cache.CacheContext,
	tripUpdatesCache?: Map<string, qdf.RealtimeTripUpdate[]>,
	reuseInstancesFrom?: AugmentedTrip,
	options: AugmentTripOptions = {},
): AugmentedTrip {
	ctx.augmented.timer.start("augmentTrip");
	const todayEpoch = dateToEpochDays(getToday(getFeedTimeZone(ctx.config, trip.feed_id)));
	const requestedServiceDates =
		options.serviceDates ??
		getServiceDatesByTrip(
			{ feedId: trip.feed_id, localId: trip.trip_id },
			ctx,
			todayEpoch - EAGER_SERVICE_DATE_PAST_DAYS,
			todayEpoch + EAGER_SERVICE_DATE_FUTURE_DAYS,
		);
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
	const nonRevenue = isNonRevenueTrip(route, rawStopTimes, ctx);
	ctx.augmented.timer.stop("augmentTrip:getRawStopTimes");

	ctx.augmented.timer.start("augmentTrip:getParentStops");
	const parentStops = new Array<string>(rawStopTimes.length);
	const stopsRec = ctx.augmented.stopsRec;
	for (let i = 0; i < rawStopTimes.length; i++) {
		const cached = stopsRec.get(entityKey({ feedId: rawStopTimes[i].feed_id, localId: rawStopTimes[i].stop_id }));
		const localStopId = cached?.parent_stop_id ?? rawStopTimes[i].stop_id;
		parentStops[i] = entityKey(
			canonicalStationIdentity(ctx.config, { feedId: rawStopTimes[i].feed_id, localId: localStopId }),
		);
	}
	ctx.augmented.timer.stop("augmentTrip:getParentStops");

	ctx.augmented.timer.start("augmentTrip:findExpress");
	const parentStopSignature = parentStops.join("|");
	let expressInfo = ctx.augmented.expressInfoCache.get(parentStopSignature);
	if (!expressInfo) {
		expressInfo = findExpress(
			parentStops.filter((id): id is string => !!id),
			ctx,
		);
		ctx.augmented.expressInfoCache.set(parentStopSignature, expressInfo);
	}
	ctx.augmented.timer.stop("augmentTrip:findExpress");

	ctx.augmented.timer.start("augmentTrip:getTripUpdates");
	const allUpdates = tripUpdatesCache ? (tripUpdatesCache.get(tripKey) ?? []) : cache.getTripUpdates(ctx, tripRef);
	const realtimeDateSet = options.realtimeDates
		? new Set(options.realtimeDates)
		: options.serviceDates
			? serviceDateSet
			: null;
	const updates = realtimeDateSet
		? allUpdates.filter((update) => {
				const startDate = update.trip.start_date;
				return startDate != null && realtimeDateSet.has(startDate);
			})
		: allUpdates;
	ctx.augmented.timer.stop("augmentTrip:getTripUpdates");

	const createInstance = (
		serviceDate: string,
		update: qdf.RealtimeTripUpdate | null,
		scheduleRelationship: qdf.TripScheduleRelationship,
	): AugmentedTripInstance => {
		ctx.augmented.timer.start("createInstance");
		const startDate = update?.trip.start_date ?? serviceDate;
		const startTime = update?.trip.start_time ?? "";

		const instance_id = encodeTripInstanceId({
			networkId: ctx.config.network.id,
			feedId: trip.feed_id,
			kind: "trip",
			localId: trip.trip_id,
			serviceDate: startDate,
			realtimeStartTime: startTime,
		});

		ctx.augmented.timer.start("createInstance:augmentStopTimes");
		const stopTimes = augmentStopTimes(
			scheduleRelationship === qdf.TripScheduleRelationship.ADDED ||
				scheduleRelationship === qdf.TripScheduleRelationship.UNSCHEDULED ||
				scheduleRelationship === qdf.TripScheduleRelationship.REPLACEMENT
				? null
				: rawStopTimes,
			{
				serviceDate,
				tripUpdate: update,
				scheduleRelationship,
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

		let trip_number = "";

		trip_number = trip.trip_id.slice(-4);
		if (trip.trip_short_name && /^\d{1,3}$/.test(trip.trip_short_name)) trip_number = trip.trip_short_name;

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
	const reusableScheduledInstances = new Map<string, AugmentedTripInstance>();
	for (const instance of reuseInstancesFrom?.instances ?? []) {
		if (
			instance.realtime_update === null &&
			instance.schedule_relationship === qdf.TripScheduleRelationship.SCHEDULED
		) {
			reusableScheduledInstances.set(instance.serviceDate, instance);
		}
	}

	for (const update of updates) {
		const rel = update.trip.schedule_relationship;
		const startDate = update.trip.start_date;

		if (!startDate) continue;

		if (rel === qdf.TripScheduleRelationship.SCHEDULED) {
			coveredServiceDates.add(startDate);
			instances.push(createInstance(startDate, update, rel));
		} else if (rel === qdf.TripScheduleRelationship.UNSCHEDULED) {
			instances.push(createInstance(startDate, update, rel));
		} else if (rel === qdf.TripScheduleRelationship.CANCELED) {
			coveredServiceDates.add(startDate);
			instances.push(createInstance(startDate, update, rel));
		} else if (rel === qdf.TripScheduleRelationship.REPLACEMENT || rel === qdf.TripScheduleRelationship.ADDED) {
			coveredServiceDates.add(startDate);
			instances.push(createInstance(startDate, update, rel));
		}
	}

	for (const sDate of serviceDates) {
		if (!coveredServiceDates.has(sDate)) {
			const reusable = reusableScheduledInstances.get(sDate);
			instances.push(reusable ?? createInstance(sDate, null, qdf.TripScheduleRelationship.SCHEDULED));
		}
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
	const seriesRaw = instance.trip_number || instance.trip_id.slice(-4);
	const series = seriesRaw.toUpperCase();
	const tripKey = entityKey({ feedId: instance.feed_id, localId: instance.trip_id });
	const vehicle_sightings: { vehicle_id: string; trip_id: string }[] = [];
	if (instance.vehicle_id) vehicle_sightings.push({ vehicle_id: instance.vehicle_id, trip_id: tripKey });
	if (instance.consist) {
		for (const carId of instance.consist) {
			vehicle_sightings.push({ vehicle_id: carId, trip_id: tripKey });
		}
	}
	const runSeries: RunSeries = {
		series,
		date: instance.serviceDate,
		trips: [tripKey],
		vehicle_sightings,
	};
	cache.setRunSeries(instance.serviceDate, series, runSeries, ctx);
	return runSeries;
}
