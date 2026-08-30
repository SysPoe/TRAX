import assert from "node:assert/strict";
import { RouteType, TripScheduleRelationship } from "qdf-gtfs";
import { createEmptyAugmentedCache, createEmptyRawCache, createRuntimeState } from "../dist/cache/factories.js";
import { resolveConfig } from "../dist/config.js";
import { qualifiedKey, qualifiedRouteDirectionKey } from "../dist/utils/corridor/keys.js";
import { cumulativePolylineDistance } from "../dist/utils/corridor/geometry.js";
import { projectPointOnPolyline } from "../dist/utils/corridor/projection.js";
import {
	buildCorridorIndex,
	createEmptyCorridorIndex,
	finalizeShapeGeometryIndex,
	_test as shapeIndexTest,
} from "../dist/utils/corridor/shapeIndex.js";
import { createRealtimeJourneyContext, resolveJourneyCorridor } from "../dist/utils/corridor/resolver.js";
import { findCompatibleShapes } from "../dist/utils/corridor/compatibleShapes.js";
import { buildPatternIndex } from "../dist/utils/corridor/patternIndex.js";
import {
	expandStopTimesWithCorridor,
	getCorridorTimingWeights,
	withCorridorTimingInstants,
} from "../dist/utils/corridor/timing.js";
import { manualNodeKind } from "../dist/region-specific/AU/SEQ/qr-travel/manual-network.js";
import {
	expandWithSRTPassingStops,
	_test as qrtSrtTest,
} from "../dist/region-specific/AU/SEQ/qr-travel/srt.js";
import { _test as qrtTrackerTest } from "../dist/region-specific/AU/SEQ/qr-travel/qr-travel-tracker.js";
import { augmentTrip } from "../dist/utils/augmentedTrip.js";
import { findExpress } from "../dist/utils/SRT.js";

const q = (feedId, localId) => qualifiedKey(feedId, localId);

function anchor(feedId, localId, sequence, coordinates, options = {}) {
	const coordinate = coordinates[localId];
	return {
		id: q(feedId, `trip\0${sequence}`),
		stationId: q(options.stationFeedId ?? feedId, localId),
		name: localId,
		lat: coordinate?.lat ?? null,
		lon: coordinate?.lon ?? null,
		sequence,
		shapeDistTraveled: options.shapeDistTraveled,
		scheduled: true,
	};
}

function journey(feedId, localIds, coordinates, options = {}) {
	return {
		sourceId: options.stationFeedId === "seq" ? "qrt" : "gtfs",
		feedId,
		tripId: "trip",
		routeId: options.routeId ?? null,
		direction: options.direction ?? null,
		shapeId: options.shapeId ?? null,
		serviceDate: options.serviceDate ?? null,
		anchors: localIds.map((localId, index) =>
			anchor(feedId, localId, index, coordinates, {
				stationFeedId: options.stationFeedId,
				shapeDistTraveled: options.shapeDistances?.[index],
			}),
		),
		geometryFeedIds: options.geometryFeedIds ?? [feedId],
	};
}

function stationGeometry(feedId, localIds, coordinates) {
	return new Map(
		localIds.map((localId) => [
			q(feedId, localId),
			{
				stationId: q(feedId, localId),
				coordinates: [
					{
						...(coordinates[localId] ?? { lat: 0, lon: 0 }),
						source: "parent",
						stopId: localId,
					},
				],
				names: [localId],
			},
		]),
	);
}

function indexedShape(feedId, shapeId, localIds, coordinates, options = {}) {
	const points = localIds.map((localId, index) => ({
		...(coordinates[localId] ?? { lat: 0, lon: 0 }),
		sequence: index,
		geometricDistanceMeters: 0,
		nativeShapeDistance: options.nativeDistances?.[index] ?? null,
	}));
	const distances = cumulativePolylineDistance(points).cumulativeMeters;
	points.forEach((point, index) => (point.geometricDistanceMeters = distances[index]));
	const projections = new Map();
	for (const [localId, coordinate] of Object.entries(coordinates)) {
		const candidates = projectPointOnPolyline(coordinate, points, distances, 3).map((projection) => {
			const from = points[projection.segmentIndex];
			const to = points[projection.segmentIndex + 1];
			const nativeShapeDistance =
				from.nativeShapeDistance != null && to.nativeShapeDistance != null
					? from.nativeShapeDistance +
						projection.segmentFraction * (to.nativeShapeDistance - from.nativeShapeDistance)
					: null;
			return {
				stationId: q(feedId, localId),
				segmentIndex: projection.segmentIndex,
				segmentFraction: projection.segmentFraction,
				distanceAlongMeters: projection.distanceAlongMeters,
				lateralDistanceMeters: projection.lateralDistanceMeters,
				coordinateSource: "parent",
				nativeShapeDistance,
			};
		});
		projections.set(q(feedId, localId), candidates);
	}
	const routeId = options.routeId ?? "route";
	const direction = options.direction ?? 0;
	const shape = {
		key: q(feedId, shapeId),
		feedId,
		shapeId,
		points,
		lengthMeters: distances.at(-1) ?? 0,
		routeDirections: new Set([qualifiedRouteDirectionKey(feedId, routeId, direction)]),
		scheduledStations: new Set((options.scheduledStations ?? localIds).map((localId) => q(feedId, localId))),
		tripIds: new Set((options.tripIds ?? []).map((tripId) => q(feedId, tripId))),
		serviceIds: new Set(options.serviceIds ?? []),
		projections,
		nativeDistancePoints: [],
		nativeDistanceScale: 1,
		orderedProjections: [],
	};
	finalizeShapeGeometryIndex(shape);
	return shape;
}

function addShapes(index, shapes) {
	for (const shape of shapes) {
		index.shapes.set(shape.key, shape);
		for (const stationId of shape.scheduledStations) {
			const stationShapes = index.shapesByStation.get(stationId) ?? new Set();
			stationShapes.add(shape.key);
			index.shapesByStation.set(stationId, stationShapes);
		}
		for (const routeDirection of shape.routeDirections) {
			const group = index.shapesByRouteDirection.get(routeDirection) ?? new Set();
			group.add(shape.key);
			index.shapesByRouteDirection.set(routeDirection, group);
		}
	}
}

function manualNetwork(feedId, options = {}) {
	const ids = ["a", "b", "c", "d"];
	const nodes = ids.map((id) => ({ id, stationId: q(feedId, id), name: id, kind: "station" }));
	if (options.branch) {
		return {
			id: "manual-branch",
			feedId,
			nodes,
			edges: [
				{ from: "a", to: "b", bidirectional: true },
				{ from: "b", to: "d", bidirectional: true },
				{ from: "a", to: "c", bidirectional: true },
				{ from: "c", to: "d", bidirectional: true },
			],
			priority: "fallback",
		};
	}
	return {
		id: "manual-line",
		feedId,
		nodes,
		corridors: options.corridor === false ? [] : [{ id: "line", nodes: ids, bidirectional: true }],
		priority: "fallback",
	};
}

function context(options = {}) {
	const feedIds = options.feedIds ?? ["feed"];
	const network = {
		id: "corridor-test",
		name: "Corridor test",
		feeds: feedIds.map((id) => ({ id, staticSource: { url: `https://example.test/${id}` }, realtimeSources: [] })),
		modes: ["rail"],
		plugins: [],
	};
	const config = resolveConfig(network, {
		corridor: {
			geometrySources: options.geometrySources ?? [],
			manualNetworks: options.manualNetworks ?? [],
			version: "test",
		},
	});
	const augmented = createEmptyAugmentedCache();
	augmented.corridorIndex = options.index ?? createEmptyCorridorIndex(config.corridor.version);
	return {
		raw: createEmptyRawCache(),
		augmented,
		config,
		pluginState: new Map(),
		runtimeState: createRuntimeState(),
	};
}

function simpleCoordinates(localIds) {
	return Object.fromEntries(localIds.map((localId, index) => [localId, { lat: -27, lon: 153 + index * 0.001 }]));
}

function testQualifiedKeys() {
	assert.notEqual(q("feed-a", "same"), q("feed-b", "same"));
	assert.equal(q("feed-a", "same"), "6:feed-asame");
}

function testExactShape() {
	const localIds = ["a", "b", "c", "d"];
	const coordinates = simpleCoordinates(localIds);
	const index = createEmptyCorridorIndex("test");
	index.stationGeometry = stationGeometry("feed", localIds, coordinates);
	addShapes(index, [
		indexedShape("feed", "shape", localIds, coordinates, { scheduledStations: ["a", "d"], routeId: "r" }),
	]);
	const result = resolveJourneyCorridor(
		journey("feed", ["a", "d"], coordinates, { routeId: "r", direction: 0, shapeId: "shape" }),
		context({ index }),
	);
	assert.equal(result.gaps[0].status, "resolved");
	assert.equal(result.gaps[0].evidence, "exact-shape");
	assert.deepEqual(
		result.gaps[0].nodes.map((node) => node.stationId),
		[q("feed", "a"), q("feed", "b"), q("feed", "c"), q("feed", "d")],
	);
	assert.deepEqual(
		result.gaps[0].nodes.map((node) => node.passing),
		[false, true, true, false],
	);
}

function testCompatibleShapeWithUnknownDirection() {
	const localIds = ["a", "b", "d"];
	const coordinates = simpleCoordinates(localIds);
	const index = createEmptyCorridorIndex("test");
	index.stationGeometry = stationGeometry("feed", localIds, coordinates);
	addShapes(index, [
		indexedShape("feed", "compatible", localIds, coordinates, {
			scheduledStations: ["a", "d"],
			routeId: "r",
			direction: 0,
		}),
	]);
	const result = resolveJourneyCorridor(
		journey("feed", ["a", "d"], coordinates, { routeId: "r", direction: null }),
		context({ index }),
	);
	assert.equal(result.gaps[0].evidence, "compatible-shape");
	assert.deepEqual(
		result.gaps[0].nodes.map((node) => node.stationId),
		[q("feed", "a"), q("feed", "b"), q("feed", "d")],
	);
}

