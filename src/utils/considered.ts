import * as qdf from "qdf-gtfs";
import { AugmentedStop } from "./augmentedStop.js";

let routeCache: Map<string, boolean> = new Map();
let stopCache: Map<string, boolean> = new Map();
let tripIdCache: Map<string, boolean> = new Map();

export function clearConsideredCaches(): void {
	routeCache.clear();
	stopCache.clear();
	tripIdCache.clear();
}

function isRailLikeRouteType(routeType: number | null | undefined): boolean {
	if (routeType === null || routeType === undefined) return false;
	if (routeType === qdf.RouteType.Rail || routeType === qdf.RouteType.Subway) return true;
	// GTFS extended route types
	if (routeType >= 100 && routeType < 200) return true; // Railway Service
	if (routeType >= 400 && routeType < 500) return true; // Metro Service
	return false;
}

export function isConsideredRoute(route: qdf.Route): boolean {
	if (routeCache.has(route.route_id)) return routeCache.get(route.route_id)!;
	const valid = isRailLikeRouteType(route.route_type);
	routeCache.set(route.route_id, valid);
	return valid;
}

export function isConsideredTrip(trip: qdf.Trip, gtfs: qdf.GTFS): boolean {
	if (routeCache.has(trip.route_id)) return routeCache.get(trip.route_id)!;
	return isConsideredRoute(gtfs.getRoutes({ route_id: trip.route_id })[0]!);
}

export function isConsideredTripId(trip_id: string, gtfs: qdf.GTFS): boolean {
	if (tripIdCache.has(trip_id)) return tripIdCache.get(trip_id)!;
	const route_id = gtfs.getTrips({ trip_id })[0]?.route_id;
	if (!route_id) {
		tripIdCache.set(trip_id, false);
		return false;
	}
	if (routeCache.has(route_id)) {
		const valid = routeCache.get(route_id)!;
		tripIdCache.set(trip_id, valid);
		return valid;
	}
	const valid = isConsideredRoute(gtfs.getRoutes({ route_id })[0]!);
	tripIdCache.set(trip_id, valid);
	return valid;
}

export function isConsideredStop(stop: AugmentedStop | qdf.Stop, gtfs: qdf.GTFS): boolean {
	if (stopCache.has(stop.stop_id)) return stopCache.get(stop.stop_id)!;
	let children =
		(stop as AugmentedStop).child_stop_ids ??
		gtfs
			.getStops()
			.filter((s) => s.parent_station === stop.stop_id)
			.map((s) => s.stop_id);
	const valid =
		gtfs
			.getStopTimes({
				stop_id: stop.stop_id,
			})
			.some((st: qdf.StopTime) => isConsideredTripId(st.trip_id, gtfs)) ||
		children.some((child) => isConsideredStopId(child, gtfs));
	stopCache.set(stop.stop_id, valid);
	return valid;
}

export function isConsideredStopId(stop_id: string, gtfs: qdf.GTFS): boolean {
	if (stopCache.has(stop_id)) return stopCache.get(stop_id)!;
	const stop = gtfs.getStops({ stop_id })[0];
	return stop ? isConsideredStop(stop, gtfs) : false;
}
