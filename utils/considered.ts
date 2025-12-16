import * as qdf from "qdf-gtfs";
import { getGtfs } from "../gtfsInterfaceLayer.js";

let routeCache: Map<string, boolean> = new Map();

export function isConsideredRoute(route: qdf.Route): boolean {
	if (routeCache.has(route.route_id)) return routeCache.get(route.route_id)!;
	const valid = route.route_type === qdf.RouteType.Rail || route.route_type === qdf.RouteType.Subway;
	routeCache.set(route.route_id, valid);
	return valid;
}

export function isConsideredTrip(trip: qdf.Trip): boolean {
	if (routeCache.has(trip.route_id)) return routeCache.get(trip.route_id)!;
	return isConsideredRoute(getGtfs().getRoute(trip.route_id)!);
}
