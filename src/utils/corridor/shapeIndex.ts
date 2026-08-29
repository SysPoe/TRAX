import type { Shape, Stop, StopTime, Trip } from "qdf-gtfs";
import type { CacheContext } from "../../cache/types.js";
import { getStopTimesForTrips } from "../../cache/gtfsReads.js";
import { canonicalStationIdentity } from "../../config.js";
import { entityKey } from "../../identity.js";
import { coordinateDistanceMeters } from "./geometry.js";
import { CoordinateGridIndex } from "./spatialIndex.js";
import { projectCoordinatesOnSegment } from "./projection.js";
import { qualifiedRouteDirectionKey } from "./keys.js";
import { createPatternIndexBuilder } from "./patternIndex.js";
import type { RoutePattern, StationGeometry, StationProjection } from "./types.js";
import type { CorridorResolutionConfig } from "./types.js";

export interface IndexedShapePoint {
	lat: number;
	lon: number;
	sequence: number;
	geometricDistanceMeters: number;
	nativeShapeDistance: number | null;
}

export interface PackedShapePoints {
	readonly length: number;
	readonly latitudes: Float64Array;
	readonly longitudes: Float64Array;
	readonly geometricDistances: Float64Array;
	/** NaN represents a missing GTFS shape_dist_traveled value. */
	readonly nativeDistances: Float64Array;
}

