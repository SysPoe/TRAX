import type {
	RealtimeStopTimeUpdate,
	RealtimeTripUpdate,
	RealtimeUpdateTripInfo,
	RealtimeVehiclePosition,
} from "qdf-gtfs";
import { StopTimeScheduleRelationship, TripScheduleRelationship } from "qdf-gtfs";
import type { CacheContext } from "./types.js";
import { entityKey } from "../identity.js";
import { getServiceDatesByTrip } from "../utils/calendar.js";
import { addDaysToServiceDate, getEpochDayFromServiceDate, getServiceDate, getServiceDayStart } from "../utils/time.js";
import { getFeedTimeZone } from "../config.js";

/** Resolve only a unique operating instance of a nonfrequency scheduled trip. */
function inferScheduledServiceDate(update: RealtimeTripUpdate, ctx: CacheContext): RealtimeTripUpdate {
	if (update.trip.start_date || update.trip.schedule_relationship !== TripScheduleRelationship.SCHEDULED || !ctx.gtfs)
		return update;
	const key = entityKey({ feedId: update.feed_id, localId: update.trip.trip_id });
	const bounds = ctx.raw.tripStopTimeBoundsByKey?.get(key);
	if (
		!bounds ||
		!Number.isFinite(bounds.start_time) ||
		!Number.isFinite(bounds.end_time) ||
		ctx.raw.frequenciesByTripKey?.get(key)?.length
	)
		return update;
	const event = update.stop_time_updates
		.flatMap((stop) => [stop.departure_time, stop.arrival_time])
		.find((time) => time != null && Number.isFinite(Number(time)));
	const observed = event ?? update.timestamp;
	if (observed == null || !Number.isFinite(Number(observed))) return update;
	const zone = getFeedTimeZone(ctx.config, update.feed_id);
	const day = getServiceDate(new Date(Number(observed) * 1000), zone);
	const candidates: string[] = [];
	const lookback = Math.min(7, Math.max(0, Math.ceil(bounds.end_time / 86400)));
	const epochDay = getEpochDayFromServiceDate(day);
	const operating = new Set(
		getServiceDatesByTrip(
			{ feedId: update.feed_id, localId: update.trip.trip_id },
			ctx,
			epochDay - lookback,
			epochDay + 1,
		),
	);
	for (let offset = -lookback; offset <= 1; offset++) {
		const date = addDaysToServiceDate(day, offset);
		if (!operating.has(date)) continue;
		const start = getServiceDayStart(date, zone);
		if (Number(observed) >= start + bounds.start_time - 1800 && Number(observed) <= start + bounds.end_time + 1800)
			candidates.push(date);
	}
	if (candidates.length !== 1) return update;
	return {
		...update,
		trip: { ...update.trip, start_date: candidates[0] },
		stop_time_updates: update.stop_time_updates.map((stop) => ({ ...stop, start_date: candidates[0] })),
	};
}

function tripServiceKey(update: RealtimeTripUpdate, ctx: CacheContext): string {
	const key = update.feed_id && update.trip.trip_id
		? entityKey({ feedId: update.feed_id, localId: update.trip.trip_id })
		: null;
	const frequency = key !== null && (ctx.raw.frequenciesByTripKey.get(key)?.length ?? 0) > 0;
	const relationship = update.trip.schedule_relationship;
	const additionalInstance =
		relationship === TripScheduleRelationship.ADDED ||
		relationship === TripScheduleRelationship.NEW ||
		relationship === TripScheduleRelationship.UNSCHEDULED ||
		relationship === TripScheduleRelationship.DUPLICATED;
	// A static nonfrequency trip has one instance per service date. Its optional
	// start_time describes that instance rather than creating another one.
	return [
		update.feed_id,
		update.trip.trip_id,
		update.trip.start_date ?? "",
		frequency || additionalInstance ? normalizeClock(update.trip.start_time) : "",
	].join("\0");
}

/** Replace one supplemental producer's snapshot without disturbing other plugins. */
export function replaceInjectedTripUpdates(
	ctx: CacheContext,
	sourceId: string,
	updates: readonly RealtimeTripUpdate[],
): void {
	if (updates.some((update) => update.source_id !== sourceId)) {
		throw new Error(`Injected trip updates for '${sourceId}' contain a different source_id`);
	}
	ctx.raw.injectedTripUpdates = [
		...(ctx.raw.injectedTripUpdates ?? []).filter((update) => update.source_id !== sourceId),
		...updates,
	];
}

