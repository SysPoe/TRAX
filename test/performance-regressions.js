import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildSeqDiagramTopology } from "../dist/index.js";
import { _test as refreshCacheTest } from "../dist/cache/refreshCaches.js";
import { getRawTrips } from "../dist/cache/gtfsReads.js";
import { _test as srtTest, getStaticFeedFingerprint } from "../dist/utils/SRT.js";
import { propagateBlockHandoffs } from "../dist/region-specific/CA/GTHA/block-handoff.js";
import { formatTrack, updateSourceB } from "../dist/region-specific/CA/GTHA/realtime.js";
import { ptvMetroPlugin } from "../dist/plugins/ptv-metro.js";
import { isConsideredRoute } from "../dist/utils/considered.js";
import { _test as vlineEnrichmentTest, applyVLineEnrichment } from "../dist/region-specific/AU/VIC/enrichment.js";

function testSeqDiagramUsesProvidedStopTimes() {
	const trips = [
		{ trip_id: "100-a", service_id: "weekday", route_id: "rail", block_id: null },
		{ trip_id: "101-a", service_id: "weekday", route_id: "rail", block_id: "raw-block" },
	];
	const stopTimes = new Map([
		[
			"100-a",
			[
				{ trip_id: "100-a", stop_id: "A", stop_sequence: 1, departure_time: 100 },
				{ trip_id: "100-a", stop_id: "B", stop_sequence: 2, departure_time: 200 },
			],
		],
		[
			"101-a",
			[
				{ trip_id: "101-a", stop_id: "B", stop_sequence: 1, departure_time: 400 },
				{ trip_id: "101-a", stop_id: "C", stop_sequence: 2, departure_time: 500 },
			],
		],
	]);
	const gtfs = {
		getStops: () => [
			{ stop_id: "A", parent_station: "" },
			{ stop_id: "B", parent_station: "" },
			{ stop_id: "C", parent_station: "" },
		],
		getStopTimes: () => {
			throw new Error("full stop_times materialization must not occur");
		},
	};

	const topology = buildSeqDiagramTopology(gtfs, trips, stopTimes);
	assert.equal(topology.tripCount, 2);
	assert.equal(topology.prevTripId.get("101-a"), "100-a");
	assert.equal(topology.rawBlockIdByTripId.get("101-a"), "raw-block");
}

function testDisappearingRealtimeUpdateIsChanged() {
	const previous = new Map([["trip-a", refreshCacheTest.tripUpdateSignature([{ delay: 60 }])]]);
	const next = new Map();
	const changed = refreshCacheTest.findChangedRealtimeTripIds(previous, next, new Set(["trip-a"]));
	assert.deepEqual([...changed], ["trip-a"]);
}

async function testRealtimeUpdatesMaterializeByFeed() {
	const filters = [];
	const gtfs = {
		getRealtimeTripUpdates(filter) {
			filters.push(filter);
			return [{ feed_id: filter.feed_id }];
		},
	};
	const config = { network: { feeds: [{ id: "feed-a" }, { id: "feed-b" }] } };
	let requestHandled = false;
	setImmediate(() => { requestHandled = true; });

	const updates = await refreshCacheTest.getRealtimeTripUpdatesByFeed(gtfs, config);
	assert.equal(requestHandled, true, "realtime materialization must yield between feeds");
	assert.deepEqual(filters, [{ feed_id: "feed-a" }, { feed_id: "feed-b" }]);
	assert.deepEqual(updates.map((update) => update.feed_id), ["feed-a", "feed-b"]);
}

function testStaticFingerprintTracksQDFCacheFile() {
	const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "trax-fingerprint-"));
	try {
		const url = "https://example.test/static.zip";
		const cacheName = crypto.createHash("md5").update(`${url}|{}|`).digest("hex");
		const cachePath = path.join(cacheDir, cacheName);
		fs.writeFileSync(cachePath, "feed-v1");

		const config = {
			network: {
				id: "fingerprint-test",
				name: "Fingerprint test",
				feeds: [{ id: "test", staticSource: { url }, realtimeSources: [] }],
				modes: ["rail"],
				plugins: [],
			},
			cacheDir,
			mergeStops: [],
			updateStopActions: [],
		};
		const first = getStaticFeedFingerprint(config);
		assert.ok(first);

		fs.writeFileSync(cachePath, "feed-version-two");
		const second = getStaticFeedFingerprint(config);
		assert.ok(second);
		assert.notEqual(second, first);

		const withPlace = getStaticFeedFingerprint({
			...config,
			network: {
				...config.network,
				places: [{ id: "shared", name: "Shared", members: [{ feedId: "test", localId: "A" }] }],
			},
		});
		assert.ok(withPlace);
		assert.notEqual(withPlace, second);
	} finally {
		fs.rmSync(cacheDir, { recursive: true, force: true });
	}
}

