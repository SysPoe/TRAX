import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CacheContext } from "../src/cache/types.js";
import {
	PLATFORM_PREDICTION_FEED_IDS,
	getGthaPlatformPredictionDiagnostics,
	updateGthaPlatformPredictionShadow,
} from "../src/region-specific/CA/GTHA/platform-predictions.js";

const TORONTO_TZ = "America/Toronto";
// 2026-09-03T12:00:00Z == 08:00 in Toronto (EDT). Service-day midnight is
// 04:00Z, so hour 7 lands in the past and hour 10 in the near future.
const NOW = Date.parse("2026-09-03T12:00:00Z");
const SERVICE_DATE = "20260903";

let instanceSeq = 0;

function stopTime(stopId: string, departureHour: number, platform: string | null) {
	return {
		passing: false,
		scheduled_departure_time: departureHour * 3600,
		scheduled_parent_station_id: stopId,
		scheduled_stop_id: `${stopId}-01`,
		actual_departure_boarding_locations:
			platform === null
				? []
				: [
						{
							kind: "track",
							value: platform,
							source: "via-cis",
							observed_at: "2026-09-03T11:30:00.000Z",
						},
					],
		rt_platform_code_updated: platform !== null,
		scheduled_platform_code: null,
	};
}

function tripInstance(feedId: string, routeId: string, tripNumber: string, stopTimes: unknown[]) {
	return {
		instance_id: `${feedId}-${tripNumber}-${instanceSeq++}`,
		feed_id: feedId,
		route_id: routeId,
		trip_id: `${routeId}-${tripNumber}`,
		trip_number: tripNumber,
		direction_id: 0,
		serviceDate: SERVICE_DATE,
		nonRevenue: false,
		stopTimes,
	};
}

function context(cacheDir: string, instances: unknown[]): CacheContext {
	const byId = new Map(instances.map((instance) => [(instance as { instance_id: string }).instance_id, instance]));
	return {
		gtfs: {
			getRoutes: () => [
				{ feed_id: "go", route_id: "LE", route_short_name: "Lakeshore East" },
				{ feed_id: "via", route_id: "VIA-1", route_short_name: "Corridor" },
			],
		},
		augmented: { instancesRec: byId },
		config: {
			cacheDir,
			feedTimeZones: new Map([
				["go", TORONTO_TZ],
				["up", TORONTO_TZ],
				["via", TORONTO_TZ],
			]),
		},
		pluginState: new Map(),
	} as unknown as CacheContext;
}

test("VIA Rail feeds the platform prediction shadow alongside GO/UP", async () => {
	assert.ok(PLATFORM_PREDICTION_FEED_IDS.has("go"));
	assert.ok(PLATFORM_PREDICTION_FEED_IDS.has("up"));
	assert.ok(PLATFORM_PREDICTION_FEED_IDS.has("via"));

	const cacheDir = await mkdtemp(join(tmpdir(), "trax-platform-feeds-"));
	try {
		const ctx = context(cacheDir, [
			tripInstance("via", "VIA-1", "64", [stopTime("119", 7, "2")]),
			tripInstance("via", "VIA-1", "65", [stopTime("119", 7, "2")]),
			tripInstance("via", "VIA-1", "66", [stopTime("119", 7, "2")]),
			tripInstance("go", "LE", "1234", [stopTime("UN", 7, "5 & 6")]),
			// Feeds outside the allowlist are ignored before any feed-specific
			// lookup, so no timezone entry is needed for this one.
			tripInstance("exo", "EXO-1", "9999", [stopTime("LUCIEN", 7, "9")]),
		]);
		updateGthaPlatformPredictionShadow(ctx, NOW);
		assert.equal(getGthaPlatformPredictionDiagnostics(ctx).observations, 4);

		// Three VIA observations clear the minimum-samples gate, so a future
		// VIA departure without an assignment earns a pending prediction. The
		// single GO observation does not.
		(ctx.augmented.instancesRec as Map<string, unknown>).clear();
		for (const instance of [
			tripInstance("via", "VIA-1", "67", [stopTime("119", 10, null)]),
			tripInstance("go", "LE", "1235", [stopTime("UN", 10, null)]),
		]) {
			(ctx.augmented.instancesRec as Map<string, unknown>).set(
				(instance as { instance_id: string }).instance_id,
				instance,
			);
		}
		updateGthaPlatformPredictionShadow(ctx, NOW);
		assert.equal(getGthaPlatformPredictionDiagnostics(ctx).pending, 1);
	} finally {
		await rm(cacheDir, { recursive: true, force: true });
	}
});