function testUnmatchedRouteUsesAnchorCompatibleShape() {
	const localIds = ["a", "b", "c", "d"];
	const coordinates = simpleCoordinates(localIds);
	const index = createEmptyCorridorIndex("test");
	index.stationGeometry = stationGeometry("feed", localIds, coordinates);
	addShapes(index, [
		indexedShape("feed", "stored-shape", localIds, coordinates, {
			scheduledStations: ["a", "d"],
			routeId: "stored-route",
			direction: 0,
		}),
	]);
	const result = resolveJourneyCorridor(
		journey("feed", ["a", "d"], coordinates, { routeId: "provider-only-route", direction: null }),
		context({ index }),
	);
	assert.equal(result.gaps[0].evidence, "compatible-shape");
	assert.deepEqual(
		result.gaps[0].nodes.map((node) => node.stationId),
		[q("feed", "a"), q("feed", "b"), q("feed", "c"), q("feed", "d")],
	);
}

function testUnmatchedRouteKeepsDisagreeingShapesUnresolved() {
	const localIds = ["a", "b", "c", "d"];
	const coordinates = {
		a: { lat: -27, lon: 153 },
		b: { lat: -26.995, lon: 153.001 },
		c: { lat: -27.005, lon: 153.001 },
		d: { lat: -27, lon: 153.002 },
	};
	const index = createEmptyCorridorIndex("test");
	index.stationGeometry = stationGeometry("feed", localIds, coordinates);
	addShapes(index, [
		indexedShape("feed", "branch-b", ["a", "b", "d"], coordinates, {
			scheduledStations: ["a", "d"],
			routeId: "stored-route-b",
		}),
		indexedShape("feed", "branch-c", ["a", "c", "d"], coordinates, {
			scheduledStations: ["a", "d"],
			routeId: "stored-route-c",
		}),
	]);
	const result = resolveJourneyCorridor(
		journey("feed", ["a", "d"], coordinates, { routeId: "provider-only-route", direction: null }),
		context({ index }),
	);
	assert.equal(result.gaps[0].status, "unresolved");
	assert.deepEqual(result.gaps[0].nodes, []);
}

function testReverseShape() {
	const coordinates = simpleCoordinates(["a", "b", "c", "d"]);
	const index = createEmptyCorridorIndex("test");
	index.stationGeometry = stationGeometry("feed", ["a", "b", "c", "d"], coordinates);
	addShapes(index, [
		indexedShape("feed", "shape", ["d", "c", "b", "a"], coordinates, {
			scheduledStations: ["a", "d"],
			routeId: "r",
		}),
	]);
	const result = resolveJourneyCorridor(
		journey("feed", ["a", "d"], coordinates, { routeId: "r", direction: 0, shapeId: "shape" }),
		context({ index }),
	);
	assert.equal(result.gaps[0].status, "resolved");
	assert.deepEqual(
		result.gaps[0].nodes.map((node) => node.stationId),
		[q("feed", "a"), q("feed", "b"), q("feed", "c"), q("feed", "d")],
	);
}

function testMiltonShapeFamilies() {
	const coordinates = {
		boggo: { lat: -27, lon: 153 },
		altandi: { lat: -27, lon: 153.004 },
		milton: { lat: -27.01, lon: 153.002 },
		roma: { lat: -27.01, lon: 153.004 },
	};
	const index = createEmptyCorridorIndex("test");
	index.stationGeometry = stationGeometry("feed", Object.keys(coordinates), coordinates);
	addShapes(index, [
		indexedShape("feed", "normal", ["boggo", "altandi"], coordinates, {
			scheduledStations: ["boggo", "altandi"],
			routeId: "normal",
		}),
		indexedShape("feed", "milton-service", ["altandi", "milton", "roma"], coordinates, {
			scheduledStations: ["altandi", "milton", "roma"],
			routeId: "special",
		}),
	]);
	const ctx = context({ index });
	const normalForward = resolveJourneyCorridor(
		journey("feed", ["boggo", "altandi"], coordinates, {
			routeId: "normal",
			direction: 0,
			shapeId: "normal",
		}),
		ctx,
	);
	const normalReverse = resolveJourneyCorridor(
		journey("feed", ["altandi", "boggo"], coordinates, {
			routeId: "normal",
			direction: 0,
			shapeId: "normal",
		}),
		ctx,
	);
	const special = resolveJourneyCorridor(
		journey("feed", ["altandi", "roma"], coordinates, {
			routeId: "special",
			direction: 0,
			shapeId: "milton-service",
		}),
		ctx,
	);
	assert.equal(
		normalForward.gaps[0].nodes.some((node) => node.stationId === q("feed", "milton")),
		false,
	);
	assert.equal(
		normalReverse.gaps[0].nodes.some((node) => node.stationId === q("feed", "milton")),
		false,
	);
	assert.equal(
		special.gaps[0].nodes.some((node) => node.stationId === q("feed", "milton")),
		true,
	);
	assert.equal(
		normalForward.gaps[0].nodes.some((node) => node.stationId === q("feed", "roma")),
		false,
	);
}

function testNativeDistanceLoop() {
	const coordinates = {
		a: { lat: -27, lon: 153 },
		b: { lat: -27, lon: 153.001 },
		c: { lat: -27.001, lon: 153.001 },
		d: { lat: -27, lon: 153.002 },
	};
	const index = createEmptyCorridorIndex("test");
	index.stationGeometry = stationGeometry("feed", ["a", "b", "c", "d"], coordinates);
	addShapes(index, [
		indexedShape("feed", "shape", ["a", "b", "c", "b", "d"], coordinates, {
			scheduledStations: ["a", "b", "d"],
			nativeDistances: [0, 10, 20, 30, 40],
			routeId: "r",
		}),
	]);
	const result = resolveJourneyCorridor(
		journey("feed", ["a", "b", "d"], coordinates, {
			routeId: "r",
			direction: 0,
			shapeId: "shape",
			shapeDistances: [0, 30, 40],
		}),
		context({ index }),
	);
	assert.equal(
		result.gaps.every((gap) => gap.status === "resolved"),
		true,
	);
	assert.equal(result.gaps[0].nodes.at(-1)?.stationId, q("feed", "b"));
	assert.equal(result.gaps[0].nodes.at(-1)?.distanceAlongMeters > result.gaps[0].nodes[0].distanceAlongMeters, true);
}

function testCompatibleShapesDoNotReuseNativeDistances() {
	const coordinates = {
		a: { lat: -27, lon: 153 },
		b: { lat: -27, lon: 153.001 },
		c: { lat: -27, lon: 153.002 },
		d: { lat: -27, lon: 153.003 },
		x: { lat: -27.01, lon: 153 },
		y: { lat: -27.01, lon: 153.001 },
		z: { lat: -27.01, lon: 153.002 },
		w: { lat: -27.01, lon: 153.003 },
	};
	const index = createEmptyCorridorIndex("test");
	index.stationGeometry = stationGeometry("feed", Object.keys(coordinates), coordinates);
	addShapes(index, [
		indexedShape("feed", "main", ["a", "b", "c", "d"], coordinates, {
			scheduledStations: ["a", "d"],
			routeId: "r",
			nativeDistances: [0, 2000, 4000, 6000],
		}),
		indexedShape("feed", "unrelated", ["x", "y", "z", "w"], coordinates, {
			scheduledStations: ["x", "w"],
			routeId: "r",
			nativeDistances: [0, 2000, 4000, 6000],
		}),
	]);
	const result = resolveJourneyCorridor(
		journey("feed", ["a", "d"], coordinates, {
			routeId: "r",
			direction: 0,
			shapeDistances: [1000, 5000],
		}),
		context({ index }),
	);
	assert.equal(result.gaps[0].status, "resolved");
	assert.equal(result.gaps[0].evidence, "compatible-shape");
	assert.deepEqual(
		result.gaps[0].nodes.map((node) => node.stationId),
		[q("feed", "a"), q("feed", "b"), q("feed", "c"), q("feed", "d")],
	);
}

function testLoopWithoutNativeDistanceStaysAmbiguous() {
	const coordinates = {
		a: { lat: -27, lon: 153 },
		b: { lat: -27, lon: 153.001 },
		c: { lat: -27.001, lon: 153.001 },
		d: { lat: -27, lon: 153.002 },
	};
	const index = createEmptyCorridorIndex("test");
	index.stationGeometry = stationGeometry("feed", ["a", "b", "c", "d"], coordinates);
	addShapes(index, [
		indexedShape("feed", "shape", ["a", "b", "c", "b", "d"], coordinates, {
			scheduledStations: ["a", "b", "d"],
			routeId: "r",
		}),
	]);
	const result = resolveJourneyCorridor(
		journey("feed", ["a", "b", "d"], coordinates, { routeId: "r", direction: 0, shapeId: "shape" }),
		context({ index }),
	);
	assert.equal(
		result.gaps.every((gap) => gap.status === "unresolved"),
		true,
	);
}

function testSelfCrossingProjection() {
	const crossing = { lat: -27.001, lon: 153.001 };
	const points = [
		{ lat: -27, lon: 153 },
		crossing,
		{ lat: -27.002, lon: 153 },
		crossing,
		{ lat: -27.002, lon: 153.002 },
	];
	const distances = cumulativePolylineDistance(points).cumulativeMeters;
	const projections = projectPointOnPolyline(crossing, points, distances, 3);
	assert.equal(projections.length >= 2, true);
	assert.equal(
		projections.some((projection) => projection.distanceAlongMeters - projections[0].distanceAlongMeters > 100),
		true,
	);
}

