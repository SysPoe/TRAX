import assert from "node:assert/strict";
import test from "node:test";
import { normalizeNasid, resolveVehicleObservation } from "../src/qrtWifiResolver.js";

const observation = {
	observedAt: "2026-02-01T10:00:00.000Z",
	latitude: -27.465,
	longitude: 153.017,
	accuracyM: 10,
	nasidNormalized: "TRAIN 763DMB",
};

function candidate(snapshotAt: string, overrides = {}) {
	return {
		feedId: "translink-seq",
		tripId: "T1",
		tripStartDate: "20260201",
		tripStartTime: "10:00:00",
		vehicleId: "V1",
		latitude: -27.465,
		longitude: 153.017,
		positionAsOf: "2026-02-01T10:00:00.000Z",
		snapshotAt,
		aliasConfidence: 1,
		...overrides,
	};
}

test("duplicate snapshots of one vehicle do not make a unique match ambiguous", () => {
	const result = resolveVehicleObservation(
		observation,
		[candidate("2026-02-01T10:00:01.000Z"), candidate("2026-02-01T10:00:02.000Z")],
		{ networkId: "au-rail" },
	);
	assert.equal(result.status, "matched");
	assert.equal(result.candidateCount, 1);
});

test("synthetic identities require a valid service date and start time", () => {
	for (const broken of [
		candidate("2026-02-01T10:00:01.000Z", { tripStartDate: null }),
		candidate("2026-02-01T10:00:01.000Z", { tripStartTime: "8am" }),
	]) {
		const result = resolveVehicleObservation(observation, [broken], { networkId: "au-rail" });
		assert.equal(result.status, "unmatched");
		assert.ok(result.reasons.includes("TRIP_INSTANCE_NOT_FOUND"));
	}
});

test("stale positions and low-accuracy observations cannot produce matches", () => {
	const stale = resolveVehicleObservation(
		observation,
		[candidate("2026-02-01T10:10:00.000Z")],
		{ networkId: "au-rail" },
	);
	assert.equal(stale.status, "unmatched");
	const inaccurate = resolveVehicleObservation(
		{ ...observation, accuracyM: 1000 },
		[candidate("2026-02-01T10:00:01.000Z")],
		{ networkId: "au-rail" },
	);
	assert.equal(inaccurate.status, "unmatched");
	assert.ok(inaccurate.reasons.includes("GPS_ACCURACY_LOW"));
});

test("NASID normalization collapses repeated whitespace", () => {
	assert.equal(normalizeNasid(" Train  763DMB "), "TRAIN 763DMB");
});

test("non-finite observation lat/lon never matches and stays finite", () => {
	for (const broken of [
		{ ...observation, latitude: NaN },
		{ ...observation, latitude: Infinity },
		{ ...observation, latitude: -Infinity },
		{ ...observation, longitude: NaN },
		{ ...observation, longitude: Infinity },
		{ ...observation, longitude: -Infinity },
	]) {
		const result = resolveVehicleObservation(broken, [candidate("2026-02-01T10:00:01.000Z")], {
			networkId: "au-rail",
		});
		assert.equal(result.status, "unmatched");
		assert.equal(result.tripInstanceId, null);
		assert.ok(Number.isFinite(result.confidence));
		assert.equal(result.confidence, 0);
		assert.equal(result.distanceM, null);
		assert.equal(result.candidateCount, 0);
	}
});

test("non-finite candidate coordinates never match and stay finite", () => {
	for (const broken of [
		candidate("2026-02-01T10:00:01.000Z", { latitude: NaN }),
		candidate("2026-02-01T10:00:01.000Z", { latitude: Infinity }),
		candidate("2026-02-01T10:00:01.000Z", { longitude: NaN }),
		candidate("2026-02-01T10:00:01.000Z", { longitude: -Infinity }),
	]) {
		const result = resolveVehicleObservation(observation, [broken], { networkId: "au-rail" });
		assert.equal(result.status, "unmatched");
		assert.equal(result.tripInstanceId, null);
		assert.ok(Number.isFinite(result.confidence));
		assert.equal(result.distanceM, null);
	}
});

