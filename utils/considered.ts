import * as qdf from "qdf-gtfs";
import { getGtfs } from "../gtfsInterfaceLayer.js";
import { AugmentedStop } from "./augmentedStop.js";

let routeCache: Map<string, boolean> = new Map();
let stopCache: Map<string, boolean> = new Map();

export function isConsideredRoute(route: qdf.Route): boolean {
	if (routeCache.has(route.route_id)) return routeCache.get(route.route_id)!;
	const valid = route.route_type === qdf.RouteType.Rail || route.route_type === qdf.RouteType.Subway;
	routeCache.set(route.route_id, valid);
	return valid;
}

export function isConsideredTrip(trip: qdf.Trip, gtfs?: qdf.GTFS): boolean {
	if (routeCache.has(trip.route_id)) return routeCache.get(trip.route_id)!;
	return isConsideredRoute((gtfs ?? getGtfs()).getRoutes({ route_id: trip.route_id })[0]!);
}

export function isConsideredTripId(trip_id: string, gtfs?: qdf.GTFS): boolean {
	const route_id = (gtfs ?? getGtfs()).getTrips({ trip_id })[0]?.route_id;
	if (!route_id) return false;
	if (routeCache.has(route_id)) return routeCache.get(route_id)!;
	return isConsideredRoute((gtfs ?? getGtfs()).getRoutes({ route_id })[0]!);
}

export function isConsideredStop(stop: AugmentedStop | qdf.Stop, gtfs?: qdf.GTFS): boolean {
	if (stopCache.has(stop.stop_id)) return stopCache.get(stop.stop_id)!;
	if (!gtfs) gtfs = getGtfs();
	let children = (stop as AugmentedStop).child_stop_ids ?? gtfs.getStops().filter(s => s.parent_station === stop.stop_id).map(s => s.stop_id);
	const valid = gtfs.getStopTimes({
		stop_id: stop.stop_id
	}).some((st: qdf.StopTime) => isConsideredTripId(st.trip_id, gtfs)) || children.some(child => isConsideredStopId(child, gtfs));
	stopCache.set(stop.stop_id, valid);
	return valid;
}

export function isConsideredStopId(stop_id: string, gtfs?: qdf.GTFS): boolean {
	if (stopCache.has(stop_id)) return stopCache.get(stop_id)!;
	const stop = (gtfs ?? getGtfs()).getStops({ stop_id })[0];
	return stop ? isConsideredStop(stop, gtfs) : false;
}