function testNearVertexProjectionKeepsBetterLaterSegment() {
	const stationId = q("feed", "a");
	const projections = new Map();
	const first = {
		stationId,
		segmentIndex: 0,
		segmentFraction: 0.99,
		distanceAlongMeters: 100,
		lateralDistanceMeters: 20,
		coordinateSource: "parent",
		nativeShapeDistance: null,
	};
	const better = {
		...first,
		segmentIndex: 1,
		segmentFraction: 0.01,
		distanceAlongMeters: 103,
		lateralDistanceMeters: 2,
	};
	shapeIndexTest.appendProjection(projections, stationId, first, 3);
	shapeIndexTest.appendProjection(projections, stationId, better, 3);
	assert.equal(projections.get(stationId).length, 1);
	assert.equal(projections.get(stationId)[0].segmentIndex, 1);
	assert.equal(projections.get(stationId)[0].lateralDistanceMeters, 2);

	const sameStationPlatform = {
		...better,
		segmentIndex: 2,
		distanceAlongMeters: 112,
		lateralDistanceMeters: 0.5,
	};
	shapeIndexTest.appendProjection(projections, stationId, sameStationPlatform, 3);
	assert.equal(projections.get(stationId).length, 1);
	assert.equal(projections.get(stationId)[0].segmentIndex, 2);

	const laterOccurrence = {
		...sameStationPlatform,
		segmentIndex: 8,
		distanceAlongMeters: 400,
	};
	shapeIndexTest.appendProjection(projections, stationId, laterOccurrence, 3);
	assert.equal(projections.get(stationId).length, 2);
}

function testDisplacedParent() {
	const parent = {
		feed_id: "feed",
		stop_id: "a",
		stop_name: "A",
		stop_lat: -26.995,
		stop_lon: 153,
		parent_station: "",
	};
	const platform = {
		feed_id: "feed",
		stop_id: "a-platform",
		stop_name: "A Platform",
		stop_lat: -27,
		stop_lon: 153,
		parent_station: "a",
	};
	const end = { feed_id: "feed", stop_id: "d", stop_name: "D", stop_lat: -27, stop_lon: 153.002, parent_station: "" };
	const trip = {
		feed_id: "feed",
		trip_id: "trip",
		route_id: "r",
		direction_id: 0,
		service_id: "daily",
		shape_id: "shape",
	};
	const stops = [parent, platform, end];
	const ctx = context();
	ctx.raw.consideredTrips = [trip];
	for (const stop of stops) ctx.raw.stopsByKey.set(q("feed", stop.stop_id), stop);
	ctx.augmented.rawStopTimesCache.set(q("feed", "trip"), [
		{ feed_id: "feed", trip_id: "trip", stop_id: "a-platform", stop_sequence: 1, shape_dist_traveled: null },
		{ feed_id: "feed", trip_id: "trip", stop_id: "d", stop_sequence: 2, shape_dist_traveled: null },
	]);
	ctx.gtfs = {
		getStops: () => stops,
		getShapes: () => [
			{ feed_id: "feed", shape_id: "shape", shape_pt_lat: -27, shape_pt_lon: 153, shape_pt_sequence: 1 },
			{ feed_id: "feed", shape_id: "shape", shape_pt_lat: -27, shape_pt_lon: 153.002, shape_pt_sequence: 2 },
		],
	};
	const index = buildCorridorIndex(ctx);
	const station = index.stationGeometry.get(q("feed", "a"));
	assert.equal(station?.coordinates.length, 2);
	const projectionSources = index.shapes
		.get(q("feed", "shape"))
		?.projections.get(q("feed", "a"))
		?.map((item) => item.coordinateSource);
	assert.deepEqual(projectionSources, ["platform"]);
}

function testPartialShape() {
	const coordinates = simpleCoordinates(["a", "b", "c", "d", "x"]);
	coordinates.x = { lat: -27, lon: 153.0025 };
	const index = createEmptyCorridorIndex("test");
	index.stationGeometry = stationGeometry("feed", ["a", "b", "c", "d", "x"], coordinates);
	addShapes(index, [
		indexedShape("feed", "exact", ["a", "b", "c"], coordinates, {
			scheduledStations: ["a", "b", "c"],
			routeId: "r",
		}),
		indexedShape("feed", "compatible", ["c", "x", "d"], coordinates, {
			scheduledStations: ["c", "d"],
			routeId: "r",
		}),
	]);
	const result = resolveJourneyCorridor(
		journey("feed", ["a", "b", "c", "d"], coordinates, { routeId: "r", direction: 0, shapeId: "exact" }),
		context({ index }),
	);
	assert.deepEqual(
		result.gaps.map((gap) => gap.status),
		["resolved", "resolved", "resolved"],
	);
	assert.deepEqual(
		result.gaps.map((gap) => gap.evidence),
		["exact-shape", "exact-shape", "compatible-shape"],
	);
	assert.deepEqual(
		result.gaps[2].nodes.map((node) => node.stationId),
		[q("feed", "c"), q("feed", "x"), q("feed", "d")],
	);
}

function testAmbiguousCompatibleShapes() {
	const coordinates = simpleCoordinates(["a", "c", "d", "x", "y"]);
	const index = createEmptyCorridorIndex("test");
	index.stationGeometry = stationGeometry("feed", ["a", "c", "d", "x", "y"], coordinates);
	addShapes(index, [
		indexedShape("feed", "one", ["c", "x", "d"], coordinates, { scheduledStations: ["c", "d"], routeId: "r" }),
		indexedShape("feed", "two", ["c", "y", "d"], coordinates, { scheduledStations: ["c", "d"], routeId: "r" }),
	]);
	const result = resolveJourneyCorridor(
		journey("feed", ["a", "c", "d"], coordinates, { routeId: "r", direction: 0 }),
		context({ index }),
	);
	assert.equal(result.gaps[1].status, "unresolved");
	assert.equal(result.gaps[1].nodes.length, 0);
}

function testFollowingAnchorDisambiguatesCompatibleShape() {
	const coordinates = {
		a: { lat: -27, lon: 153 },
		b: { lat: -27, lon: 153.001 },
		c: { lat: -27, lon: 153.002 },
		x: { lat: -27, lon: 153.0025 },
		y: { lat: -27.001, lon: 153.0025 },
		d: { lat: -27, lon: 153.003 },
		e: { lat: -27, lon: 153.006 },
		f: { lat: -27.001, lon: 153.004 },
	};
	const index = createEmptyCorridorIndex("test");
	index.stationGeometry = stationGeometry("feed", Object.keys(coordinates), coordinates);
	addShapes(index, [
		indexedShape("feed", "exact", ["a", "b", "c"], coordinates, {
			scheduledStations: ["a", "b", "c"],
			routeId: "r",
		}),
		indexedShape("feed", "one", ["c", "x", "d", "e"], coordinates, {
			scheduledStations: ["c", "d", "e"],
			routeId: "r",
		}),
		indexedShape("feed", "two", ["c", "y", "d", "f"], coordinates, {
			scheduledStations: ["c", "d"],
			routeId: "r",
		}),
	]);
	const result = resolveJourneyCorridor(
		journey("feed", ["a", "b", "c", "d", "e"], coordinates, {
			routeId: "r",
			direction: 0,
			shapeId: "exact",
		}),
		context({ index }),
	);
	assert.equal(result.gaps[2].evidence, "compatible-shape");
	assert.deepEqual(
		result.gaps[2].nodes.map((node) => node.stationId),
		[q("feed", "c"), q("feed", "x"), q("feed", "d")],
	);
}

function testBorrowedShape() {
	const coordinates = simpleCoordinates(["a", "b", "d"]);
	const index = createEmptyCorridorIndex("test");
	index.stationGeometry = stationGeometry("seq", ["a", "b", "d"], coordinates);
	addShapes(index, [
		indexedShape("seq", "shape", ["a", "b", "d"], coordinates, {
			scheduledStations: ["a", "d"],
			routeId: "seq-route",
		}),
	]);
	const result = resolveJourneyCorridor(
		journey("qrt", ["a", "d"], coordinates, {
			stationFeedId: "seq",
			routeId: "qrt-route",
			direction: "north",
			geometryFeedIds: ["seq"],
		}),
		context({ feedIds: ["qrt", "seq"], index, geometrySources: [{ feedId: "qrt", borrowFromFeedIds: ["seq"] }] }),
	);
	assert.equal(result.gaps[0].status, "resolved");
	assert.equal(result.gaps[0].evidence, "borrowed-shape");
	assert.deepEqual(
		result.gaps[0].nodes.map((node) => node.stationId),
		[q("seq", "a"), q("seq", "b"), q("seq", "d")],
	);
}

