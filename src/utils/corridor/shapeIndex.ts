import type { Shape, Stop, StopTime, Trip } from "qdf-gtfs";
import type { CacheContext } from "../../cache/types.js";
import { getRawStopTimes } from "../../cache/gtfsReads.js";
import { canonicalStationIdentity } from "../../config.js";
import { entityKey } from "../../identity.js";
import { cumulativePolylineDistance } from "./geometry.js";
import { CoordinateGridIndex } from "./spatialIndex.js";
import { projectPointOnSegment } from "./projection.js";
import { qualifiedRouteDirectionKey } from "./keys.js";
import { buildPatternIndex } from "./patternIndex.js";
import type { RoutePattern, StationGeometry, StationProjection } from "./types.js";
import type { CorridorResolutionConfig } from "./types.js";

export interface IndexedShapePoint {
	lat: number;
	lon: number;
	sequence: number;
	geometricDistanceMeters: number;
	nativeShapeDistance: number | null;
}

export interface IndexedShape {
	key: string;
	feedId: string;
	shapeId: string;
	points: IndexedShapePoint[];
	lengthMeters: number;
	routeDirections: Set<string>;
	scheduledStations: Set<string>;
	tripIds: Set<string>;
	projections: Map<string, StationProjection[]>;
}

export interface CorridorIndex {
	stationGeometry: Map<string, StationGeometry>;
	shapes: Map<string, IndexedShape>;
	shapesByRouteDirection: Map<string, Set<string>>;
	patternsByRouteDirection: Map<string, RoutePattern[]>;
	patterns: RoutePattern[];
	version: string;
	/** False only for the empty placeholder created before static loading. */
	built: boolean;
}

