import type { Stop, StopTime, Trip } from "qdf-gtfs";
import type { CacheContext } from "../../cache/types.js";
import { getRawStopTimes } from "../../cache/gtfsReads.js";
import { canonicalStationIdentity } from "../../config.js";
import { entityKey, parseEntityKey } from "../../identity.js";
import { getServiceDatesByService } from "../calendar.js";
import { qualifiedRouteDirectionKey } from "./keys.js";
import type { JourneyContext, RoutePattern } from "./types.js";

function finite(value: number | null | undefined): number | null {
	return value != null && Number.isFinite(value) ? value : null;
}

function stationKey(ctx: CacheContext, stop: Pick<Stop, "feed_id" | "stop_id" | "parent_station">): string {
	return entityKey(
		canonicalStationIdentity(ctx.config, {
			feedId: stop.feed_id,
			localId: stop.parent_station || stop.stop_id,
		}),
	);
}

function getStop(ctx: CacheContext, feedId: string, stopId: string): Stop | undefined {
	return (
		ctx.raw.stopsByKey.get(entityKey({ feedId, localId: stopId })) ??
		ctx.gtfs?.getStops({ feed_id: feedId, stop_id: stopId })[0]
	);
}

function edgeMetrics(stopTimes: readonly StopTime[]): { minutes: number[]; distances: number[] } {
	const minutes: number[] = [];
	const distances: number[] = [];
	for (let index = 1; index < stopTimes.length; index++) {
		const previous = stopTimes[index - 1];
		const current = stopTimes[index];
		const start = finite(previous.departure_time) ?? finite(previous.arrival_time);
		const end = finite(current.arrival_time) ?? finite(current.departure_time);
		minutes.push(start != null && end != null && end > start ? (end - start) / 60 : 0);
		const previousDistance = finite(previous.shape_dist_traveled);
		const currentDistance = finite(current.shape_dist_traveled);
		distances.push(
			previousDistance != null && currentDistance != null && currentDistance > previousDistance
				? currentDistance - previousDistance
				: 0,
		);
	}
	return { minutes, distances };
}

/** Build feed-qualified stopping patterns from the considered static trips. */
export function buildPatternIndex(
	ctx: CacheContext,
	trips: readonly Trip[],
): {
	patterns: RoutePattern[];
	byRouteDirection: Map<string, RoutePattern[]>;
} {
	const patterns: RoutePattern[] = [];
	const byRouteDirection = new Map<string, RoutePattern[]>();
	const bySignature = new Map<string, RoutePattern>();
	for (const trip of trips) {
		const stopTimes = [...getRawStopTimes(ctx, { feedId: trip.feed_id, localId: trip.trip_id })].sort(
			(a, b) => a.stop_sequence - b.stop_sequence,
		);
		if (stopTimes.length < 2) continue;
		const stations = stopTimes.map((stopTime) => {
			const stop = getStop(ctx, stopTime.feed_id, stopTime.stop_id);
			return stationKey(
				ctx,
				stop ?? { feed_id: stopTime.feed_id, stop_id: stopTime.stop_id, parent_station: null },
			);
		});
		const metrics = edgeMetrics(stopTimes);
		const routeDirectionKey = qualifiedRouteDirectionKey(trip.feed_id, trip.route_id, trip.direction_id);
		const signature = JSON.stringify([
			routeDirectionKey,
			trip.service_id,
			trip.shape_id,
			stations,
		]);
		const tripId = entityKey({ feedId: trip.feed_id, localId: trip.trip_id });
		const existing = bySignature.get(signature);
		if (existing) {
			existing.tripIds.push(tripId);
			continue;
		}
		const pattern: RoutePattern = {
			feedId: trip.feed_id,
			routeId: trip.route_id,
			direction: trip.direction_id,
			serviceId: trip.service_id,
			shapeId: trip.shape_id,
			stations,
			tripIds: [tripId],
			edgeMinutes: metrics.minutes,
			edgeDistances: metrics.distances,
		};
		bySignature.set(signature, pattern);
		patterns.push(pattern);
		const group = byRouteDirection.get(routeDirectionKey) ?? [];
		group.push(pattern);
		byRouteDirection.set(routeDirectionKey, group);
	}
	return { patterns, byRouteDirection };
}

/** Return patterns that operate on the requested service date. */
export function getActivePatterns(
	patterns: readonly RoutePattern[],
	journey: JourneyContext,
	ctx: CacheContext,
): RoutePattern[] {
	return patterns.filter((pattern) => {
		if (pattern.feedId !== journey.feedId) return false;
		// A route-less JourneyContext is used only by the compatibility
		// findExpress() helper. It still requires consensus below, but it may
		// examine all patterns in this feed because no route scope was supplied.
		if (journey.routeId !== null && pattern.routeId !== journey.routeId) return false;
		if (journey.direction !== null && String(pattern.direction ?? "*") !== String(journey.direction)) return false;
		if (!journey.serviceDate || !ctx.gtfs) return true;
		return getServiceDatesByService(
			{ feedId: pattern.feedId, localId: pattern.serviceId },
			ctx,
			pattern.tripIds[0] ? parseEntityKey(pattern.tripIds[0]) : undefined,
		).includes(journey.serviceDate!);
	});
}

export interface PatternGapPath {
	stations: string[];
	minutes: number[];
	distances: number[];
	pattern: RoutePattern;
}

/** Find every ordered pattern path between two station anchors. */
export function findPatternGapPaths(
	patterns: readonly RoutePattern[],
	fromStationId: string,
	toStationId: string,
): PatternGapPath[] {
	const results: PatternGapPath[] = [];
	for (const pattern of patterns) {
		for (let fromIndex = 0; fromIndex < pattern.stations.length; fromIndex++) {
			if (pattern.stations[fromIndex] !== fromStationId) continue;
			for (let toIndex = fromIndex + 1; toIndex < pattern.stations.length; toIndex++) {
				if (pattern.stations[toIndex] !== toStationId) continue;
				results.push({
					stations: pattern.stations.slice(fromIndex, toIndex + 1),
					minutes: pattern.edgeMinutes?.slice(fromIndex, toIndex) ?? [],
					distances: pattern.edgeDistances?.slice(fromIndex, toIndex) ?? [],
					pattern,
				});
			}
		}
	}
	return results;
}