function testQrtHybridManualBorrowedManual() {
	const coordinates = {
		longreach: { lat: -27, lon: 153 },
		rockhampton: { lat: -27.01, lon: 153.001 },
		gympie: { lat: -27, lon: 153.002 },
		shared: { lat: -27, lon: 153.004 },
		roma: { lat: -27.01, lon: 153.005 },
		mid: { lat: -27.001, lon: 153.003 },
	};
	const index = createEmptyCorridorIndex("test");
	index.stationGeometry = stationGeometry("seq", Object.keys(coordinates), coordinates);
	addShapes(index, [
		indexedShape("seq", "borrowed", ["longreach", "gympie", "mid", "shared"], coordinates, {
			scheduledStations: ["longreach", "gympie", "shared"],
			routeId: "seq",
		}),
	]);
	const manual = {
		id: "qrt-hybrid",
		feedId: "QRT",
		nodes: Object.keys(coordinates).map((id) => ({ id, stationId: q("seq", id), name: id, kind: "station" })),
		corridors: [
			{ id: "first", nodes: ["longreach", "rockhampton"], bidirectional: true },
			{ id: "second", nodes: ["rockhampton", "gympie"], bidirectional: true },
			{ id: "last", nodes: ["shared", "roma"], bidirectional: true },
		],
		priority: "fallback",
		sourceIds: ["qrt"],
	};
	const result = resolveJourneyCorridor(
		journey("QRT", ["longreach", "rockhampton", "gympie", "shared", "roma"], coordinates, {
			stationFeedId: "seq",
			routeId: "spirit",
			direction: "north",
			geometryFeedIds: ["seq"],
		}),
		context({
			feedIds: ["QRT", "seq"],
			index,
			geometrySources: [{ feedId: "QRT", borrowFromFeedIds: ["seq"] }],
			manualNetworks: [manual],
		}),
	);
	assert.deepEqual(
		result.gaps.map((gap) => gap.evidence),
		["manual-corridor", "manual-corridor", "borrowed-shape", "manual-corridor"],
	);
	assert.deepEqual(
		result.gaps.map((gap) => gap.status),
		["resolved", "resolved", "resolved", "resolved"],
	);
	assert.deepEqual(
		result.gaps[2].nodes.map((node) => node.stationId),
		[q("seq", "gympie"), q("seq", "mid"), q("seq", "shared")],
	);
}

function testManualCorridor() {
	const coordinates = simpleCoordinates(["a", "b", "c", "d"]);
	const index = createEmptyCorridorIndex("test");
	index.stationGeometry = stationGeometry("feed", ["a", "b", "c", "d"], coordinates);
	const result = resolveJourneyCorridor(
		journey("feed", ["a", "d"], coordinates),
		context({ index, manualNetworks: [manualNetwork("feed")] }),
	);
	assert.equal(result.gaps[0].evidence, "manual-corridor");
	assert.deepEqual(
		result.gaps[0].nodes.map((node) => node.stationId),
		[q("feed", "a"), q("feed", "b"), q("feed", "c"), q("feed", "d")],
	);
}

function testManualTopology() {
	const coordinates = simpleCoordinates(["a", "b", "c", "d"]);
	const index = createEmptyCorridorIndex("test");
	index.stationGeometry = stationGeometry("feed", ["a", "b", "c", "d"], coordinates);
	const network = {
		id: "manual-topology",
		feedId: "feed",
		nodes: ["a", "b", "c", "d"].map((id) => ({
			id,
			stationId: q("feed", id),
			name: id,
			kind: "station",
		})),
		edges: [
			{ from: "a", to: "b", bidirectional: true },
			{ from: "b", to: "c", bidirectional: true },
			{ from: "c", to: "d", bidirectional: true },
		],
		priority: "fallback",
	};
	const result = resolveJourneyCorridor(
		journey("feed", ["a", "d"], coordinates),
		context({ index, manualNetworks: [network] }),
	);
	assert.equal(result.gaps[0].evidence, "manual-topology");
	assert.deepEqual(
		result.gaps[0].nodes.map((node) => node.stationId),
		[q("feed", "a"), q("feed", "b"), q("feed", "c"), q("feed", "d")],
	);
}

function testSyntheticStationNotRepeatedAcrossGaps() {
	const coordinates = simpleCoordinates(["a", "b", "c", "d"]);
	const index = createEmptyCorridorIndex("test");
	index.stationGeometry = stationGeometry("feed", ["a", "b", "c", "d"], coordinates);
	const network = {
		id: "manual-repeating-path",
		feedId: "feed",
		nodes: ["a", "b", "c", "d"].map((id) => ({ id, stationId: q("feed", id), name: id, kind: "station" })),
		edges: [
			{ from: "a", to: "b" },
			{ from: "b", to: "c" },
			{ from: "c", to: "b" },
			{ from: "b", to: "d" },
		],
		priority: "fallback",
	};
	const result = resolveJourneyCorridor(
		journey("feed", ["a", "c", "d"], coordinates),
		context({ index, manualNetworks: [network] }),
	);
	assert.equal(result.gaps[0].status, "resolved");
	assert.equal(result.gaps[1].status, "unresolved");
	assert.match(result.gaps[1].diagnostic ?? "", /repeat/i);
}

function testAuthoritativeManualNetwork() {
	const coordinates = simpleCoordinates(["a", "b", "c", "d"]);
	const index = createEmptyCorridorIndex("test");
	index.stationGeometry = stationGeometry("feed", ["a", "b", "c", "d"], coordinates);
	const fallback = {
		id: "fallback",
		feedId: "feed",
		nodes: ["a", "b", "c", "d"].map((id) => ({ id, stationId: q("feed", id), name: id, kind: "station" })),
		corridors: [{ id: "fallback-line", nodes: ["a", "b", "d"], bidirectional: true }],
		priority: "fallback",
	};
	const authoritative = {
		id: "authoritative",
		feedId: "feed",
		nodes: ["a", "b", "c", "d"].map((id) => ({ id, stationId: q("feed", id), name: id, kind: "station" })),
		corridors: [{ id: "authoritative-line", nodes: ["a", "c", "d"], bidirectional: true }],
		priority: "authoritative",
	};
	const result = resolveJourneyCorridor(
		journey("feed", ["a", "d"], coordinates),
		context({ index, manualNetworks: [fallback, authoritative] }),
	);
	assert.deepEqual(
		result.gaps[0].nodes.map((node) => node.stationId),
		[q("feed", "a"), q("feed", "c"), q("feed", "d")],
	);
}

function testAuthoritativeManualOverridesCompatibleShape() {
	const coordinates = simpleCoordinates(["a", "b", "c", "d"]);
	const index = createEmptyCorridorIndex("test");
	index.stationGeometry = stationGeometry("feed", ["a", "b", "c", "d"], coordinates);
	addShapes(index, [
		indexedShape("feed", "compatible", ["a", "b", "d"], coordinates, {
			scheduledStations: ["a", "d"],
			routeId: "r",
		}),
	]);
	const authoritative = {
		id: "authoritative-route",
		feedId: "feed",
		nodes: ["a", "b", "c", "d"].map((id) => ({
			id,
			stationId: q("feed", id),
			name: id,
			kind: "station",
		})),
		corridors: [{ id: "curated", nodes: ["a", "c", "d"], bidirectional: true }],
		priority: "authoritative",
	};
	const result = resolveJourneyCorridor(
		journey("feed", ["a", "d"], coordinates, { routeId: "r", direction: 0 }),
		context({ index, manualNetworks: [authoritative] }),
	);
	assert.equal(result.gaps[0].evidence, "manual-corridor");
	assert.deepEqual(
		result.gaps[0].nodes.map((node) => node.stationId),
		[q("feed", "a"), q("feed", "c"), q("feed", "d")],
	);
}

function testAmbiguousManualTopology() {
	const coordinates = simpleCoordinates(["a", "b", "c", "d"]);
	const index = createEmptyCorridorIndex("test");
	index.stationGeometry = stationGeometry("feed", ["a", "b", "c", "d"], coordinates);
	const result = resolveJourneyCorridor(
		journey("feed", ["a", "d"], coordinates),
		context({ index, manualNetworks: [manualNetwork("feed", { branch: true })] }),
	);
	assert.equal(result.gaps[0].status, "unresolved");
	assert.equal(result.gaps[0].nodes.length, 0);
}

function testLongerManualTopologyBranchIsAmbiguous() {
	const coordinates = simpleCoordinates(["a", "b", "d", "x", "y"]);
	const index = createEmptyCorridorIndex("test");
	index.stationGeometry = stationGeometry("feed", ["a", "b", "d", "x", "y"], coordinates);
	const network = {
		id: "manual-long-branch",
		feedId: "feed",
		nodes: ["a", "b", "d", "x", "y"].map((id) => ({ id, stationId: q("feed", id), name: id, kind: "station" })),
		edges: [
			{ from: "a", to: "b", bidirectional: true },
			{ from: "b", to: "d", bidirectional: true },
			{ from: "a", to: "x", bidirectional: true },
			{ from: "x", to: "y", bidirectional: true },
			{ from: "y", to: "d", bidirectional: true },
		],
		priority: "fallback",
	};
	const result = resolveJourneyCorridor(
		journey("feed", ["a", "d"], coordinates),
		context({ index, manualNetworks: [network] }),
	);
	assert.equal(result.gaps[0].status, "unresolved");
	assert.equal(result.gaps[0].nodes.length, 0);
}

function testShapeCannotCrossLaterScheduledAnchor() {
	const coordinates = simpleCoordinates(["a", "b", "c", "d"]);
	const index = createEmptyCorridorIndex("test");
	index.stationGeometry = stationGeometry("feed", ["a", "b", "c", "d"], coordinates);
	addShapes(index, [indexedShape("feed", "shape", ["a", "b", "c", "d"], coordinates)]);
	const result = resolveJourneyCorridor(
		journey("feed", ["a", "d", "c"], coordinates, { shapeId: "shape" }),
		context({ index }),
	);
	assert.equal(result.gaps[0].status, "unresolved");
}

function testPatternFallback() {
	const coordinates = simpleCoordinates(["a", "b", "c", "d"]);
	const index = createEmptyCorridorIndex("test");
	index.stationGeometry = stationGeometry("feed", ["a", "b", "c", "d"], coordinates);
	index.patterns = [
		{
			feedId: "feed",
			routeId: "r",
			direction: 0,
			serviceId: "daily",
			shapeId: null,
			stations: [q("feed", "a"), q("feed", "b"), q("feed", "c"), q("feed", "d")],
			tripIds: [],
		},
	];
	const result = resolveJourneyCorridor(
		journey("feed", ["a", "d"], coordinates, { routeId: "r", direction: 0 }),
		context({ index }),
	);
	assert.equal(result.gaps[0].evidence, "active-pattern");
	assert.deepEqual(
		result.gaps[0].nodes.map((node) => node.stationId),
		[q("feed", "a"), q("feed", "b"), q("feed", "c"), q("feed", "d")],
	);
}

