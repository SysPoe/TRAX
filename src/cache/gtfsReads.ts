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
} from "qdf-gtfs";
import { isConsideredTrip } from "../utils/considered.js";
import { getGtfs } from "../gtfsInterfaceLayer.js";
import type { CacheContext } from "./types.js";
import * as qdf from "qdf-gtfs";

export function getCalendars(ctx: CacheContext, filter?: Partial<Calendar>): Calendar[] {
	return (ctx.gtfs ?? getGtfs()).getCalendars(filter);
}

export function getCalendarDates(ctx: CacheContext, filter?: Partial<CalendarDate>): CalendarDate[] {
	return (ctx.gtfs ?? getGtfs()).getCalendarDates(filter);
}

export function getTrips(ctx: CacheContext, filter?: Partial<Trip> | string): Trip[] {
	const gtfs = ctx.gtfs ?? getGtfs();
	const query = typeof filter === "string" ? { trip_id: filter } : filter;
	return gtfs.getTrips(query).filter((v: Trip) => isConsideredTrip(v, gtfs));
}

export function getStops(ctx: CacheContext, filter?: Partial<Stop> | string): Stop[] {
	const query = typeof filter === "string" ? { stop_id: filter } : filter;
	return (ctx.gtfs ?? getGtfs()).getStops(query);
}

export function getRoutes(ctx: CacheContext, filter?: Partial<Route> | string): Route[] {
	const query = typeof filter === "string" ? { route_id: filter } : filter;
	return (ctx.gtfs ?? getGtfs()).getRoutes(query);
}

export function getTripUpdates(ctx: CacheContext, trip_id?: string): RealtimeTripUpdate[] {
	if (trip_id) {
		const cached = ctx.augmented.tripUpdatesCache.get(trip_id);
		if (cached) return cached;
	}

	const gtfs = ctx.gtfs ?? getGtfs();
	const updates = gtfs.getRealtimeTripUpdates();
	const injected = ctx.raw.injectedTripUpdates ?? [];
	const allUpdates = updates.concat(injected);

	if (trip_id) {
		const result = allUpdates.filter((v: RealtimeTripUpdate) => v.trip.trip_id == trip_id);
		ctx.augmented.tripUpdatesCache.set(trip_id, result);
		return result;
	}
	return allUpdates;
}

export function getVehiclePositions(ctx: CacheContext, trip_id?: string): RealtimeVehiclePosition[] {
	const gtfs = ctx.gtfs ?? getGtfs();
	const positions = gtfs.getRealtimeVehiclePositions();
	const injected = ctx.raw.injectedVehiclePositions ?? [];
	const allPositions = positions.concat(injected);
	if (trip_id) return allPositions.filter((v: RealtimeVehiclePosition) => v.trip.trip_id == trip_id);
	return allPositions;
}

export function getStopTimeUpdates(ctx: CacheContext, trip_id: string): RealtimeStopTimeUpdate[] {
	const updates = getTripUpdates(ctx, trip_id);
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
	return (ctx.gtfs ?? getGtfs()).getStopTimes(query);
}

export function getRawStopTimes(ctx: CacheContext, trip_id: string): StopTime[] {
	const cached = ctx.augmented.rawStopTimesCache.get(trip_id);
	if (cached) return cached;

	const result = getStopTimes(ctx, { trip_id });
	ctx.augmented.rawStopTimesCache.set(trip_id, result);
	return result;
}

// Aliases for backward compatibility
export const getRawTrips = getTrips;
export const getRawStops = getStops;
export const getRawRoutes = getRoutes;
export const getRawCalendars = getCalendars;
export const getRawCalendarDates = getCalendarDates;
