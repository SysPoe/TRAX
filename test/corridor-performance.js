import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { alignShapeAnchors } from "../dist/utils/corridor/alignShape.js";
import { resolveShapeGap } from "../dist/utils/corridor/resolveShapeGap.js";
import { buildCorridorIndex, finalizeShapeGeometryIndex } from "../dist/utils/corridor/shapeIndex.js";
import { qualifiedKey } from "../dist/utils/corridor/keys.js";
import { resolveJourneyCorridor } from "../dist/utils/corridor/resolver.js";
import { createEmptyAugmentedCache, createEmptyRawCache, createRuntimeState } from "../dist/cache/factories.js";
import { resolveConfig } from "../dist/config.js";

const config = {
	version: "benchmark",
	enabled: true,
	minimumOutputConfidence: "medium",
	geometry: {
		exactShapeMembershipMaxMeters: 250,
		compatibleShapeMaxMeters: 150,
		geometryOnlyMaxMeters: 80,
		endpointSnapMaxMeters: 300,
		maxProjectionsPerStation: 3,
	},
	geometrySources: [],
	manualNetworks: [],
	diagnostics: false,
};

function fixture(pointCount = 2_000, anchorCount = 50) {
	const points = [];
	const projections = new Map();
	const stationGeometry = new Map();
	for (let index = 0; index < pointCount; index++) {
		points.push({
			lat: 0,
			lon: index / 100_000,
			sequence: index,
			geometricDistanceMeters: index * 10,
			nativeShapeDistance: index * 10,
		});
		const stationId = `station-${index}`;
		projections.set(stationId, [
			{
				stationId,
				segmentIndex: Math.min(index, pointCount - 2),
				segmentFraction: 0,
				distanceAlongMeters: index * 10,
				lateralDistanceMeters: 0,
				coordinateSource: "platform",
				nativeShapeDistance: index * 10,
			},
		]);
		stationGeometry.set(stationId, { stationId, coordinates: [], names: [stationId] });
	}
	const shape = {
		key: qualifiedKey("feed", "shape"),
		feedId: "feed",
		shapeId: "shape",
		points,
		lengthMeters: (pointCount - 1) * 10,
		routeDirections: new Set(),
		scheduledStations: new Set(),
		tripIds: new Set(),
		projections,
		nativeDistancePoints: [],
		nativeDistanceScale: 1,
		orderedProjections: [],
	};
	finalizeShapeGeometryIndex(shape);
	const anchors = Array.from({ length: anchorCount }, (_, index) => {
		const pointIndex = Math.round((index * (pointCount - 1)) / (anchorCount - 1));
		const stationId = `station-${pointIndex}`;
		shape.scheduledStations.add(stationId);
		return {
			id: `anchor-${index}`,
			stationId,
			sequence: index,
			shapeDistTraveled: pointIndex * 10,
			scheduled: true,
		};
	});
	const journey = {
		sourceId: "benchmark",
		feedId: "feed",
		tripId: "trip",
		routeId: "route",
		direction: 0,
		shapeId: "shape",
		serviceDate: null,
		anchors,
		geometryFeedIds: ["feed"],
	};
	return {
		shape,
		journey,
		index: {
			stationGeometry,
			shapes: new Map([[shape.key, shape]]),
			shapesByRouteDirection: new Map(),
			patternsByRouteDirection: new Map(),
			patterns: [],
			version: "benchmark",
			built: true,
		},
	};
}

function measure(label, operation) {
	const started = performance.now();
	const count = operation();
	const elapsedMs = performance.now() - started;
	console.log(`${label}: ${count} operations in ${elapsedMs.toFixed(1)} ms`);
	return { count, elapsedMs };
}

