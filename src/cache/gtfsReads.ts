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
	if (!filter && ctx.raw.consideredTrips) return ctx.raw.consideredTrips;
	if (ctx.raw.tripsByKey.size > 0 && filter?.feed_id && filter.trip_id) {
		const trip = ctx.raw.tripsByKey.get(entityKey({ feedId: filter.feed_id, localId: filter.trip_id }));
		return trip && isConsideredTrip(trip, ctx) ? [trip] : [];
	}
	return gtfs.getTrips(filter).filter((v: Trip) => isConsideredTrip(v, ctx));
}

export function getStops(ctx: CacheContext, filter?: Partial<Stop>): Stop[] {
	const gtfs = requireGtfs(ctx);
	if (ctx.raw.stopsByKey.size > 0 && filter?.feed_id && filter.stop_id) {
		const stop = ctx.raw.stopsByKey.get(entityKey({ feedId: filter.feed_id, localId: filter.stop_id }));
		return stop ? [stop] : [];
	}
	if (ctx.raw.stopsByKey.size > 0 && filter?.feed_id && !filter.stop_id)
		return ctx.raw.stopsByFeed.get(filter.feed_id) ?? gtfs.getStops(filter);
	return gtfs.getStops(filter);
}

export function getRoutes(ctx: CacheContext, filter?: Partial<Route>): Route[] {
	const gtfs = requireGtfs(ctx);
	if (ctx.raw.routesByKey.size > 0 && filter?.feed_id && filter.route_id) {
		const route = ctx.raw.routesByKey.get(entityKey({ feedId: filter.feed_id, localId: filter.route_id }));
		return route ? [route] : [];
	}
	return gtfs.getRoutes(filter);
}

export function getRawRoute(ctx: CacheContext, route: QualifiedEntityId): Route | undefined {
	const cached = ctx.raw.routesByKey.get(entityKey(route));
	if (cached) return cached;
	const result = getRoutes(ctx, { feed_id: route.feedId, route_id: route.localId })[0];
	if (result) ctx.raw.routesByKey.set(entityKey(route), result);
	return result;
}

export function getRawTrip(ctx: CacheContext, trip: QualifiedEntityId): Trip | undefined {
	const cached = ctx.raw.tripsByKey.get(entityKey(trip));
	if (cached) return cached;
	const result = getTrips(ctx, { feed_id: trip.feedId, trip_id: trip.localId })[0];
	if (result) ctx.raw.tripsByKey.set(entityKey(trip), result);
	return result;
}

export function getRawStop(ctx: CacheContext, stop: QualifiedEntityId): Stop | undefined {
	const cached = ctx.raw.stopsByKey.get(entityKey(stop));
	if (cached) return cached;
	const result = getStops(ctx, { feed_id: stop.feedId, stop_id: stop.localId })[0];
	if (result) ctx.raw.stopsByKey.set(entityKey(stop), result);
	return result;
}

/** Load all requested trip stop-times with one indexed native query per feed. */
export function primeRawStopTimes(ctx: CacheContext, trips: readonly Trip[]): void {
	if (trips.length === 0) return;
	const gtfs = requireGtfs(ctx);
	const tripIdsByFeed = new Map<string, Set<string>>();
	for (const trip of trips) {
		const key = entityKey({ feedId: trip.feed_id, localId: trip.trip_id });
		if (!ctx.augmented.rawStopTimesCache.has(key)) ctx.augmented.rawStopTimesCache.set(key, []);
		let ids = tripIdsByFeed.get(trip.feed_id);
		if (!ids) {
			ids = new Set();
			tripIdsByFeed.set(trip.feed_id, ids);
		}
		ids.add(trip.trip_id);
	}

	for (const [feedId, tripIds] of tripIdsByFeed) {
		const stopTimesByTrip = new Map<string, StopTime[]>();
		for (const stopTime of gtfs.getStopTimes({ feed_id: feedId, trip_ids: [...tripIds] })) {
			const key = entityKey({ feedId: stopTime.feed_id, localId: stopTime.trip_id });
			const rows = stopTimesByTrip.get(key) ?? [];
			rows.push(stopTime);
			stopTimesByTrip.set(key, rows);
		}
		for (const tripId of tripIds) {
			const key = entityKey({ feedId, localId: tripId });
			ctx.augmented.rawStopTimesCache.set(key, stopTimesByTrip.get(key) ?? []);
		}
	}
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
export function getRawStops(ctx: CacheContext, filter?: Partial<Stop>): Stop[] {
	if (!filter) return ctx.raw.stopsByKey.size ? [...ctx.raw.stopsByKey.values()] : getStops(ctx);
	return getStops(ctx, filter);
}
export function getRawRoutes(ctx: CacheContext, filter?: Partial<Route>): Route[] {
	if (!filter && ctx.raw.routesByKey.size) return [...ctx.raw.routesByKey.values()];
	return getRoutes(ctx, filter);
}
export const getRawCalendars = getCalendars;
export const getRawCalendarDates = getCalendarDates;
