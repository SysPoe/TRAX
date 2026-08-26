import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PlatformPredictionShadow, type PlatformPredictionEvent } from "../src/utils/platformPredictionShadow.js";

function event(
	eventKey: string,
	scheduledAt: number,
	dayOfWeek: number,
	reportedPlatform: string | null,
): PlatformPredictionEvent {
	return {
		eventKey,
		feedId: "go",
		routeId: "LE",
		routeLabel: "Lakeshore East",
		directionId: 0,
		serviceId: "1234",
		stopId: "UN",
		dayOfWeek,
		scheduledAt,
		availablePlatform: reportedPlatform != null,
		reportedPlatform,
		observedAt: reportedPlatform == null ? null : scheduledAt - 60_000,
	};
}

test("shadow predictions are scored only after a later reported platform arrives", async () => {
	const cacheDir = await mkdtemp(join(tmpdir(), "trax-platform-shadow-"));
	const databasePath = join(cacheDir, "shadow.sqlite");
	const now = Date.parse("2026-08-31T08:00:00Z");
	try {
		const shadow = new PlatformPredictionShadow(databasePath);
		shadow.update(
			[
				event("history-1", now - 21 * 86_400_000, 1, "5 & 6"),
				event("history-2", now - 14 * 86_400_000, 1, "5 & 6"),
				event("history-3", now - 7 * 86_400_000, 1, "5 & 6"),
			],
			now,
		);

		const first = event("future-1", now + 60 * 60_000, 1, null);
		shadow.update([first], now);
		assert.equal(shadow.diagnostics().pending, 1);
		assert.equal(shadow.diagnostics().evaluated, 0);

		shadow.update(
			[{ ...first, availablePlatform: true, reportedPlatform: "5 & 6", observedAt: now + 30 * 60_000 }],
			now + 30 * 60_000,
		);
		const afterFirst = shadow.diagnostics();
		assert.equal(afterFirst.pending, 0);
		assert.equal(afterFirst.evaluated, 1);
		assert.deepEqual(
			afterFirst.byRoute.map(({ accuracyPercent, correct, total }) => ({ accuracyPercent, correct, total })),
			[{ accuracyPercent: 100, correct: 1, total: 1 }],
		);
		assert.equal(afterFirst.byServiceId[0].accuracyPercent, 100);
		assert.equal(afterFirst.byServiceIdAndDay[0].dayOfWeek, "Monday");

		const second = event("future-2", now + 2 * 60 * 60_000, 2, null);
		shadow.update([second], now + 40 * 60_000);
		shadow.update(
			[{ ...second, availablePlatform: true, reportedPlatform: "7", observedAt: now + 90 * 60_000 }],
			now + 90 * 60_000,
		);
		const compared = shadow.diagnostics();
		assert.equal(compared.byRoute[0].accuracyPercent, 50);
		assert.equal(compared.byServiceId[0].accuracyPercent, 50);
		assert.equal(compared.byServiceIdAndDay[0].accuracyPercent, 100);
		shadow.close();

		const reloaded = new PlatformPredictionShadow(databasePath);
		assert.equal(reloaded.diagnostics().byRoute[0].accuracyPercent, 50);
		reloaded.close();
	} finally {
		await rm(cacheDir, { recursive: true, force: true });
	}
});
