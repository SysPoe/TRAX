import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { alignShapeAnchors } from "../dist/utils/corridor/alignShape.js";
import { resolveShapeGap } from "../dist/utils/corridor/resolveShapeGap.js";
import { finalizeShapeGeometryIndex } from "../dist/utils/corridor/shapeIndex.js";
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

// These bounds intentionally fail on the original full-scan implementation.
assert(alignmentMeasurement.elapsedMs < 250, `native alignment took ${alignmentMeasurement.elapsedMs.toFixed(1)} ms`);
assert(gapMeasurement.elapsedMs < 150, `exact-shape gaps took ${gapMeasurement.elapsedMs.toFixed(1)} ms`);
assert(journeyMeasurement.elapsedMs < 2_000, `unique journeys took ${journeyMeasurement.elapsedMs.toFixed(1)} ms`);
console.log("Corridor performance benchmark passed.");