function testTwoAnchorPatternDoesNotProveAdjacency() {
	const coordinates = simpleCoordinates(["a", "d"]);
	const index = createEmptyCorridorIndex("test");
	index.stationGeometry = stationGeometry("feed", ["a", "d"], coordinates);
	index.patterns = [
		{
			feedId: "feed",
			routeId: "r",
			direction: 0,
			serviceId: "express-only",
			shapeId: null,
			stations: [q("feed", "a"), q("feed", "d")],
			tripIds: [],
		},
	];
	const result = resolveJourneyCorridor(
		journey("feed", ["a", "d"], coordinates, { routeId: "r", direction: 0 }),
		context({ index }),
	);
	assert.equal(result.gaps[0].status, "unresolved");
	assert.equal(result.gaps[0].nodes.length, 0);
}

function testRouteLessPatternFallback() {
	const coordinates = simpleCoordinates(["a", "b", "c", "d"]);
	const index = createEmptyCorridorIndex("test");
	index.stationGeometry = stationGeometry("feed", ["a", "b", "c", "d"], coordinates);
	index.patterns = [
		{
			feedId: "feed",
			routeId: "r",
			direction: 0,
			serviceId: "daily",
			shapeId: null,
			stations: [q("feed", "a"), q("feed", "b"), q("feed", "c"), q("feed", "d")],
			tripIds: [],
		},
	];
	const result = resolveJourneyCorridor(
		journey("feed", ["a", "d"], coordinates, { direction: null }),
		context({ index }),
	);
	assert.equal(result.gaps[0].evidence, "active-pattern");
	assert.deepEqual(
		result.gaps[0].nodes.map((node) => node.stationId),
		[q("feed", "a"), q("feed", "b"), q("feed", "c"), q("feed", "d")],
	);
}

function testPatternServiceDateScope() {
	const coordinates = simpleCoordinates(["a", "b", "c", "d"]);
	const index = createEmptyCorridorIndex("test");
	index.stationGeometry = stationGeometry("feed", ["a", "b", "c", "d"], coordinates);
	index.patterns = [
		{
			feedId: "feed",
			routeId: "r",
			direction: 0,
			serviceId: "active-service",
			shapeId: null,
			stations: [q("feed", "a"), q("feed", "b"), q("feed", "d")],
			tripIds: [q("feed", "active-trip")],
		},
		{
			feedId: "feed",
			routeId: "r",
			direction: 0,
			serviceId: "inactive-service",
			shapeId: null,
			stations: [q("feed", "a"), q("feed", "c"), q("feed", "d")],
			tripIds: [q("feed", "inactive-trip")],
		},
	];
	const ctx = context({ index });
	ctx.gtfs = {
		getServiceDatesByTrip: ({ localId }) => (localId === "active-trip" ? ["20260827"] : ["20260828"]),
	};
	const result = resolveJourneyCorridor(
		journey("feed", ["a", "d"], coordinates, { routeId: "r", direction: 0, serviceDate: "20260827" }),
		ctx,
	);
	assert.deepEqual(
		result.gaps[0].nodes.map((node) => node.stationId),
		[q("feed", "a"), q("feed", "b"), q("feed", "d")],
	);
}

function testRealtimeOnlyJourneyAnchors() {
	const localIds = ["a", "b", "d"];
	const coordinates = simpleCoordinates(localIds);
	const index = createEmptyCorridorIndex("test");
	index.stationGeometry = stationGeometry("feed", localIds, coordinates);
	addShapes(index, [
		indexedShape("feed", "realtime-compatible", localIds, coordinates, {
			scheduledStations: ["a", "d"],
			routeId: "r",
		}),
	]);
	const ctx = context({ index });
	for (const [tripId, scheduleRelationship] of [
		["added-trip", TripScheduleRelationship.ADDED],
		["unscheduled-trip", TripScheduleRelationship.UNSCHEDULED],
	]) {
		for (const localId of localIds) {
			ctx.raw.stopsByKey.set(q("feed", localId), {
				feed_id: "feed",
				stop_id: localId,
				stop_name: localId,
				stop_lat: coordinates[localId].lat,
				stop_lon: coordinates[localId].lon,
				parent_station: null,
			});
		}
		const update = {
			feed_id: "feed",
			trip: {
				trip_id: tripId,
				route_id: "r",
				direction_id: 0,
				start_date: "20260827",
				schedule_relationship: scheduleRelationship,
			},
			stop_time_updates: localIds.map((stop_id, index) => ({ stop_id, stop_sequence: index + 1 })),
		};
		const realtimeJourney = createRealtimeJourneyContext(update, ctx);
		const result = resolveJourneyCorridor(realtimeJourney, ctx);
		assert.equal(realtimeJourney.shapeId, null);
		assert.equal(result.gaps[0].evidence, "compatible-shape");
		assert.equal(
			result.gaps.every((gap) => gap.status === "resolved"),
			true,
		);
		assert.deepEqual(
			result.nodes.map((node) => node.stationId),
			[q("feed", "a"), q("feed", "b"), q("feed", "d")],
		);
	}
}

function testReplacementUsesRealtimeStopSequence() {
	const coordinates = {
		a: { lat: -27, lon: 153 },
		b: { lat: -27, lon: 153.001 },
		c: { lat: -27, lon: 153.002 },
		x: { lat: -27.02, lon: 153.001 },
	};
	const index = createEmptyCorridorIndex("test");
	index.stationGeometry = stationGeometry("feed", Object.keys(coordinates), coordinates);
	addShapes(index, [
		indexedShape("feed", "replacement-shape", ["a", "b", "c"], coordinates, {
			scheduledStations: ["a", "b", "c"],
			routeId: "r",
		}),
	]);
	const ctx = context({ index });
	ctx.config.feedTimeZones.set("feed", "Australia/Brisbane");
	const stops = Object.keys(coordinates).map((stop_id) => ({
		feed_id: "feed",
		stop_id,
		stop_name: stop_id.toUpperCase(),
		stop_lat: coordinates[stop_id].lat,
		stop_lon: coordinates[stop_id].lon,
		parent_station: null,
	}));
	for (const stop of stops) ctx.raw.stopsByKey.set(q("feed", stop.stop_id), stop);
	ctx.raw.routesByKey.set(q("feed", "r"), {
		feed_id: "feed",
		route_id: "r",
		route_type: RouteType.Rail,
		route_short_name: "R",
		route_long_name: "Rail",
	});
	const staticStopTimes = ["a", "x", "c"].map((stop_id, index) => ({
		feed_id: "feed",
		trip_id: "trip",
		stop_id,
		stop_sequence: index + 1,
		arrival_time: 3_600 + index * 600,
		departure_time: 3_600 + index * 600,
		pickup_type: 0,
		drop_off_type: 0,
		continuous_pickup: 0,
		continuous_drop_off: 0,
		shape_dist_traveled: null,
		timepoint: 1,
	}));
	ctx.augmented.rawStopTimesCache.set(q("feed", "trip"), staticStopTimes);
	ctx.gtfs = {
		getStops: (filter = {}) =>
			stops.filter(
				(stop) =>
					(!filter.feed_id || filter.feed_id === stop.feed_id) &&
					(!filter.stop_id || filter.stop_id === stop.stop_id),
			),
		getStaticOccupancies: () => [],
	};
	ctx.runtimeState.srtNetworkData = { matrix: {}, adjacency: {}, lastUpdated: Date.now() };
	const update = {
		feed_id: "feed",
		source_id: "replacement-source",
		trip: {
			trip_id: "trip",
			route_id: "r",
			direction_id: 0,
			start_date: "20260827",
			start_time: "10:00:00",
			schedule_relationship: TripScheduleRelationship.REPLACEMENT,
		},
		stop_time_updates: ["a", "b", "c"].map((stop_id, index) => ({
			stop_id,
			stop_sequence: index + 1,
		})),
	};
	const result = augmentTrip(
		{
			feed_id: "feed",
			trip_id: "trip",
			route_id: "r",
			service_id: "daily",
			direction_id: 0,
			shape_id: "replacement-shape",
			trip_headsign: null,
			trip_short_name: null,
			block_id: null,
			wheelchair_accessible: null,
			bikes_allowed: null,
		},
		ctx,
		new Map([[q("feed", "trip"), [update]]]),
		undefined,
		{ serviceDates: ["20260827"], realtimeDates: ["20260827"] },
	);
	assert.deepEqual(
		result.instances[0].stopTimes.map((stopTime) => stopTime.actual_stop_id),
		["a", "b", "c"],
	);
	assert.equal(
		result.instances[0].stopTimes.some((stopTime) => stopTime.actual_stop_id === "x"),
		false,
	);

	const malformedUpdate = {
		...update,
		stop_time_updates: [
			{ stop_id: "a", stop_sequence: 1, arrival_delay: 60, departure_delay: 60 },
			{ stop_id: "b", stop_sequence: 1 },
			{ stop_id: "a", stop_sequence: 2, arrival_delay: 3_600, departure_delay: 3_600 },
			{ stop_id: "c", stop_sequence: 2 },
		],
	};
	const malformedResult = augmentTrip(
		{
			feed_id: "feed",
			trip_id: "trip",
			route_id: "r",
			service_id: "daily",
			direction_id: 0,
			shape_id: "replacement-shape",
			trip_headsign: null,
			trip_short_name: null,
			block_id: null,
			wheelchair_accessible: null,
			bikes_allowed: null,
		},
		ctx,
		new Map([[q("feed", "trip"), [malformedUpdate]]]),
		undefined,
		{ serviceDates: ["20260827"], realtimeDates: ["20260827"] },
	);
	assert.deepEqual(
		malformedResult.instances[0].stopTimes.map((stopTime) => stopTime.actual_stop_id),
		["a", "x", "c"],
	);
	assert.equal(malformedResult.instances[0].stopTimes[0].actual_arrival_time, 3_660);
}

