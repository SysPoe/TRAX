import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	loadVLineBookingSnapshots,
	saveVLineBookingSnapshots,
	shouldPrefetchVLineBooking,
	vlineBookingSnapshotKey,
	type VLineBookingSnapshot,
} from "../src/region-specific/AU/VIC/booking-snapshots.js";

test("V/Line booking snapshots survive a process restart without changing carriage order", async () => {
	const cacheDir = await mkdtemp(join(tmpdir(), "trax-vline-booking-"));
	try {
		const key = vlineBookingSnapshotKey(
			"20260820",
			"8363",
			"2026-08-20T09:25:00",
			"Melbourne, Southern Cross",
			"Shepparton Station",
		);
		const snapshot: VLineBookingSnapshot = {
			expiresAt: Date.parse("2026-08-20T08:00:00Z"),
			availability: {
				tdn: "8363",
				reservedCarriages: ["D", "A", "E"],
				reservedSeatsAvailable: 12,
				unreservedTicketsAvailable: 34,
				reservationAvailable: true,
				reservationRequired: true,
				seatMapAvailable: false,
				journeyUrl: "https://www.vline.com.au/plan-trip-buy-tickets",
				observedAt: "2026-08-19T23:10:00.000Z",
			},
		};

		saveVLineBookingSnapshots(cacheDir, new Map([[key, snapshot]]), Date.parse("2026-08-19T23:11:00Z"));
		const reloaded = loadVLineBookingSnapshots(cacheDir, Date.parse("2026-08-19T23:12:00Z"));

		assert.deepEqual(reloaded.get(key), snapshot);
		assert.deepEqual(reloaded.get(key)?.availability.reservedCarriages, ["D", "A", "E"]);
	} finally {
		await rm(cacheDir, { recursive: true, force: true });
	}
});

test("expired V/Line booking snapshots are ignored", async () => {
	const cacheDir = await mkdtemp(join(tmpdir(), "trax-vline-booking-"));
	try {
		const snapshot: VLineBookingSnapshot = {
			expiresAt: 1_000,
			availability: {
				tdn: "8363",
				reservedCarriages: [],
				reservedSeatsAvailable: 0,
				unreservedTicketsAvailable: null,
				reservationAvailable: true,
				reservationRequired: true,
				seatMapAvailable: false,
				journeyUrl: "https://www.vline.com.au/plan-trip-buy-tickets",
				observedAt: "1970-01-01T00:00:00.000Z",
			},
		};

		saveVLineBookingSnapshots(cacheDir, new Map([["expired", snapshot]]), 500);
		assert.equal(loadVLineBookingSnapshots(cacheDir, 1_001).size, 0);
	} finally {
		await rm(cacheDir, { recursive: true, force: true });
	}
});

test("pre-departure capture runs once inside the configured window", () => {
	const now = Date.parse("2026-08-19T23:10:00Z");
	assert.equal(shouldPrefetchVLineBooking(now + 15 * 60_000, now), true);
	assert.equal(shouldPrefetchVLineBooking(now, now), false);
	assert.equal(shouldPrefetchVLineBooking(now + 15 * 60_000 + 1, now), false);
});