export interface IndexedShape {
	key: string;
	feedId: string;
	shapeId: string;
	points: IndexedShapePoint[] | PackedShapePoints;
	lengthMeters: number;
	routeDirections: Set<string>;
	scheduledStations: Set<string>;
	tripIds: Set<string>;
	serviceIds: Set<string>;
	projections: Map<string, StationProjection[]>;
	/** Point indexes with monotonic native chainage, for binary anchor lookup. */
	nativeDistancePoints: Uint32Array;
	nativeDistanceScale: number;
	/** Every retained station projection in geometric chainage order. */
	orderedProjections: Array<{ stationId: string; projection: StationProjection }>;
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

function isPackedShapePoints(points: IndexedShape["points"]): points is PackedShapePoints {
	return !Array.isArray(points);
}

export function indexedShapePoint(shape: IndexedShape, index: number): IndexedShapePoint {
	if (!isPackedShapePoints(shape.points)) return shape.points[index];
	const nativeDistance = shape.points.nativeDistances[index];
	return {
		lat: shape.points.latitudes[index],
		lon: shape.points.longitudes[index],
		sequence: index,
		geometricDistanceMeters: shape.points.geometricDistances[index],
		nativeShapeDistance: Number.isNaN(nativeDistance) ? null : nativeDistance,
	};
}

function shapePointValues(points: IndexedShape["points"], index: number) {
	if (!isPackedShapePoints(points)) {
		const point = points[index];
		return {
			lat: point.lat,
			lon: point.lon,
			geometricDistanceMeters: point.geometricDistanceMeters,
			nativeShapeDistance: point.nativeShapeDistance,
		};
	}
	const nativeDistance = points.nativeDistances[index];
	return {
		lat: points.latitudes[index],
		lon: points.longitudes[index],
		geometricDistanceMeters: points.geometricDistances[index],
		nativeShapeDistance: Number.isNaN(nativeDistance) ? null : nativeDistance,
	};
}

function shapePoints(rows: Shape[]): PackedShapePoints {
	rows.sort((a, b) => a.shape_pt_sequence - b.shape_pt_sequence);
	const latitudes = new Float64Array(rows.length);
	const longitudes = new Float64Array(rows.length);
	const geometricDistances = new Float64Array(rows.length);
	const nativeDistances = new Float64Array(rows.length);
	for (let index = 0; index < rows.length; index++) {
		const row = rows[index];
		latitudes[index] = row.shape_pt_lat;
		longitudes[index] = row.shape_pt_lon;
		nativeDistances[index] = finite(row.shape_dist_traveled) ?? Number.NaN;
		if (index > 0) {
			geometricDistances[index] =
				geometricDistances[index - 1] +
				coordinateDistanceMeters(
					{ lat: latitudes[index - 1], lon: longitudes[index - 1] },
					{ lat: latitudes[index], lon: longitudes[index] },
				);
		}
	}
	return { length: rows.length, latitudes, longitudes, geometricDistances, nativeDistances };
}

function appendProjection(
	projections: Map<string, StationProjection[]>,
	stationId: string,
	projection: StationProjection,
	maxProjections: number,
): void {
	const current = projections.get(stationId) ?? [];
	const nearbyIndex = current.reduce((bestIndex, candidate, index) => {
		if (Math.abs(candidate.distanceAlongMeters - projection.distanceAlongMeters) >= 5) return bestIndex;
		if (bestIndex < 0) return index;
		return Math.abs(current[bestIndex].distanceAlongMeters - projection.distanceAlongMeters) >
			Math.abs(candidate.distanceAlongMeters - projection.distanceAlongMeters)
			? index
			: bestIndex;
	}, -1);
	if (nearbyIndex >= 0) {
		if (projection.lateralDistanceMeters >= current[nearbyIndex].lateralDistanceMeters) return;
		current[nearbyIndex] = projection;
	} else {
		current.push(projection);
	}
	current.sort((a, b) => a.lateralDistanceMeters - b.lateralDistanceMeters);
	const retained = current.slice(0, Math.max(maxProjections, 1));
	retained.sort((a, b) => a.distanceAlongMeters - b.distanceAlongMeters);
	projections.set(stationId, retained);
}

interface ProjectionCoordinate {
	stationId: string;
	stopId: string;
	source: "parent" | "platform";
}

function buildProjectionGrid(
	stationGeometry: ReadonlyMap<string, StationGeometry>,
	cellSizeMeters: number,
): CoordinateGridIndex<ProjectionCoordinate> {
	const grid = new CoordinateGridIndex<ProjectionCoordinate>(cellSizeMeters);
	for (const [stationId, geometry] of stationGeometry) {
		for (const coordinate of geometry.coordinates) {
			grid.add({
				id: { stationId, stopId: coordinate.stopId, source: coordinate.source },
				lat: coordinate.lat,
				lon: coordinate.lon,
			});
		}
	}
	return grid;
}

function indexShapeProjections(
	shape: IndexedShape,
	grid: CoordinateGridIndex<ProjectionCoordinate>,
	config: CorridorResolutionConfig,
): void {
	for (let index = 0; index < shape.points.length - 1; index++) {
		const from = shapePointValues(shape.points, index);
		const to = shapePointValues(shape.points, index + 1);
		const candidates = grid.querySegmentCoordinates(
			from.lat,
			from.lon,
			to.lat,
			to.lon,
			config.geometry.endpointSnapMaxMeters,
		);
		const segmentLength = to.geometricDistanceMeters - from.geometricDistanceMeters;
		for (const candidate of candidates) {
			const { stationId, source: coordinateSource } = candidate.id;
			const projected = projectCoordinatesOnSegment(
				candidate.lat,
				candidate.lon,
				from.lat,
				from.lon,
				to.lat,
				to.lon,
			);
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

/** Finalize read-heavy per-shape indexes after points and projections are populated. */
export function finalizeShapeGeometryIndex(shape: IndexedShape): void {
	const nativeDistancePointIndexes: number[] = [];
	let monotonic = true;
	let previousNativeDistance = -Infinity;
	let minimumNativeDistance = Infinity;
	let maximumNativeDistance = -Infinity;
	for (let index = 0; index < shape.points.length; index++) {
		const nativeDistance = shapePointValues(shape.points, index).nativeShapeDistance;
		if (nativeDistance == null) continue;
		if (nativeDistance < previousNativeDistance) {
			monotonic = false;
			break;
		}
		previousNativeDistance = nativeDistance;
		minimumNativeDistance = Math.min(minimumNativeDistance, nativeDistance);
		maximumNativeDistance = Math.max(maximumNativeDistance, nativeDistance);
		nativeDistancePointIndexes.push(index);
	}
	shape.nativeDistancePoints = monotonic ? Uint32Array.from(nativeDistancePointIndexes) : new Uint32Array();
	if (nativeDistancePointIndexes.length > 1 && monotonic) {
		shape.nativeDistanceScale = Math.max(1, (maximumNativeDistance - minimumNativeDistance) / 100);
	} else {
		shape.nativeDistanceScale = 1;
	}
	shape.orderedProjections = [];
	for (const [stationId, projections] of shape.projections) {
		for (const projection of projections) shape.orderedProjections.push({ stationId, projection });
	}
	shape.orderedProjections.sort((a, b) => a.projection.distanceAlongMeters - b.projection.distanceAlongMeters);
}

const STOP_TIME_BATCH_TRIPS = 512;

/** Build all indexes while limiting native stop-time materialization to one trip batch. */
export function buildCorridorIndex(ctx: CacheContext, trips: readonly Trip[] = ctx.raw.consideredTrips ?? []): CorridorIndex {
	const config = ctx.config.corridor;
	const stops = [...ctx.raw.stopsByKey.values()];
	const relevantStationIds = new Set<string>();
	const shapes = new Map<string, IndexedShape>();
	const shapesByRouteDirection = new Map<string, Set<string>>();
	const patternBuilder = createPatternIndexBuilder(ctx);

	const processTrip = (trip: Trip, stopTimes: readonly StopTime[]) => {
		for (const stopTime of stopTimes) {
			const stop = getStop(ctx, stopTime.feed_id, stopTime.stop_id);
			relevantStationIds.add(
				stationKey(ctx, stop ?? { feed_id: stopTime.feed_id, stop_id: stopTime.stop_id, parent_station: null }),
			);
		}
		patternBuilder.addTrip(trip, stopTimes);
		if (ctx.gtfs && trip.shape_id) {
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
					lengthMeters: points.geometricDistances.at(-1) ?? 0,
					routeDirections: new Set(),
					scheduledStations: new Set(),
					tripIds: new Set(),
					serviceIds: new Set(),
					projections: new Map(),
					nativeDistancePoints: new Uint32Array(),
					nativeDistanceScale: 1,
					orderedProjections: [],
				};
				shapes.set(shapeKey, shape);
			}
			shape.routeDirections.add(qualifiedRouteDirectionKey(trip.feed_id, trip.route_id, trip.direction_id));
			shape.tripIds.add(entityKey({ feedId: trip.feed_id, localId: trip.trip_id }));
			shape.serviceIds.add(trip.service_id);
			for (const stopTime of stopTimes) {
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
	};

	const tripsByFeed = new Map<string, Trip[]>();
	for (const trip of trips) {
		const group = tripsByFeed.get(trip.feed_id) ?? [];
		group.push(trip);
		tripsByFeed.set(trip.feed_id, group);
	}
	for (const [feedId, feedTrips] of tripsByFeed) {
		for (let offset = 0; offset < feedTrips.length; offset += STOP_TIME_BATCH_TRIPS) {
			const batch = feedTrips.slice(offset, offset + STOP_TIME_BATCH_TRIPS);
			const uncached = batch.filter(
				(trip) => !ctx.augmented.rawStopTimesCache.has(entityKey({ feedId, localId: trip.trip_id })),
			);
			const rows =
				uncached.length > 0 && ctx.gtfs
					? getStopTimesForTrips(ctx, feedId, uncached.map((trip) => trip.trip_id))
					: [];
			const rowsByTrip = new Map<string, StopTime[]>();
			for (const row of rows) {
				const key = entityKey({ feedId: row.feed_id, localId: row.trip_id });
				const tripRows = rowsByTrip.get(key) ?? [];
				tripRows.push(row);
				rowsByTrip.set(key, tripRows);
			}
			for (const trip of batch) {
				const key = entityKey({ feedId, localId: trip.trip_id });
				processTrip(trip, ctx.augmented.rawStopTimesCache.get(key) ?? rowsByTrip.get(key) ?? []);
			}
		}
	}

	const stationGeometry = getStationGeometry(
		stops,
		ctx,
		relevantStationIds.size > 0 ? relevantStationIds : undefined,
	);
	if (ctx.gtfs) {
		let projectionGrid: CoordinateGridIndex<ProjectionCoordinate> | null = null;
		for (const shape of shapes.values()) {
			const grid = projectionGrid ??= buildProjectionGrid(
				stationGeometry,
				config.geometry.endpointSnapMaxMeters,
			);
			indexShapeProjections(shape, grid, config);
			finalizeShapeGeometryIndex(shape);
		}
	}

	const patternData = patternBuilder.build();
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

export const _test = { appendProjection };