/** Replace one supplemental producer's vehicle snapshot without disturbing other plugins. */
export function replaceInjectedVehiclePositions(
	ctx: CacheContext,
	sourceId: string,
	positions: readonly RealtimeVehiclePosition[],
): void {
	if (positions.some((position) => position.source_id !== sourceId)) {
		throw new Error(`Injected vehicle positions for '${sourceId}' contain a different source_id`);
	}
	ctx.raw.injectedVehiclePositions = [
		...(ctx.raw.injectedVehiclePositions ?? []).filter((position) => position.source_id !== sourceId),
		...positions,
	];
}

/** Deleted trips are hidden; a replacement owns the matching scheduled instance. */
export function applyRealtimeReplacementPrecedence(
	updates: readonly RealtimeTripUpdate[],
	ctx: CacheContext,
): RealtimeTripUpdate[] {
	const deletedKeys = new Set(
		updates
			.filter((update) => update.trip.schedule_relationship === TripScheduleRelationship.DELETED)
			.map((update) => tripServiceKey(update, ctx)),
	);
	const replacementKeys = new Set(
		updates
			.filter((update) => update.trip.schedule_relationship === TripScheduleRelationship.REPLACEMENT)
			.map((update) => tripServiceKey(update, ctx)),
	);
	return updates.filter((update) => {
		if (update.trip.schedule_relationship === TripScheduleRelationship.DELETED) return true;
		const key = tripServiceKey(update, ctx);
		if (deletedKeys.has(key)) return false;
		return update.trip.schedule_relationship === TripScheduleRelationship.REPLACEMENT || !replacementKeys.has(key);
	});
}

/** Transit supplies missing calls inside the authoritative dated instance. */
export function mergeSupplementalTripUpdates(
	updates: readonly RealtimeTripUpdate[],
	ctx: CacheContext,
): RealtimeTripUpdate[] {
	const result = updates.filter((update) => update.source_id !== "transit-app");
	const instanceKey = (update: RealtimeTripUpdate) => {
		const key = entityKey({ feedId: update.feed_id, localId: update.trip.trip_id });
		const frequency = (ctx.raw.frequenciesByTripKey?.get(key)?.length ?? 0) > 0;
		return JSON.stringify([key, update.trip.start_date, frequency ? normalizeClock(update.trip.start_time) : ""]);
	};
	const byInstance = new Map<string, Array<{ update: RealtimeTripUpdate; index: number }>>();
	result.forEach((update, index) => {
		const key = instanceKey(update);
		const group = byInstance.get(key) ?? [];
		group.push({ update, index });
		byInstance.set(key, group);
	});
	for (const supplemental of updates.filter((update) => update.source_id === "transit-app")) {
		const matches = byInstance.get(instanceKey(supplemental)) ?? [];
		if (matches.some(({ update }) => update.trip.schedule_relationship !== TripScheduleRelationship.SCHEDULED))
			continue;
		if (matches.length === 0) {
			result.push(supplemental);
			continue;
		}
		const selected = matches.reduce((best, candidate) => {
			const time = candidate.update.timestamp ?? 0;
			const previous = best.update.timestamp ?? 0;
			if (time !== previous) return time > previous ? candidate : best;
			if (candidate.update.update_id !== best.update.update_id)
				return candidate.update.update_id < best.update.update_id ? candidate : best;
			return JSON.stringify(candidate.update) < JSON.stringify(best.update) ? candidate : best;
		});
		const agency = selected.update;
		const fresh = agency.timestamp == null || agency.timestamp * 1000 + 180000 > Date.now();
		const tripKey = entityKey({ feedId: agency.feed_id, localId: agency.trip.trip_id });
		const stopTimes =
			ctx.augmented.rawStopTimesCache.get(tripKey) ??
			ctx.gtfs?.getStopTimes({ feed_id: agency.feed_id, trip_id: agency.trip.trip_id }) ??
			[];
		const stopKey = (stop: RealtimeStopTimeUpdate) => {
			if (stop.stop_sequence != null) return `sequence:${stop.stop_sequence}`;
			const calls = stopTimes.filter((call) => {
				const parent = ctx.raw.stopsByKey.get(
					entityKey({ feedId: agency.feed_id, localId: call.stop_id }),
				)?.parent_station;
				return call.stop_id === stop.stop_id || parent === stop.stop_id;
			});
			return calls.length === 1 ? `sequence:${calls[0].stop_sequence}` : `stop:${stop.stop_id}`;
		};
		const supplements = new Map(
			supplemental.stop_time_updates.map((stop) => [
				stopKey(stop),
				{
					...stop,
					observation_timestamp: supplemental.timestamp,
				},
			]),
		);
		const merged = agency.stop_time_updates.map((stop) => {
			const key = stopKey(stop);
			const fill = supplements.get(key);
			if (!fill) return stop;
			supplements.delete(key);
			if (!fresh) return fill;
			// The agency keeps the stop identity, arrival event, and all untimed
			// fields. Fill only an absent departure prediction.
			if (
				stop.schedule_relationship !== StopTimeScheduleRelationship.SCHEDULED ||
				stop.departure_time != null ||
				stop.departure_delay != null
			)
				return stop;
			return {
				...stop,
				departure_time: fill.departure_time,
				departure_delay: fill.departure_delay,
				departure_observation: { source_id: fill.source_id, timestamp: supplemental.timestamp },
			};
		});
		result[selected.index] = {
			...agency,
			stop_time_updates: merged
				.concat([...supplements.values()])
				.sort(
					(left, right) =>
						(left.stop_sequence ?? Number.MAX_SAFE_INTEGER) -
						(right.stop_sequence ?? Number.MAX_SAFE_INTEGER),
				),
		};
	}
	return result;
}

