import assert from "node:assert/strict";
import test from "node:test";
import { _test } from "../src/region-specific/AU/SEQ/qr-travel/booking-collector.js";

test("QRT collection prioritizes maps but reserves every fourth turn for discovery", () => {
	const now = Date.parse("2099-08-30T06:00:00+10:00");
	const candidate = {
		service: {
			traiN_NAME: "Q301",
			traveL_DATE: "2099-08-30T00:00:00",
			departurE_TIME: "9999-12-31T11:00:00",
			endregioncode: "ROK",
		},
		departureAt: now + 5 * 60 * 60 * 1000,
		attemptedAt: 0,
	};
	const collector = {
		ctx: { pluginState: new Map(), config: {} },
		turn: 0,
		searches: new Map(),
		candidates: new Map([[["Q301", "2099-08-30", "11:00", "ROK"].join("\0"), candidate]]),
	};
	assert.equal(_test.chooseTask(collector as never, now)?.kind, "map");
	collector.turn = 3;
	assert.equal(_test.chooseTask(collector as never, now)?.kind, "search");
	assert.equal(_test.mapInterval(now + 36 * 60 * 60 * 1000, now), 12 * 60 * 60 * 1000);
	assert.equal(_test.mapInterval(now + 5 * 60 * 60 * 1000, now), 60 * 60 * 1000);
	assert.equal(_test.noServiceOnDate(404, { errorMessage: ". Services not operating on the date requested" }), true);
	assert.equal(_test.noServiceOnDate(404, { errorMessage: "Unauthorized" }), false);
});