test("non-finite bearings degrade to neutral and stay finite", () => {
	const neutral = resolveVehicleObservation(
		observation,
		[candidate("2026-02-01T10:00:01.000Z", { bearing: 90 })],
		{ networkId: "au-rail" },
	);
	for (const broken of [
		[{ ...observation, bearingDeg: NaN }, candidate("2026-02-01T10:00:01.000Z", { bearing: 90 })],
		[{ ...observation, bearingDeg: Infinity }, candidate("2026-02-01T10:00:01.000Z", { bearing: 0 })],
		[observation, candidate("2026-02-01T10:00:01.000Z", { bearing: NaN })],
		[observation, candidate("2026-02-01T10:00:01.000Z", { bearing: Infinity })],
	] as const) {
		const result = resolveVehicleObservation(broken[0] as any, [broken[1] as any], {
			networkId: "au-rail",
		});
		assert.ok(Number.isFinite(result.confidence), `confidence must be finite, got ${result.confidence}`);
		assert.ok(
			result.distanceM === null || Number.isFinite(result.distanceM),
			`distanceM must be finite or null, got ${result.distanceM}`,
		);
		if (result.status === "matched") {
			assert.ok(Number.isFinite(result.confidence));
			assert.ok(result.distanceM !== null && Number.isFinite(result.distanceM));
		}
		// NaN/Infinity bearing must behave like missing bearing (neutral 0.5), not NaN score
		const missingBearing = resolveVehicleObservation(
			observation,
			[candidate("2026-02-01T10:00:01.000Z")],
			{ networkId: "au-rail" },
		);
		assert.equal(result.confidence, missingBearing.confidence);
		assert.ok(!result.reasons.includes("BEARING_AGREEMENT"));
		assert.ok(!result.reasons.includes("BEARING_DISAGREEMENT"));
	}
	assert.ok(Number.isFinite(neutral.confidence));
});

test("non-finite aliasConfidence never boosts score or yields non-finite confidence", () => {
	// Perfect location/time: NaN alias must not produce NaN confidence and must not claim ALIAS_MATCH
	const nanAlias = resolveVehicleObservation(
		observation,
		[candidate("2026-02-01T10:00:01.000Z", { aliasConfidence: NaN })],
		{ networkId: "au-rail" },
	);
	assert.ok(Number.isFinite(nanAlias.confidence), `confidence must be finite, got ${nanAlias.confidence}`);
	assert.ok(!nanAlias.reasons.includes("ALIAS_MATCH"));
	// Borderline distance (~60m, radius 300m): alias 0 is ambiguous, alias 1 is matched.
	// Infinity must behave like 0 (no boost), not like 1.
	const offsetLat = -27.465 + 60 / 111320;
	const borderline = (aliasConfidence: any) =>
		resolveVehicleObservation(
			observation,
			[
				candidate("2026-02-01T10:00:01.000Z", {
					latitude: offsetLat,
					aliasConfidence,
				}),
			],
			{ networkId: "au-rail" },
		);
	const withZero = borderline(0);
	const withOne = borderline(1);
	assert.equal(withZero.status, "ambiguous");
	assert.equal(withOne.status, "matched");
	for (const invalid of [NaN, Infinity, -Infinity]) {
		const result = borderline(invalid);
		assert.ok(Number.isFinite(result.confidence), `alias ${String(invalid)} must stay finite`);
		assert.ok(!result.reasons.includes("ALIAS_MATCH"), `alias ${String(invalid)} must not claim ALIAS_MATCH`);
		assert.equal(result.status, withZero.status, `alias ${String(invalid)} must behave like alias 0`);
		assert.equal(result.confidence, withZero.confidence);
	}
});

test("non-finite intermediate distance/score/confidence never yields matched with non-finite values", () => {
	const cases: Array<[any, any]> = [
		[{ ...observation, latitude: NaN }, candidate("2026-02-01T10:00:01.000Z")],
		[{ ...observation, longitude: Infinity }, candidate("2026-02-01T10:00:01.000Z")],
		[observation, candidate("2026-02-01T10:00:01.000Z", { latitude: NaN })],
		[observation, candidate("2026-02-01T10:00:01.000Z", { longitude: Infinity })],
		[
			{ ...observation, bearingDeg: NaN },
			candidate("2026-02-01T10:00:01.000Z", { bearing: 45 }),
		],
		[observation, candidate("2026-02-01T10:00:01.000Z", { aliasConfidence: NaN })],
	];
	for (const [obs, cand] of cases) {
		const result = resolveVehicleObservation(obs, [cand], { networkId: "au-rail" });
		assert.ok(Number.isFinite(result.confidence), `confidence finite for ${JSON.stringify(obs.latitude)}`);
		assert.ok(
			result.distanceM === null || Number.isFinite(result.distanceM),
			`distanceM finite-or-null, got ${result.distanceM}`,
		);
		if (result.status === "matched") {
			assert.ok(Number.isFinite(result.confidence), "matched confidence must be finite");
			assert.ok(result.distanceM !== null && Number.isFinite(result.distanceM), "matched distanceM must be finite");
			assert.ok(result.tripInstanceId !== null && result.tripInstanceId.length > 0);
		} else {
			assert.equal(result.tripInstanceId, null);
		}
	}
});