function testUntimedPassingPointsUseShapeDistance() {
	const stopTimes = [
		{
			arrival_time: 10 * 3600,
			departure_time: 10 * 3600,
			shape_dist_traveled: 0,
		},
		{ arrival_time: null, departure_time: null, shape_dist_traveled: 10_000 },
		{ arrival_time: null, departure_time: null, shape_dist_traveled: 30_000 },
		{
			arrival_time: 11 * 3600,
			departure_time: 11 * 3600,
			shape_dist_traveled: 60_000,
		},
	];

	assert.deepEqual(srtTest.getPatternEdgeTimes(stopTimes), [0, 10, 20, 30]);
}

function pattern(ids, edgeDistances) {
	return ids.map((id, index) => ({ id, timeFromPrev: 0, distanceFromPrev: edgeDistances[index] ?? 0 }));
}

function testExpressPruningDistinguishesParallelCorridors() {
	const directEdge = "A|D";
	const parallelEdges = new Set([directEdge, "A|B", "B|C", "C|D"]);
	srtTest.pruneExpressSkipEdges(
		[pattern(["A", "D"], [0, 5]), pattern(["A", "B", "C", "D"], [0, 7, 7, 6])],
		parallelEdges,
	);
	assert.ok(parallelEdges.has(directEdge), "a materially shorter parallel corridor must remain connected");

	const timedParallelEdges = new Set([directEdge, "A|B", "B|C", "C|D"]);
	const timedPattern = (ids, edgeTimes) =>
		ids.map((id, index) => ({ id, timeFromPrev: edgeTimes[index] ?? 0, distanceFromPrev: 0 }));
	srtTest.pruneExpressSkipEdges(
		[timedPattern(["A", "D"], [0, 3]), timedPattern(["A", "B", "C", "D"], [0, 5, 5, 5])],
		timedParallelEdges,
	);
	assert.ok(timedParallelEdges.has(directEdge), "a clearly shorter corridor must survive feeds without shape distance");

	const expressEdges = new Set([directEdge, "A|B", "B|C", "C|D"]);
	srtTest.pruneExpressSkipEdges(
		[pattern(["A", "D"], [0, 20]), pattern(["A", "B", "C", "D"], [0, 7, 7, 6])],
		expressEdges,
	);
	assert.ok(!expressEdges.has(directEdge), "an express skip over the same corridor must not become track");
}

function testPtvReplacementBusIsNotConsideredRail() {
	const ctx = {
		config: { network: { plugins: [ptvMetroPlugin] } },
		runtimeState: { consideredRoutes: new Map() },
	};
	assert.equal(
		isConsideredRoute(
			{ feed_id: "vic-metro", route_id: "aus:vic:vic-02-GWY-R:", route_type: 400, route_short_name: "Replacement Bus" },
			ctx,
		),
		false,
	);
	assert.equal(
		isConsideredRoute(
			{ feed_id: "vic-metro", route_id: "aus:vic:vic-02-GWY:", route_type: 400, route_short_name: "Glen Waverley" },
			ctx,
		),
		true,
	);
}

function testVLineEnrichmentReadsVehicleSnapshotOnce() {
	let vehicleReads = 0;
	const instances = Array.from({ length: 4 }, (_, index) => ({
		feed_id: "vic-vline",
		trip_id: `01-VLN--${index + 1}-T0-83${index}A`,
		instance_id: `vline-${index}`,
		serviceDate: "20260822",
		stopTimes: [],
	}));
	const ctx = {
		raw: { injectedVehiclePositions: [] },
		augmented: { instancesRec: new Map(instances.map((trip) => [trip.instance_id, trip])) },
		config: { network: { plugins: [] } },
		gtfs: {
			getRealtimeVehiclePositions() {
				vehicleReads += 1;
				return [];
			},
		},
		pluginState: new Map([
			["au-vic-vline", {
				detailsByInstanceId: new Map(),
				detailsByServiceKey: new Map(),
			}],
		]),
	};

	applyVLineEnrichment(ctx, {});
	assert.equal(vehicleReads, 1, "V/Line enrichment must materialize the vehicle snapshot once per refresh");
}

async function testVLineInstanceScanYieldsToRequests() {
	let feedReads = 0;
	const instances = Array.from({ length: 1_000 }, (_, index) => ({
		get feed_id() { feedReads += 1; return "other-feed"; },
		trip_id: `trip-${index}`,
		stopTimes: [],
	}));
	const ctx = { augmented: { instancesRec: new Map(instances.map((trip, index) => [String(index), trip])) } };
	let requestHandled = false;
	setImmediate(() => { requestHandled = true; });

	await vlineEnrichmentTest.currentInstances(ctx);
	assert.equal(requestHandled, true, "V/Line instance scans must yield to waiting HTTP work");
	await vlineEnrichmentTest.currentInstances(ctx);
	assert.equal(feedReads, instances.length, "V/Line instance scans must be reused for the same runtime snapshot");
}