function finite(value: number | null | undefined): number | null {
	return value != null && Number.isFinite(value) && value >= 0 ? value : null;
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

function getStationGeometry(
	stops: readonly Stop[],
	ctx: CacheContext,
	relevantStationIds?: ReadonlySet<string>,
): Map<string, StationGeometry> {
	const result = new Map<string, StationGeometry>();
	for (const stop of stops) {
		if (!Number.isFinite(stop.stop_lat) || !Number.isFinite(stop.stop_lon)) continue;
		const key = stationKey(ctx, stop);
		if (relevantStationIds && !relevantStationIds.has(key)) continue;
		const current = result.get(key) ?? { stationId: key, coordinates: [], names: [] };
		const source = stop.parent_station ? "platform" : "parent";
		if (!current.coordinates.some((coordinate) => coordinate.stopId === stop.stop_id)) {
			current.coordinates.push({
				lat: stop.stop_lat!,
				lon: stop.stop_lon!,
				source,
				stopId: stop.stop_id,
			});
		}
		if (stop.stop_name && !current.names.includes(stop.stop_name)) current.names.push(stop.stop_name);
		result.set(key, current);
	}
	return result;
}

function shapePoints(rows: Shape[]): IndexedShapePoint[] {
	const sorted = [...rows].sort((a, b) => a.shape_pt_sequence - b.shape_pt_sequence);
	const distances = cumulativePolylineDistance(
		sorted.map((row) => ({ lat: row.shape_pt_lat, lon: row.shape_pt_lon })),
	);
	return sorted.map((row, index) => ({
		lat: row.shape_pt_lat,
		lon: row.shape_pt_lon,
		sequence: row.shape_pt_sequence,
		geometricDistanceMeters: distances.cumulativeMeters[index],
		nativeShapeDistance: finite(row.shape_dist_traveled),
	}));
}

function appendProjection(
	projections: Map<string, StationProjection[]>,
	stationId: string,
	projection: StationProjection,
	maxProjections: number,
): void {
	const current = projections.get(stationId) ?? [];
	if (current.some((candidate) => Math.abs(candidate.distanceAlongMeters - projection.distanceAlongMeters) < 5)) {
		return;
	}
	current.push(projection);
	current.sort((a, b) => a.lateralDistanceMeters - b.lateralDistanceMeters);
	const retained = current.slice(0, Math.max(maxProjections, 1));
	retained.sort((a, b) => a.distanceAlongMeters - b.distanceAlongMeters);
	projections.set(stationId, retained);
}

function indexShapeProjections(
	shape: IndexedShape,
	stationGeometry: ReadonlyMap<string, StationGeometry>,
	config: CorridorResolutionConfig,
): void {
	const grid = new CoordinateGridIndex<string>(config.geometry.endpointSnapMaxMeters);
	for (const [stationId, geometry] of stationGeometry) {
		for (const coordinate of geometry.coordinates) {
			grid.add({
				id: `${stationId}\0${coordinate.stopId}`,
				lat: coordinate.lat,
				lon: coordinate.lon,
			});
		}
	}
	for (let index = 0; index < shape.points.length - 1; index++) {
		const from = shape.points[index];
		const to = shape.points[index + 1];
		const candidates = grid.querySegment(from, to, config.geometry.endpointSnapMaxMeters);
		const segmentLength = to.geometricDistanceMeters - from.geometricDistanceMeters;
		for (const candidate of candidates) {
			const stationId = candidate.id.slice(0, candidate.id.indexOf("\0"));
			const coordinateSource = stationGeometry
				.get(stationId)
				?.coordinates.find(
					(coordinate) => coordinate.stopId === candidate.id.slice(candidate.id.indexOf("\0") + 1),
				)?.source;
			if (!coordinateSource) continue;
			const projected = projectPointOnSegment(candidate, from, to);
			const nativeStart = from.nativeShapeDistance;
			const nativeEnd = to.nativeShapeDistance;
			const nativeShapeDistance =
				nativeStart != null && nativeEnd != null && nativeEnd > nativeStart
					? nativeStart + projected.segmentFraction * (nativeEnd - nativeStart)
					: null;
			appendProjection(
				shape.projections,
				stationId,
				{
					stationId,
					segmentIndex: index,
					segmentFraction: projected.segmentFraction,
					distanceAlongMeters: from.geometricDistanceMeters + projected.segmentFraction * segmentLength,
					lateralDistanceMeters: projected.lateralDistanceMeters,
					coordinateSource,
					nativeShapeDistance,
				},
				config.geometry.maxProjectionsPerStation,
			);
		}
	}
}

/** Build all feed-qualified station, shape, and route-pattern indexes for one static snapshot. */
export function buildCorridorIndex(ctx: CacheContext): CorridorIndex {
	const config = ctx.config.corridor;
	const trips = ctx.raw.consideredTrips ?? [];
	const stops = ctx.gtfs?.getStops() ?? [...ctx.raw.stopsByKey.values()];
	const relevantStationIds = new Set<string>();
	for (const trip of trips) {
		for (const stopTime of getRawStopTimes(ctx, { feedId: trip.feed_id, localId: trip.trip_id })) {
			const stop = getStop(ctx, stopTime.feed_id, stopTime.stop_id);
			relevantStationIds.add(
				stationKey(ctx, stop ?? { feed_id: stopTime.feed_id, stop_id: stopTime.stop_id, parent_station: null }),
			);
		}
	}
	const stationGeometry = getStationGeometry(
		stops,
		ctx,
		relevantStationIds.size > 0 ? relevantStationIds : undefined,
	);
	const shapes = new Map<string, IndexedShape>();
	const shapesByRouteDirection = new Map<string, Set<string>>();
	if (ctx.gtfs) {
		for (const trip of trips) {
			if (!trip.shape_id) continue;
			const shapeKey = entityKey({ feedId: trip.feed_id, localId: trip.shape_id });
			let shape = shapes.get(shapeKey);
			if (!shape) {
				const rows = ctx.gtfs.getShapes({ feed_id: trip.feed_id, shape_id: trip.shape_id });
				const points = shapePoints(rows);
				shape = {
					key: shapeKey,
					feedId: trip.feed_id,
					shapeId: trip.shape_id,
					points,
					lengthMeters: points.at(-1)?.geometricDistanceMeters ?? 0,
					routeDirections: new Set(),
					scheduledStations: new Set(),
					tripIds: new Set(),
					projections: new Map(),
				};
				shapes.set(shapeKey, shape);
			}
			shape.routeDirections.add(qualifiedRouteDirectionKey(trip.feed_id, trip.route_id, trip.direction_id));
			shape.tripIds.add(entityKey({ feedId: trip.feed_id, localId: trip.trip_id }));
			for (const stopTime of getRawStopTimes(ctx, { feedId: trip.feed_id, localId: trip.trip_id })) {
				const stop = getStop(ctx, stopTime.feed_id, stopTime.stop_id);
				shape.scheduledStations.add(
					stationKey(
						ctx,
						stop ?? { feed_id: stopTime.feed_id, stop_id: stopTime.stop_id, parent_station: null },
					),
				);
			}
			const routeDirectionKey = qualifiedRouteDirectionKey(trip.feed_id, trip.route_id, trip.direction_id);
			const group = shapesByRouteDirection.get(routeDirectionKey) ?? new Set<string>();
			group.add(shapeKey);
			shapesByRouteDirection.set(routeDirectionKey, group);
		}
		for (const shape of shapes.values()) indexShapeProjections(shape, stationGeometry, config);
	}

	const patternData = buildPatternIndex(ctx, trips);
	return {
		stationGeometry,
		shapes,
		shapesByRouteDirection,
		patternsByRouteDirection: patternData.byRouteDirection,
		patterns: patternData.patterns,
		version: config.version,
		built: true,
	};
}

export function createEmptyCorridorIndex(version = "1"): CorridorIndex {
	return {
		stationGeometry: new Map(),
		shapes: new Map(),
		shapesByRouteDirection: new Map(),
		patternsByRouteDirection: new Map(),
		patterns: [],
		version,
		built: false,
	};
}