function normalizeClock(value: string | null | undefined): string {
	const match = /^(\d+):(\d{2})(?::(\d{2}))?$/.exec(value?.trim() ?? "");
	return match ? `${match[1].padStart(2, "0")}:${match[2]}:${match[3] ?? "00"}` : (value?.trim() ?? "");
}

function canonicalTripInfo(trip: RealtimeUpdateTripInfo, ctx: CacheContext): RealtimeUpdateTripInfo {
	let tripId = trip.trip_id;
	for (const plugin of ctx.config.network.plugins) {
		if (!plugin.feedIds.includes(trip.feed_id) || !plugin.canonicalRealtimeTripId) continue;
		tripId = plugin.canonicalRealtimeTripId({ ...trip, trip_id: tripId }, ctx) ?? tripId;
	}
	return tripId === trip.trip_id ? trip : { ...trip, trip_id: tripId };
}

export function canonicalizeRealtimeTripUpdate(update: RealtimeTripUpdate, ctx: CacheContext): RealtimeTripUpdate {
	let enriched = update;
	for (const plugin of ctx.config.network.plugins) {
		if (!plugin.feedIds.includes(enriched.feed_id) || !plugin.enrichRealtimeTripUpdate) continue;
		enriched = plugin.enrichRealtimeTripUpdate(enriched, ctx) ?? enriched;
	}
	const trip = canonicalTripInfo(enriched.trip, ctx);
	if (trip === enriched.trip) return inferScheduledServiceDate(enriched, ctx);
	const stopTimeUpdates = enriched.stop_time_updates.map((stopTime): RealtimeStopTimeUpdate => ({
		...stopTime,
		trip_id: trip.trip_id,
	}));
	return inferScheduledServiceDate({ ...enriched, trip, stop_time_updates: stopTimeUpdates }, ctx);
}

export function canonicalizeRealtimeVehiclePosition(
	position: RealtimeVehiclePosition,
	ctx: CacheContext,
): RealtimeVehiclePosition {
	const trip = canonicalTripInfo(position.trip, ctx);
	return trip === position.trip ? position : { ...position, trip };
}

export function canonicalizeRealtimeTripUpdates(
	updates: readonly RealtimeTripUpdate[],
	ctx: CacheContext,
): RealtimeTripUpdate[] {
	return updates.map((update) => canonicalizeRealtimeTripUpdate(update, ctx));
}

export function canonicalizeRealtimeVehiclePositions(
	positions: readonly RealtimeVehiclePosition[],
	ctx: CacheContext,
): RealtimeVehiclePosition[] {
	return positions.map((position) => canonicalizeRealtimeVehiclePosition(position, ctx));
}