async function testGthaSourceBYieldsToRequests() {
	const ctx = {
		pluginState: new Map(),
		augmented: { timer: { start() {}, stop() {} } },
	};
	const data = {
		date: "2026-08-22",
		commitmentTrip: Array.from({ length: 100 }, (_, index) => ({
			tripNumber: String(index), tripName: "", updateTime: "", stop: [],
		})),
	};
	let requestHandled = false;
	setImmediate(() => { requestHandled = true; });

	await updateSourceB(ctx, new Map(), "20260822", data);
	assert.equal(requestHandled, true, "GTHA Source B processing must yield to waiting HTTP work");
}

function testRawTripsUsesTheStaticSnapshot() {
	const trip = { feed_id: "test", trip_id: "trip-1", route_id: "route-1" };
	const ctx = {
		raw: { consideredTrips: [trip], tripsByKey: new Map() },
		gtfs: {
			getTrips() {
				throw new Error("raw trip reads must not rematerialize the native table");
			},
		},
	};

	assert.deepEqual(getRawTrips(ctx), [trip]);
}

function testBlockHandoffPropagation() {
	const stop = (values = {}) => ({
		actual_parent_station_id: "UN", actual_stop_id: "UN", scheduled_parent_station_id: "UN", scheduled_stop_id: "UN",
		actual_platform_code: null, scheduled_platform_code: null, actual_arrival_boarding_locations: [], actual_departure_boarding_locations: [],
		rt_platform_code_updated: false, rt_arrival_updated: false, rt_departure_updated: false, realtime: false, realtime_info: null,
		...values,
	});
	const incoming = { instance_id: "incoming", stopTimes: [stop({
		scheduled_arrival_time: 17_400, scheduled_departure_time: 17_400, actual_arrival_time: 18_000, actual_departure_time: 18_000,
		actual_platform_code: "5", rt_platform_code_updated: true, rt_arrival_updated: true, realtime: true,
		realtime_info: { delay_secs: 600, delay_string: "10m late", delay_class: "very-late", schedule_relationship: 0, propagated: false, rt_start_date: "20260813" },
	})] };
	const outgoing = { instance_id: "outgoing", stopTimes: [
		stop({ scheduled_arrival_time: 17_700, scheduled_departure_time: 17_700, actual_arrival_time: 17_700, actual_departure_time: 17_700, scheduled_platform_code: "7 & 8", actual_platform_code: "7 & 8" }),
		stop({ actual_parent_station_id: "CL", actual_stop_id: "CL", scheduled_parent_station_id: "CL", scheduled_stop_id: "CL", scheduled_arrival_time: 19_200, scheduled_departure_time: 19_200, actual_arrival_time: 19_200, actual_departure_time: 19_200 }),
	] };
	propagateBlockHandoffs(new Map([["block", [outgoing, incoming]]]), "2026-08-13T21:00:00.000Z");
	assert.equal(outgoing.stopTimes[0].actual_platform_code, "5");
	assert.equal(outgoing.stopTimes[0].actual_departure_boarding_locations[0].confidence, "inferred");
	assert.equal(outgoing.stopTimes[0].actual_departure_time, 18_000);
	assert.equal(outgoing.stopTimes[0].realtime_info.delay_secs, 300);
	assert.equal(outgoing.stopTimes[1].actual_departure_time, 19_500);

	const observed = { instance_id: "observed", stopTimes: [stop({
		scheduled_arrival_time: 17_700, scheduled_departure_time: 17_700, actual_arrival_time: 18_300, actual_departure_time: 18_300,
		rt_departure_updated: true, realtime: true,
		realtime_info: { delay_secs: 600, delay_string: "10m late", delay_class: "very-late", schedule_relationship: 0, propagated: false, rt_start_date: "20260813" },
	})] };
	propagateBlockHandoffs(new Map([["block", [incoming, observed]]]));
	assert.equal(observed.stopTimes[0].actual_departure_time, 18_300);
	assert.equal(observed.stopTimes[0].realtime_info.delay_secs, 600);
}

function testGthaTrackFormatting() {
	assert.equal(formatTrack("1211"), "11 & 12");
	assert.equal(formatTrack("0506"), "5 & 6");
	assert.equal(formatTrack("0807"), "7 & 8");
	assert.equal(formatTrack("0910"), "9 & 10");
	assert.equal(formatTrack("03"), "3");
	assert.equal(formatTrack("11 & 12"), "11 & 12");
}

testSeqDiagramUsesProvidedStopTimes();
testDisappearingRealtimeUpdateIsChanged();
await testRealtimeUpdatesMaterializeByFeed();
testStaticFingerprintTracksQDFCacheFile();
testUntimedPassingPointsUseShapeDistance();
testExpressPruningDistinguishesParallelCorridors();
testPtvReplacementBusIsNotConsideredRail();
testVLineEnrichmentReadsVehicleSnapshotOnce();
await testVLineInstanceScanYieldsToRequests();
await testGthaSourceBYieldsToRequests();
testRawTripsUsesTheStaticSnapshot();
testBlockHandoffPropagation();
testGthaTrackFormatting();
console.log("Performance regression tests passed.");
