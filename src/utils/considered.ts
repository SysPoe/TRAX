import * as qdf from "qdf-gtfs";
import type { AugmentedStop } from "./augmentedStop.js";
import type { CacheContext } from "../cache/types.js";
import { entityKey } from "../identity.js";
import { pluginSupportsFeed } from "../plugins/types.js";

export function clearConsideredCaches(ctx: CacheContext): void {
	ctx.runtimeState.consideredRoutes.clear();
	ctx.runtimeState.consideredStops.clear();
	ctx.runtimeState.consideredTrips.clear();
}

export function isRailLikeRouteType(routeType: number | null | undefined): boolean {
	if (routeType === null || routeType === undefined) return false;
	if (routeType === qdf.RouteType.Rail || routeType === qdf.RouteType.Subway) return true;
	return (routeType >= 100 && routeType < 200) || (routeType >= 400 && routeType < 500);
}

export function isConsideredRoute(route: qdf.Route, ctx: CacheContext): boolean {
	const key = entityKey({ feedId: route.feed_id, localId: route.route_id });
	const cached = ctx.runtimeState.consideredRoutes.get(key);
	if (cached !== undefined) return cached;
	const valid =
		isRailLikeRouteType(route.route_type) &&
		ctx.config.network.plugins.every(
			(plugin) => !pluginSupportsFeed(plugin, route.feed_id) || plugin.considerRoute?.(route, ctx) !== false,
		);
	ctx.runtimeState.consideredRoutes.set(key, valid);
	return valid;
}

export function isNonRevenueRoute(route: qdf.Route, ctx: CacheContext): boolean {
	return ctx.config.network.plugins.some(
		(plugin) => pluginSupportsFeed(plugin, route.feed_id) && plugin.isNonRevenueRoute?.(route, ctx) === true,
	);
}

/** A call with neither passenger boarding nor alighting is a pass-through call. */
export function isNonBoardingStopTime(
	stopTime: Pick<qdf.StopTime, "pickup_type" | "drop_off_type">,
): boolean {
	return stopTime.pickup_type === qdf.PickupType.None && stopTime.drop_off_type === qdf.DropOffType.None;
}

export function isPassingStopTime(
	stopTime: Pick<qdf.StopTime, "pickup_type" | "drop_off_type">,
	topologyPassing = false,
): boolean {
	return topologyPassing || isNonBoardingStopTime(stopTime);
}

/** A trip with no passenger boarding or alighting at any call is a non-revenue movement. */
export function isNonRevenueTrip(
	route: qdf.Route | null | undefined,
	stopTimes: Pick<qdf.StopTime, "pickup_type" | "drop_off_type">[],
	ctx: CacheContext,
): boolean {
	return (
		(route ? isNonRevenueRoute(route, ctx) : false) ||
		(stopTimes.length > 0 && stopTimes.every(isNonBoardingStopTime))
	);
}

export function isConsideredTrip(trip: qdf.Trip, ctx: CacheContext): boolean {
	const route = ctx.gtfs?.getRoutes({ feed_id: trip.feed_id, route_id: trip.route_id })[0];
	return route ? isConsideredRoute(route, ctx) : false;
}

export function isConsideredTripId(trip: qdf.QualifiedEntityId, ctx: CacheContext): boolean {
	const key = entityKey(trip);
	const cached = ctx.runtimeState.consideredTrips.get(key);
	if (cached !== undefined) return cached;
	const rawTrip = ctx.gtfs?.getTrips({ feed_id: trip.feedId, trip_id: trip.localId })[0];
	const valid = rawTrip ? isConsideredTrip(rawTrip, ctx) : false;
	ctx.runtimeState.consideredTrips.set(key, valid);
	return valid;
}

export function isConsideredStop(stop: AugmentedStop | qdf.Stop, ctx: CacheContext): boolean {
	const ref = { feedId: stop.feed_id, localId: stop.stop_id };
	const key = entityKey(ref);
	const cached = ctx.runtimeState.consideredStops.get(key);
	if (cached !== undefined) return cached;
	const gtfs = ctx.gtfs;
	if (!gtfs) return false;
	const children =
		(stop as AugmentedStop).child_stop_ids ??
		gtfs.getStops({ feed_id: stop.feed_id }).filter((candidate) => candidate.parent_station === stop.stop_id).map((candidate) => candidate.stop_id);
	const valid =
		gtfs.getStopTimes({ feed_id: stop.feed_id, stop_id: stop.stop_id }).some((stopTime) =>
			isConsideredTripId({ feedId: stopTime.feed_id, localId: stopTime.trip_id }, ctx),
		) || children.some((child) => isConsideredStopId({ feedId: stop.feed_id, localId: child }, ctx));
	ctx.runtimeState.consideredStops.set(key, valid);
	return valid;
}

export function isConsideredStopId(stop: qdf.QualifiedEntityId, ctx: CacheContext): boolean {
	const key = entityKey(stop);
	const cached = ctx.runtimeState.consideredStops.get(key);
	if (cached !== undefined) return cached;
	const rawStop = ctx.gtfs?.getStops({ feed_id: stop.feedId, stop_id: stop.localId })[0];
	return rawStop ? isConsideredStop(rawStop, ctx) : false;
}
