import type {
	Calendar,
	CalendarDate,
	RealtimeTripUpdate,
	RealtimeVehiclePosition,
	RealtimeStopTimeUpdate,
	Route,
	Stop,
	StopTime,
	Trip,
	QualifiedEntityId,
} from "qdf-gtfs";
import { isConsideredTrip } from "../utils/considered.js";
import type { CacheContext } from "./types.js";
import * as qdf from "qdf-gtfs";
import { entityKey } from "../identity.js";
import {
	applyRealtimeReplacementPrecedence,
	canonicalizeRealtimeTripUpdates,
	canonicalizeRealtimeVehiclePositions,
} from "./realtime.js";

export function getCalendars(ctx: CacheContext, filter?: Partial<Calendar>): Calendar[] {
	return requireGtfs(ctx).getCalendars(filter);
}

function requireGtfs(ctx: CacheContext) {
	if (!ctx.gtfs) throw new Error("GTFS is not initialized for this network runtime");
	return ctx.gtfs;
}

export function getCalendarDates(ctx: CacheContext, filter?: Partial<CalendarDate>): CalendarDate[] {
	return requireGtfs(ctx).getCalendarDates(filter);
}

export function getTrips(ctx: CacheContext, filter?: Partial<Trip>): Trip[] {
	const gtfs = requireGtfs(ctx);
	return gtfs.getTrips(filter).filter((v: Trip) => isConsideredTrip(v, ctx));
}

export function getStops(ctx: CacheContext, filter?: Partial<Stop>): Stop[] {
	return requireGtfs(ctx).getStops(filter);
}

export function getRoutes(ctx: CacheContext, filter?: Partial<Route>): Route[] {
	return requireGtfs(ctx).getRoutes(filter);
}

export function getTripUpdates(ctx: CacheContext, trip?: QualifiedEntityId): RealtimeTripUpdate[] {
	if (trip) {
		const key = entityKey(trip);
		const cached = ctx.augmented.tripUpdatesCache.get(key);
		if (cached) return cached;
	}

	const gtfs = requireGtfs(ctx);
	const updates = gtfs.getRealtimeTripUpdates();
	const injected = ctx.raw.injectedTripUpdates ?? [];
	const allUpdates = applyRealtimeReplacementPrecedence(
		canonicalizeRealtimeTripUpdates(updates.concat(injected), ctx),
	);

	if (trip) {
		const result = allUpdates.filter(
			(v: RealtimeTripUpdate) => v.feed_id === trip.feedId && v.trip.trip_id === trip.localId,
		);
		ctx.augmented.tripUpdatesCache.set(entityKey(trip), result);
		return result;
	}
	return allUpdates;
}

export function getVehiclePositions(ctx: CacheContext, trip?: QualifiedEntityId): RealtimeVehiclePosition[] {
	const gtfs = requireGtfs(ctx);
	const positions = gtfs.getRealtimeVehiclePositions();
	const injected = ctx.raw.injectedVehiclePositions ?? [];
	const allPositions = canonicalizeRealtimeVehiclePositions(positions.concat(injected), ctx).map((position) => {
		let enriched = position;
		for (const plugin of ctx.config.network.plugins) {
			if (!plugin.feedIds.includes(enriched.feed_id) || !plugin.enrichVehiclePosition) continue;
			enriched = plugin.enrichVehiclePosition(enriched, ctx) ?? enriched;
		}
		return enriched;
	});
	if (trip)
		return allPositions.filter(
			(v: RealtimeVehiclePosition) => v.feed_id === trip.feedId && v.trip.trip_id === trip.localId,
		);
	return allPositions;
}

export function getStopTimeUpdates(ctx: CacheContext, trip: QualifiedEntityId): RealtimeStopTimeUpdate[] {
	const updates = getTripUpdates(ctx, trip);
	if (!updates.length) return [];

	const updateStopTimes = new Map<number, RealtimeStopTimeUpdate>();
	const updateStopIds = new Map<string, RealtimeStopTimeUpdate>();
	const updatePriority = new Map<string, number>();
	for (let index = 0; index < updates.length; index += 1) {
		const update = updates[index];
		const timestamp = update.timestamp ?? 0;
		const priority = timestamp + index * 1e-6;
		for (const stu of update.stop_time_updates ?? []) {
			const seq = stu.stop_sequence;
			if (seq !== null && seq !== undefined) {
				const key = `seq:${seq}`;
				const prevPriority = updatePriority.get(key) ?? -Infinity;
				if (priority >= prevPriority) {
					updateStopTimes.set(seq, stu);
					updatePriority.set(key, priority);
				}
				continue;
			}
			const stopId = stu.stop_id;
			if (stopId) {
				const key = `stop:${stopId}`;
				const prevPriority = updatePriority.get(key) ?? -Infinity;
				if (priority >= prevPriority) {
					updateStopIds.set(stopId, stu);
					updatePriority.set(key, priority);
				}
			}
		}
	}

	return [...updateStopTimes.values(), ...updateStopIds.values()];
}

export function getStopTimes(ctx: CacheContext, query: qdf.StopTimeQuery): StopTime[] {
	return requireGtfs(ctx).getStopTimes(query);
}

export function getRawStopTimes(ctx: CacheContext, trip: QualifiedEntityId): StopTime[] {
	const key = entityKey(trip);
	const cached = ctx.augmented.rawStopTimesCache.get(key);
	if (cached) return cached;

	const result = getStopTimes(ctx, { feed_id: trip.feedId, trip_id: trip.localId });
	ctx.augmented.rawStopTimesCache.set(key, result);
	return result;
}

export const getRawTrips = getTrips;
export const getRawStops = getStops;
export const getRawRoutes = getRoutes;
export const getRawCalendars = getCalendars;
export const getRawCalendarDates = getCalendarDates;