function testTimingRecordsStayAttachedAfterFiltering() {
	const index = createEmptyCorridorIndex("test");
	const ctx = context({ index });
	const journeyContext = journey("feed", ["a", "d"], {}, { shapeId: null });
	const node = (id, distanceAlongMeters, passing) => ({
		id: q("feed", id),
		stationId: q("feed", id),
		name: id,
		kind: "station",
		scheduled: !passing,
		passing,
		distanceAlongMeters,
		evidence: "manual-corridor",
		confidence: "high",
	});
	const timing = getCorridorTimingWeights(
		[node("a", 0, false), node("b", 1, false), node("c", 11, true), node("d", 111, false)],
		journeyContext,
		index,
		ctx,
	);
	const timed = withCorridorTimingInstants(timing, [100, 200]);
	const passing = timed.records.find((record) => record.node.stationId === q("feed", "c"));
	assert.equal(passing?.precedingWeight, 10);
	assert.equal(passing?.precedingMinutes, null);
	assert.equal(passing?.instant, 200);
}

function testContextualFindExpressUsesJourneyShape() {
	const coordinates = simpleCoordinates(["a", "b", "c", "d"]);
	const index = createEmptyCorridorIndex("test");
	index.stationGeometry = stationGeometry("feed", ["a", "b", "c", "d"], coordinates);
	addShapes(index, [
		indexedShape("feed", "shape", ["a", "b", "c", "d"], coordinates, {
			scheduledStations: ["a", "d"],
			routeId: "r",
		}),
	]);
	const ctx = context({ index });
	const result = findExpress(
		journey("feed", ["a", "d"], coordinates, { routeId: "r", direction: 0, shapeId: "shape" }),
		ctx,
	);
	assert.deepEqual(result[0].skipping, [q("feed", "b"), q("feed", "c")]);
}

function testQrtUsesOperatingServiceDate() {
	const ctx = context();
	ctx.config.feedTimeZones.set("feed", "Australia/Brisbane");
	const stop = {
		feed_id: "feed",
		stop_id: "a",
		stop_name: "A",
		stop_lat: -27,
		stop_lon: 153,
		parent_station: null,
	};
	ctx.raw.stopsByKey.set(q("feed", "a"), stop);
	ctx.augmented.railStations = [stop];
	const trip = qrtTrackerTest.convertQRTServiceToTravelTrip(
		{ Title: "Q301 Service", ServiceDate: "20260827" },
		{
			ServiceId: "Q301",
			Modified: "2026-08-28T12:00:00Z",
			Success: true,
			QRTServiceDisruption: { Status: "Scheduled" },
			TrainMovements: [
				{
					PlaceCode: "A",
					PlaceName: "A",
					sourceStopId: "a",
					KStation: false,
					Status: "Scheduled",
					TrainPosition: "NotArrived",
					PlannedArrival: "2026-08-27T10:00:00",
					PlannedDeparture: "2026-08-27T10:01:00",
					ActualArrival: "0001-01-01T00:00:00",
					ActualDeparture: "0001-01-01T00:00:00",
				},
			],
		},
		"Northbound",
		"Spirit",
		ctx,
	);
	assert.equal(trip.serviceDate, "20260827");
	assert.equal(trip.sourceModifiedAt, "2026-08-28T12:00:00Z");
}

function testFeedIsolation() {
	const coordinates = simpleCoordinates(["a", "b", "d"]);
	const feedBCoordinates = {
		a: coordinates.a,
		b: { lat: -27.002, lon: 153.001 },
		d: coordinates.d,
	};
	const index = createEmptyCorridorIndex("test");
	index.stationGeometry = new Map([
		...stationGeometry("feed-a", ["a", "b", "d"], coordinates),
		...stationGeometry("feed-b", ["a", "b", "d"], feedBCoordinates),
	]);
	addShapes(index, [
		indexedShape("feed-a", "same-shape", ["a", "b", "d"], coordinates, { scheduledStations: ["a", "d"] }),
		indexedShape("feed-b", "same-shape", ["a", "d"], feedBCoordinates, { scheduledStations: ["a", "d"] }),
	]);
	const ctx = context({ feedIds: ["feed-a", "feed-b"], index });
	const feedA = resolveJourneyCorridor(journey("feed-a", ["a", "d"], coordinates, { shapeId: "same-shape" }), ctx);
	const feedB = resolveJourneyCorridor(
		journey("feed-b", ["a", "d"], feedBCoordinates, { shapeId: "same-shape" }),
		ctx,
	);
	assert.deepEqual(
		feedA.gaps[0].nodes.map((node) => node.stationId),
		[q("feed-a", "a"), q("feed-a", "b"), q("feed-a", "d")],
	);
	assert.deepEqual(
		feedB.gaps[0].nodes.map((node) => node.stationId),
		[q("feed-b", "a"), q("feed-b", "d")],
	);
	assert.equal(ctx.augmented.corridorResolutionCache.size, 2);
}

function testSkippedOverlay() {
	const coordinates = simpleCoordinates(["a", "b", "c"]);
	const index = createEmptyCorridorIndex("test");
	index.stationGeometry = stationGeometry("feed", ["a", "b", "c"], coordinates);
	addShapes(index, [indexedShape("feed", "shape", ["a", "b", "c"], coordinates, { scheduledStations: ["a", "c"] })]);
	const ctx = context({ index });
	ctx.runtimeState.srtNetworkData = { matrix: {}, adjacency: {}, lastUpdated: Date.now() };
	const journeyContext = journey("feed", ["a", "c"], coordinates, { shapeId: "shape" });
	const corridor = resolveJourneyCorridor(journeyContext, ctx);
	const skipped = {
		feed_id: "feed",
		trip_id: "trip",
		stop_id: "c",
		stop_sequence: 2,
		arrival_time: 120,
		departure_time: 120,
		_isSkipped: true,
	};
	const expanded = expandStopTimesWithCorridor(
		[
			{ feed_id: "feed", trip_id: "trip", stop_id: "a", stop_sequence: 1, arrival_time: 60, departure_time: 60 },
			skipped,
		],
		journeyContext,
		corridor,
		ctx,
	);
	assert.deepEqual(
		expanded.map((stopTime) => stopTime.stop_id),
		["a", "b", "c"],
	);
	assert.equal(expanded.at(-1)._isSkipped, true);
}

function testQrtWaypointClassification() {
	assert.equal(manualNodeKind("Eagle Junction", new Set()), "waypoint");
	assert.equal(manualNodeKind("Eagle Junction", new Set(["eagle junction"])), "station");
	assert.equal(manualNodeKind("Airport Junction", new Set()), "waypoint");
	assert.equal(manualNodeKind("Mayne Junction", new Set()), "waypoint");
	assert.equal(manualNodeKind("Unknown operational location", new Set()), "waypoint");
	assert.equal(qrtSrtTest.qrtDate("7/4/2025 12:00:00 AM"), "20250704");
	assert.equal(qrtSrtTest.qrtDate("2025-07-04T00:00:00"), "20250704");
}

function testUnknownQrtNodePromotesFromGtfsStationGeometry() {
	const index = createEmptyCorridorIndex("test");
	const station = (id, name) => ({
		stationId: q("seq", id),
		coordinates: [],
		names: [name],
	});
	index.stationGeometry = new Map([
		[q("seq", "start"), station("start", "Start")],
		[q("seq", "eagle"), station("eagle", "Eagle Junction")],
		[q("seq", "end"), station("end", "End")],
	]);
	const network = {
		id: "qrt-classification",
		feedId: "QRT",
		nodes: [
			{ id: "start", stationId: q("seq", "start"), name: "Start", kind: "station" },
			{ id: "eagle", name: "Eagle Junction", kind: "waypoint", classification: "unknown" },
			{ id: "end", stationId: q("seq", "end"), name: "End", kind: "station" },
		],
		corridors: [{ id: "line", nodes: ["start", "eagle", "end"] }],
		priority: "fallback",
		sourceIds: ["qrt"],
	};
	const journeyContext = {
		sourceId: "qrt",
		feedId: "QRT",
		tripId: "trip",
		routeId: null,
		direction: null,
		shapeId: null,
		serviceDate: null,
		anchors: [
			{
				id: "start-anchor",
				stationId: q("seq", "start"),
				name: "Start",
				sequence: 0,
				scheduled: true,
			},
			{
				id: "end-anchor",
				stationId: q("seq", "end"),
				name: "End",
				sequence: 1,
				scheduled: true,
			},
		],
		geometryFeedIds: ["seq"],
	};
	const result = resolveJourneyCorridor(
		journeyContext,
		context({ feedIds: ["QRT", "seq"], index, manualNetworks: [network] }),
	);
	assert.equal(result.gaps[0].status, "resolved");
	assert.equal(result.gaps[0].nodes[1].stationId, q("seq", "eagle"));
	assert.equal(result.gaps[0].nodes[1].kind, "station");
	assert.equal(result.gaps[0].nodes[1].passing, true);
}