function coldIndexFixture(shapeCount = 2_000) {
	const network = {
		id: "corridor-index-performance",
		name: "Corridor index performance",
		feeds: [{ id: "feed", staticSource: { url: "https://example.test/feed" }, realtimeSources: [] }],
		modes: ["rail"],
		plugins: [],
	};
	const resolverConfig = resolveConfig(network, { corridor: config });
	const raw = createEmptyRawCache();
	const augmented = createEmptyAugmentedCache();
	const trips = [];
	const stops = [];
	const shapes = new Map();
	for (let index = 0; index < shapeCount; index++) {
		const tripId = `trip-${index}`;
		const shapeId = `shape-${index}`;
		const fromStopId = `from-${index}`;
		const toStopId = `to-${index}`;
		const longitude = index / 10_000;
		const trip = {
			feed_id: "feed",
			trip_id: tripId,
			route_id: "route",
			service_id: "service",
			direction_id: 0,
			shape_id: shapeId,
		};
		const fromStop = {
			feed_id: "feed",
			stop_id: fromStopId,
			parent_station: null,
			stop_name: fromStopId,
			stop_lat: 0,
			stop_lon: longitude,
		};
		const toStop = {
			feed_id: "feed",
			stop_id: toStopId,
			parent_station: null,
			stop_name: toStopId,
			stop_lat: 0.001,
			stop_lon: longitude,
		};
		const stopTimes = [
			{
				feed_id: "feed",
				trip_id: tripId,
				stop_id: fromStopId,
				stop_sequence: 1,
				arrival_time: 0,
				departure_time: 0,
				shape_dist_traveled: 0,
			},
			{
				feed_id: "feed",
				trip_id: tripId,
				stop_id: toStopId,
				stop_sequence: 2,
				arrival_time: 60,
				departure_time: 60,
				shape_dist_traveled: 100,
			},
		];
		trips.push(trip);
		stops.push(fromStop, toStop);
		raw.tripsByKey.set(qualifiedKey("feed", tripId), trip);
		raw.stopsByKey.set(qualifiedKey("feed", fromStopId), fromStop);
		raw.stopsByKey.set(qualifiedKey("feed", toStopId), toStop);
		augmented.rawStopTimesCache.set(qualifiedKey("feed", tripId), stopTimes);
		shapes.set(shapeId, [
			{
				feed_id: "feed",
				shape_id: shapeId,
				shape_pt_lat: 0,
				shape_pt_lon: longitude,
				shape_pt_sequence: 1,
				shape_dist_traveled: 0,
			},
			{
				feed_id: "feed",
				shape_id: shapeId,
				shape_pt_lat: 0.001,
				shape_pt_lon: longitude,
				shape_pt_sequence: 2,
				shape_dist_traveled: 100,
			},
		]);
	}
	raw.consideredTrips = trips;
	const gtfs = {
		getStops: (filter = {}) =>
			stops.filter(
				(stop) =>
					(!filter.feed_id || stop.feed_id === filter.feed_id) &&
					(!filter.stop_id || stop.stop_id === filter.stop_id),
			),
		getShapes: ({ shape_id }) => shapes.get(shape_id) ?? [],
	};
	return {
		ctx: {
			raw,
			augmented,
			config: resolverConfig,
			gtfs,
			pluginState: new Map(),
			runtimeState: createRuntimeState(),
		},
		shapeCount,
	};
}

const { shape, journey, index } = fixture();
const alignmentMeasurement = measure("native alignment", () => {
	for (let iteration = 0; iteration < 20; iteration++) {
		const alignment = alignShapeAnchors(journey.anchors, shape, config, { useNativeShapeDistance: true });
		assert.equal(alignment?.matchedCount, journey.anchors.length);
	}
	return 20;
});
const alignment = alignShapeAnchors(journey.anchors, shape, config, { useNativeShapeDistance: true });
assert(alignment);
const gapMeasurement = measure("exact shape gaps", () => {
	let count = 0;
	for (let iteration = 0; iteration < 40; iteration++) {
		for (let anchorIndex = 0; anchorIndex < journey.anchors.length - 1; anchorIndex++) {
			const gap = resolveShapeGap(
				journey.anchors[anchorIndex],
				journey.anchors[anchorIndex + 1],
				anchorIndex,
				anchorIndex + 1,
				shape,
				alignment,
				journey,
				index,
				config,
				"exact-shape",
			);
			assert.equal(gap?.status, "resolved");
			count++;
		}
	}
	return count;
});
const network = {
	id: "corridor-performance",
	name: "Corridor performance",
	feeds: [{ id: "feed", staticSource: { url: "https://example.test/feed" }, realtimeSources: [] }],
	modes: ["rail"],
	plugins: [],
};
const resolverConfig = resolveConfig(network, { corridor: config });
const augmented = createEmptyAugmentedCache();
augmented.corridorIndex = index;
const ctx = {
	raw: createEmptyRawCache(),
	augmented,
	config: resolverConfig,
	pluginState: new Map(),
	runtimeState: createRuntimeState(),
};
const journeyMeasurement = measure("unique journey resolution", () => {
	for (let iteration = 0; iteration < 2_000; iteration++) {
		const result = resolveJourneyCorridor(
			{
				...journey,
				tripId: `trip-${iteration}`,
				serviceDate: `202608${String((iteration % 28) + 1).padStart(2, "0")}`,
			},
			ctx,
		);
		assert.equal(result.gaps.length, journey.anchors.length - 1);
	}
	return 2_000;
});
const coldIndex = coldIndexFixture();
const coldIndexMeasurement = measure("cold corridor index", () => {
	const built = buildCorridorIndex(coldIndex.ctx);
	assert.equal(built.shapes.size, coldIndex.shapeCount);
	return coldIndex.shapeCount;
});

// These bounds intentionally fail on the original full-scan implementation.
assert(alignmentMeasurement.elapsedMs < 250, `native alignment took ${alignmentMeasurement.elapsedMs.toFixed(1)} ms`);
assert(gapMeasurement.elapsedMs < 150, `exact-shape gaps took ${gapMeasurement.elapsedMs.toFixed(1)} ms`);
assert(journeyMeasurement.elapsedMs < 2_000, `unique journeys took ${journeyMeasurement.elapsedMs.toFixed(1)} ms`);
assert(coldIndexMeasurement.elapsedMs < 500, `cold corridor index took ${coldIndexMeasurement.elapsedMs.toFixed(1)} ms`);
console.log("Corridor performance benchmark passed.");
