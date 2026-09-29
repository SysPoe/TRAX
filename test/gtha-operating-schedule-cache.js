import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createCaGthaNetwork } from "../dist/index.js";
import { resolveConfig } from "../dist/config.js";
import { refreshGthaOperatingSchedule } from "../dist/region-specific/CA/GTHA/realtime.js";
import { getServiceDate } from "../dist/utils/time.js";

function context(cacheDir) {
	const config = resolveConfig(createCaGthaNetwork(), { cacheDir, progressLog: () => {}, logFunction: () => {} });
	config.feedTimeZones.set(config.network.feeds[0].id, "America/Toronto");
	return {
		config,
		gtfs: { getTrips: () => [] },
		raw: { injectedTripUpdates: [] },
		augmented: { stops: [] },
		pluginState: new Map(),
	};
}

for (const ageMs of [0, 60 * 60 * 1000]) test(`same-day operating schedule cache aged ${ageMs}ms avoids a startup network request`, async () => {
	const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "trax-gtha-schedule-test-"));
	const file = path.join(cacheDir, "region-specific", "ca-gtha", "operating-schedule.json");
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const date = getServiceDate(new Date(), "America/Toronto");
	const schedule = { date: `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}`, commitmentTrip: [] };
	fs.writeFileSync(file, JSON.stringify(schedule));
	if (ageMs) {
		const oldTime = new Date(Date.now() - ageMs);
		fs.utimesSync(file, oldTime, oldTime);
	}
	const originalFetch = globalThis.fetch;
	let requests = 0;
	globalThis.fetch = async () => { requests++; return new Response(JSON.stringify(schedule), { status: 200 }); };
	try {
		const ctx = context(cacheDir);
		await refreshGthaOperatingSchedule(ctx);
		assert.equal(requests, 0);
		const state = ctx.pluginState.get("ca-gtha:realtime");
		assert.ok(state.nextSourceBFetchMs > Date.now());
		if (ageMs) assert.ok(state.nextSourceBFetchMs < Date.now() + 61_000, "stale data refreshes on the next minute tick");
		state.nextSourceBFetchMs = 0;
		await refreshGthaOperatingSchedule(ctx);
		assert.equal(requests, 1, "the next refresh still checks the provider");
	} finally {
		globalThis.fetch = originalFetch;
	}
});