function testQrtSrtExpandsPassingStations() {
	const names = [
		"Caboolture",
		"Elimbah",
		"Beerburrum",
		"Glass House Mountains",
		"Beerwah",
		"Landsborough",
		"Mooloolah",
		"Eudlo",
		"Palmwoods",
		"Woombye",
		"Nambour",
	];
	const index = createEmptyCorridorIndex("test");
	index.stationGeometry = new Map(
		names.map((name) => [q("seq", name), { stationId: q("seq", name), coordinates: [], names: [name] }]),
	);
	const ctx = context({
		feedIds: ["QRT", "seq"],
		index,
		geometrySources: [{ feedId: "QRT", borrowFromFeedIds: ["seq"] }],
		manualNetworks: [qrtSrtTest.getQrtManualNetwork()],
	});
	ctx.config.feedTimeZones.set("QRT", "Australia/Brisbane");
	ctx.gtfs = {};
	for (const name of ["Caboolture", "Landsborough", "Nambour"])
		ctx.raw.stopsByKey.set(q("seq", name), {
			feed_id: "seq",
			stop_id: name,
			stop_name: name,
			stop_lat: null,
			stop_lon: null,
			parent_station: null,
		});
	const movement = (placeName, plannedArrival, plannedDeparture = plannedArrival) => ({
		PlaceCode: "",
		PlaceName: placeName,
		sourceStopId: placeName,
		KStation: false,
		Status: "Scheduled",
		TrainPosition: "NotArrived",
		PlannedArrival: `2026-08-29T${plannedArrival}:00`,
		PlannedDeparture: `2026-08-29T${plannedDeparture}:00`,
		ActualArrival: "0001-01-01T00:00:00",
		ActualDeparture: "0001-01-01T00:00:00",
	});
	const expanded = expandWithSRTPassingStops(
		[
			movement("Caboolture", "10:00", "10:01"),
			movement("Landsborough", "10:31", "10:32"),
			movement("Nambour", "10:55", "10:56"),
		],
		ctx,
		{ serviceId: "Q301", serviceDate: "20260829", line: "Spirit", direction: "Northbound" },
	);
	assert.deepEqual(
		expanded.filter((stop) => !stop.isStop).map((stop) => stop.placeName),
		["Elimbah", "Beerburrum", "Glass House Mountains", "Beerwah", "Mooloolah", "Eudlo", "Palmwoods", "Woombye"],
	);
	const reverse = expandWithSRTPassingStops(
		[
			movement("Nambour", "10:00", "10:01"),
			movement("Landsborough", "10:24", "10:25"),
			movement("Caboolture", "10:55", "10:56"),
		],
		ctx,
		{ serviceId: "Q302", serviceDate: "20260829", line: "Spirit", direction: "Southbound" },
	);
	assert.deepEqual(
		reverse.filter((stop) => !stop.isStop).map((stop) => stop.placeName),
		["Woombye", "Palmwoods", "Eudlo", "Mooloolah", "Beerwah", "Glass House Mountains", "Beerburrum", "Elimbah"],
	);
}

function testTimingCannotChangeCorridor() {
	const coordinates = simpleCoordinates(["a", "b", "c", "d"]);
	const index = createEmptyCorridorIndex("test");
	index.stationGeometry = stationGeometry("feed", ["a", "b", "c", "d"], coordinates);
	addShapes(index, [
		indexedShape("feed", "shape", ["a", "b", "c", "d"], coordinates, { scheduledStations: ["a", "d"] }),
	]);
	const ctx = context({ index });
	ctx.gtfs = {};
	const journeyContext = journey("feed", ["a", "d"], coordinates, { shapeId: "shape" });
	const corridor = resolveJourneyCorridor(journeyContext, ctx);
	const stopTimes = [
		{ feed_id: "feed", trip_id: "trip", stop_id: "a", stop_sequence: 1, arrival_time: 0, departure_time: 0 },
		{
			feed_id: "feed",
			trip_id: "trip",
			stop_id: "d",
			stop_sequence: 2,
			arrival_time: 1_200,
			departure_time: 1_200,
		},
	];
	ctx.runtimeState.srtNetworkData = { matrix: {}, adjacency: {}, lastUpdated: Date.now() };
	const first = expandStopTimesWithCorridor(stopTimes, journeyContext, corridor, ctx);
	ctx.runtimeState.srtNetworkData = {
		matrix: {
			[q("feed", "a")]: { [q("feed", "b")]: 1 },
			[q("feed", "b")]: { [q("feed", "c")]: 10 },
			[q("feed", "c")]: { [q("feed", "d")]: 1 },
		},
		adjacency: {},
		lastUpdated: Date.now(),
	};
	const second = expandStopTimesWithCorridor(stopTimes, journeyContext, corridor, ctx);
	assert.deepEqual(
		first.map((stopTime) => stopTime.stop_id),
		second.map((stopTime) => stopTime.stop_id),
	);
	assert.notDeepEqual(
		first.slice(1, -1).map((stopTime) => stopTime.arrival_time),
		second.slice(1, -1).map((stopTime) => stopTime.arrival_time),
	);
}

function testPhysicalPlanCacheRebindsCurrentAnchors() {
	const coordinates = simpleCoordinates(["a", "b", "d"]);
	const index = createEmptyCorridorIndex("test");
	index.stationGeometry = stationGeometry("feed", ["a", "b", "d"], coordinates);
	addShapes(index, [indexedShape("feed", "shape", ["a", "b", "d"], coordinates, { scheduledStations: ["a", "d"] })]);
	const ctx = context({ index });
	const firstJourney = journey("feed", ["a", "d"], coordinates, { shapeId: "shape" });
	firstJourney.tripId = "first-trip";
	firstJourney.serviceDate = "20260827";
	const first = resolveJourneyCorridor(firstJourney, ctx);
	const secondJourney = journey("feed", ["a", "d"], coordinates, { shapeId: "shape" });
	secondJourney.tripId = "second-trip";
	secondJourney.serviceDate = "20260828";
	secondJourney.anchors[0] = {
		...secondJourney.anchors[0],
		id: "second-a",
		name: "Current A",
		lat: secondJourney.anchors[0].lat + 0.001,
	};
	secondJourney.anchors[1] = {
		...secondJourney.anchors[1],
		id: "second-d",
		name: "Current D",
		lon: secondJourney.anchors[1].lon + 0.001,
	};
	const second = resolveJourneyCorridor(secondJourney, ctx);
	assert.notEqual(second, first);
	assert.equal(second.gaps[0].from.id, "second-a");
	assert.equal(second.gaps[0].to.id, "second-d");
	assert.equal(second.gaps[0].nodes[0].name, "Current A");
	assert.equal(second.gaps[0].nodes.at(-1).name, "Current D");
	assert.equal(ctx.augmented.corridorResolutionCache.size, 2);
	assert.equal(ctx.augmented.corridorPhysicalResolutionCache.size, 1);
}

function testCompatiblePlanCacheReusesPhysicalPatterns() {
	const coordinates = simpleCoordinates(["a", "b", "d"]);
	const index = createEmptyCorridorIndex("test");
	index.stationGeometry = stationGeometry("feed", ["a", "b", "d"], coordinates);
	addShapes(index, [
		indexedShape("feed", "compatible", ["a", "b", "d"], coordinates, {
			scheduledStations: ["a", "d"],
			routeId: "route",
		}),
	]);
	const ctx = context({ index });
	const firstJourney = journey("feed", ["a", "d"], coordinates, {
		shapeId: "missing",
		routeId: "route",
		direction: 0,
		serviceDate: "20260827",
	});
	firstJourney.tripId = "first-trip";
	const first = resolveJourneyCorridor(firstJourney, ctx);
	assert.equal(first.gaps[0].evidence, "compatible-shape");

	const secondJourney = journey("feed", ["a", "d"], coordinates, {
		shapeId: "missing",
		routeId: "route",
		direction: 0,
		serviceDate: "20260827",
	});
	secondJourney.tripId = "second-trip";
	secondJourney.anchors[0] = { ...secondJourney.anchors[0], id: "current-a", name: "Current A" };
	const second = resolveJourneyCorridor(secondJourney, ctx);
	assert.equal(second.gaps[0].from.id, "current-a");
	assert.equal(second.gaps[0].nodes[0].name, "Current A");
	assert.equal(ctx.augmented.corridorResolutionCache.size, 2);
	assert.equal(ctx.augmented.corridorPhysicalResolutionCache.size, 1);
}

function testExactStaticCorridorIsReusedAcrossServiceDates() {
	const coordinates = simpleCoordinates(["a", "b", "d"]);
	const index = createEmptyCorridorIndex("test");
	index.stationGeometry = stationGeometry("feed", ["a", "b", "d"], coordinates);
	addShapes(index, [
		indexedShape("feed", "shape", ["a", "b", "d"], coordinates, {
			scheduledStations: ["a", "d"],
			routeId: "r",
			nativeDistances: [0, 50, 100],
		}),
	]);
	const ctx = context({ index });
	ctx.config.feedTimeZones.set("feed", "Australia/Brisbane");
	const stops = ["a", "b", "d"].map((stopId) => ({
		feed_id: "feed",
		stop_id: stopId,
		stop_name: stopId.toUpperCase(),
		stop_lat: coordinates[stopId].lat,
		stop_lon: coordinates[stopId].lon,
		parent_station: null,
	}));
	for (const stop of stops) ctx.raw.stopsByKey.set(q("feed", stop.stop_id), stop);
	ctx.raw.routesByKey.set(q("feed", "r"), {
		feed_id: "feed",
		route_id: "r",
		route_type: RouteType.Rail,
		route_short_name: "R",
		route_long_name: "Rail",
	});
	ctx.augmented.rawStopTimesCache.set(q("feed", "trip"), [
		{
			feed_id: "feed",
			trip_id: "trip",
			stop_id: "a",
			stop_sequence: 1,
			arrival_time: 3_600,
			departure_time: 3_600,
			shape_dist_traveled: 0,
		},
		{
			feed_id: "feed",
			trip_id: "trip",
			stop_id: "d",
			stop_sequence: 2,
			arrival_time: 4_200,
			departure_time: 4_200,
			shape_dist_traveled: 100,
		},
	]);
	ctx.gtfs = {
		getStops: (filter = {}) =>
			stops.filter(
				(stop) =>
					(!filter.feed_id || filter.feed_id === stop.feed_id) &&
					(!filter.stop_id || filter.stop_id === stop.stop_id),
			),
		getStaticOccupancies: () => [],
	};
	ctx.runtimeState.srtNetworkData = { matrix: {}, adjacency: {}, lastUpdated: Date.now() };
	const result = augmentTrip(
		{
			feed_id: "feed",
			trip_id: "trip",
			route_id: "r",
			service_id: "daily",
			direction_id: 0,
			shape_id: "shape",
			trip_headsign: null,
			trip_short_name: null,
			block_id: null,
			wheelchair_accessible: null,
			bikes_allowed: null,
		},
		ctx,
		new Map(),
		undefined,
		{ serviceDates: ["20260827", "20260828"] },
	);
	assert.equal(result.instances.length, 2);
	assert.equal(ctx.augmented.corridorResolutionCache.size, 1);
}

