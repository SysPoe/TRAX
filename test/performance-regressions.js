import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildSeqDiagramTopology } from "../dist/index.js";
import { _test as refreshCacheTest } from "../dist/cache/refreshCaches.js";
import { getStaticFeedFingerprint } from "../dist/utils/SRT.js";

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

function testStaticFingerprintTracksQDFCacheFile() {
	const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "trax-fingerprint-"));
	try {
		const url = "https://example.test/static.zip";
		const cacheName = crypto.createHash("md5").update(url).digest("hex");
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
	} finally {
		fs.rmSync(cacheDir, { recursive: true, force: true });
	}
}

testSeqDiagramUsesProvidedStopTimes();
testDisappearingRealtimeUpdateIsChanged();
testStaticFingerprintTracksQDFCacheFile();
console.log("Performance regression tests passed.");