function testCompatibleSearchSkipsShapesWithoutAnchorOverlap() {
	const coordinates = simpleCoordinates(["a", "d", "x", "y"]);
	const index = createEmptyCorridorIndex("test");
	index.stationGeometry = stationGeometry("feed", ["a", "d", "x", "y"], coordinates);
	addShapes(index, [
		indexedShape("feed", "exact", ["a", "d"], coordinates, {
			scheduledStations: ["a", "d"],
			routeId: "r",
		}),
		indexedShape("feed", "unrelated", ["x", "y"], coordinates, {
			scheduledStations: ["x", "y"],
			routeId: "r",
			tripIds: ["unrelated-trip"],
		}),
	]);
	const ctx = context({ index });
	let calendarReads = 0;
	ctx.gtfs = {
		getServiceDatesByTrip: () => {
			calendarReads++;
			return ["20260827"];
		},
	};
	const candidates = findCompatibleShapes(
		journey("feed", ["a", "d"], coordinates, {
			routeId: "r",
			direction: 0,
			shapeId: "exact",
			serviceDate: "20260827",
		}),
		index,
		ctx,
	);
	assert.deepEqual(candidates, []);
	assert.equal(calendarReads, 0);
}

function testPatternIndexCollapsesEquivalentTrips() {
	const coordinates = simpleCoordinates(["a", "b", "d"]);
	const ctx = context();
	const stops = ["a", "b", "d"].map((stopId) => ({
		feed_id: "feed",
		stop_id: stopId,
		stop_name: stopId,
		stop_lat: coordinates[stopId].lat,
		stop_lon: coordinates[stopId].lon,
		parent_station: null,
	}));
	for (const stop of stops) ctx.raw.stopsByKey.set(q("feed", stop.stop_id), stop);
	const trips = Array.from({ length: 100 }, (_, index) => ({
		feed_id: "feed",
		trip_id: `trip-${index}`,
		route_id: "r",
		service_id: "weekday",
		direction_id: 0,
		shape_id: "shape",
	}));
	for (const trip of trips) {
		ctx.augmented.rawStopTimesCache.set(
			q("feed", trip.trip_id),
			["a", "b", "d"].map((stopId, index) => ({
				feed_id: "feed",
				trip_id: trip.trip_id,
				stop_id: stopId,
				stop_sequence: index + 1,
				arrival_time: index * 60,
				departure_time: index * 60,
				shape_dist_traveled: index * 100,
			})),
		);
	}
	const result = buildPatternIndex(ctx, trips);
	assert.equal(result.patterns.length, 1);
	assert.equal(result.patterns[0].tripIds.length, trips.length);
}

function testLocalGapsSkipPatternTimingWork() {
	const index = createEmptyCorridorIndex("test");
	index.patterns = [
		{
			feedId: "feed",
			routeId: "r",
			direction: 0,
			serviceId: "weekday",
			shapeId: "shape",
			stations: [q("feed", "a"), q("feed", "d")],
			tripIds: [q("feed", "pattern-trip")],
			edgeMinutes: [10],
			edgeDistances: [100],
		},
	];
	index.patternsByRouteDirection.set(qualifiedRouteDirectionKey("feed", "r", 0), index.patterns);
	const ctx = context({ index });
	let calendarReads = 0;
	ctx.gtfs = {
		getServiceDatesByTrip: () => {
			calendarReads++;
			return ["20260827"];
		},
	};
	const journeyContext = journey("feed", ["a", "d"], simpleCoordinates(["a", "d"]), {
		routeId: "r",
		direction: 0,
		serviceDate: "20260827",
	});
	const corridor = {
		gaps: [
			{
				status: "resolved",
				from: journeyContext.anchors[0],
				to: journeyContext.anchors[1],
				evidence: "exact-shape",
				confidence: "high",
				nodes: journeyContext.anchors.map((item) => ({
					id: item.stationId,
					stationId: item.stationId,
					kind: "station",
					scheduled: true,
					passing: false,
					evidence: "exact-shape",
					confidence: "high",
				})),
			},
		],
	};
	expandStopTimesWithCorridor(
		[
			{ feed_id: "feed", trip_id: "trip", stop_id: "a", stop_sequence: 1, arrival_time: 0, departure_time: 0 },
			{ feed_id: "feed", trip_id: "trip", stop_id: "d", stop_sequence: 2, arrival_time: 600, departure_time: 600 },
		],
		journeyContext,
		corridor,
		ctx,
	);
	assert.equal(calendarReads, 0);
	assert.equal(ctx.augmented.corridorPatternEdgeMinutesCache.size, 0);
}

for (const testCase of [
	["qualified keys isolate identical local entities", testQualifiedKeys],
	["exact shape expands a physical corridor", testExactShape],
	["compatible shapes support an unknown direction", testCompatibleShapeWithUnknownDirection],
	["unmatched routes use anchor-compatible shapes", testUnmatchedRouteUsesAnchorCompatibleShape],
	["unmatched routes keep disagreeing shapes unresolved", testUnmatchedRouteKeepsDisagreeingShapesUnresolved],
	["reverse trips use the reverse interpretation", testReverseShape],
	["normal and Milton-running shapes stay physically distinct", testMiltonShapeFamilies],
	["native shape distance selects a loop occurrence", testNativeDistanceLoop],
	["compatible shapes do not reuse native distances", testCompatibleShapesDoNotReuseNativeDistances],
	["loop without native distance stays ambiguous", testLoopWithoutNativeDistanceStaysAmbiguous],
	["projection retains self-crossing positions", testSelfCrossingProjection],
	["near-vertex projection keeps the better segment", testNearVertexProjectionKeepsBetterLaterSegment],
	["station indexing keeps displaced parent and platform", testDisplacedParent],
	["partial shapes fall back only for the suffix", testPartialShape],
	["disagreeing compatible shapes stay unresolved", testAmbiguousCompatibleShapes],
	["following anchors can disambiguate compatible shapes", testFollowingAnchorDisambiguatesCompatibleShape],
	["borrowed geometry is explicit", testBorrowedShape],
	["QRT-style journeys hybridize manual and borrowed corridors", testQrtHybridManualBorrowedManual],
	["manual corridors resolve without shapes", testManualCorridor],
	["unique manual topology resolves without shapes", testManualTopology],
	["journey validation rejects repeated synthetic stations", testSyntheticStationNotRepeatedAcrossGaps],
	["authoritative manual data wins over fallback data", testAuthoritativeManualNetwork],
	["authoritative manual data overrides compatible geometry", testAuthoritativeManualOverridesCompatibleShape],
	["ambiguous manual topology stays unresolved", testAmbiguousManualTopology],
	["longer manual topology branches stay unresolved", testLongerManualTopologyBranchIsAmbiguous],
	["shape paths cannot cross later scheduled anchors", testShapeCannotCrossLaterScheduledAnchor],
	["active patterns are a scoped fallback", testPatternFallback],
	["two-anchor patterns do not prove adjacency", testTwoAnchorPatternDoesNotProveAdjacency],
	["route-less pattern fallback remains consensus scoped", testRouteLessPatternFallback],
	["active patterns respect the service date", testPatternServiceDateScope],
	["realtime-only relationships align their anchors", testRealtimeOnlyJourneyAnchors],
	["replacement relationships use their realtime stop sequence", testReplacementUsesRealtimeStopSequence],
	["identical shape IDs stay isolated by feed", testFeedIsolation],
	["skipped anchors remain in the physical overlay", testSkippedOverlay],
	["QRT unknown nodes stay waypoints without station evidence", testQrtWaypointClassification],
	["unknown QRT nodes promote from GTFS station geometry", testUnknownQrtNodePromotesFromGtfsStationGeometry],
	["QRT SRT expands every passing station between calls", testQrtSrtExpandsPassingStations],
	["timing records stay attached after filtering", testTimingRecordsStayAttachedAfterFiltering],
	["contextual findExpress uses the journey shape", testContextualFindExpressUsesJourneyShape],
	["QRT uses the operating service date", testQrtUsesOperatingServiceDate],
	["SRT timing cannot change the resolved corridor", testTimingCannotChangeCorridor],
	["physical plan cache rebinds current journey anchors", testPhysicalPlanCacheRebindsCurrentAnchors],
	["compatible plans reuse qualified physical patterns", testCompatiblePlanCacheReusesPhysicalPatterns],
	["exact static corridors are reused across service dates", testExactStaticCorridorIsReusedAcrossServiceDates],
	["compatible search skips shapes without anchor overlap", testCompatibleSearchSkipsShapesWithoutAnchorOverlap],
	["pattern index collapses equivalent trips", testPatternIndexCollapsesEquivalentTrips],
	["local gaps skip pattern timing work", testLocalGapsSkipPatternTimingWork],
]) {
	try {
		testCase[1]();
		console.log(`ok - ${testCase[0]}`);
	} catch (error) {
		console.error(`not ok - ${testCase[0]}`);
		throw error;
	}
}

console.log("Corridor tests passed.");
