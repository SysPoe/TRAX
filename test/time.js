import assert from "node:assert/strict";
import {
	getLocalISOString,
	getServiceDate,
	getServiceDayStart,
	getTimezoneOffsetSeconds,
	parseTimeWithConfig,
	serviceTimeToInstant,
} from "../dist/utils/time.js";

const NativeDateTimeFormat = Intl.DateTimeFormat;
let formatterCount = 0;
Intl.DateTimeFormat = new Proxy(NativeDateTimeFormat, {
	construct(target, args) {
		formatterCount++;
		return Reflect.construct(target, args);
	},
});
try {
	for (let index = 0; index < 100; index++) {
		const date = new Date("2026-09-08T01:02:03Z");
		assert.equal(getServiceDate(date, "Australia/Brisbane"), "20260908");
		assert.equal(getLocalISOString(date, "Australia/Brisbane"), "2026-09-08T11:02:03");
		assert.equal(getTimezoneOffsetSeconds("Australia/Brisbane", date), 36_000);
	}
	assert.equal(formatterCount, 3, "reuse each timezone formatter across trip and stop conversions");
} finally {
	Intl.DateTimeFormat = NativeDateTimeFormat;
}

// Reusing a formatter must still evaluate the offset at each instant across DST.
for (const [timezone, before, after, beforeOffset, afterOffset] of [
	["America/Toronto", "2026-03-08T06:59:59Z", "2026-03-08T07:00:00Z", -18_000, -14_400],
	["America/Toronto", "2026-11-01T05:59:59Z", "2026-11-01T06:00:00Z", -14_400, -18_000],
	["Australia/Sydney", "2026-04-04T15:59:59Z", "2026-04-04T16:00:00Z", 39_600, 36_000],
	["Australia/Lord_Howe", "2026-04-04T14:59:59Z", "2026-04-04T15:00:00Z", 39_600, 37_800],
]) {
	assert.equal(getTimezoneOffsetSeconds(timezone, new Date(before)), beforeOffset);
	assert.equal(getTimezoneOffsetSeconds(timezone, new Date(after)), afterOffset);
}
assert.equal(getTimezoneOffsetSeconds("Asia/Kathmandu", new Date("2026-09-08T00:00:00Z")), 20_700);
assert.equal(getTimezoneOffsetSeconds("America/St_Johns", new Date("2026-01-01T00:00:00Z")), -12_600);
assert.equal(getTimezoneOffsetSeconds("UTC", new Date("2026-09-08T00:00:00Z")), 0);
assert.equal(getTimezoneOffsetSeconds("UTC", new Date(NaN)), 0);
assert.equal(getServiceDate(new Date("2026-09-07T15:00:00Z"), "Asia/Tokyo"), "20260908");
assert.equal(getLocalISOString(new Date("2026-09-07T15:00:00Z"), "Asia/Tokyo"), "2026-09-08T00:00:00");
assert.equal(parseTimeWithConfig("2026-09-08T11:02:03", "Australia/Brisbane"), Date.parse("2026-09-08T01:02:03Z"));
assert.equal(getServiceDayStart("20260308", "America/Toronto"), Date.parse("2026-03-08T04:00:00Z") / 1000);
assert.equal(getServiceDayStart("20261101", "America/Toronto"), Date.parse("2026-11-01T05:00:00Z") / 1000);
assert.equal(serviceTimeToInstant("20260908", 25 * 3600, "Australia/Brisbane"), "2026-09-08T15:00:00.000Z");
assert.throws(() => getServiceDate(new Date(), "Invalid/Timezone"), RangeError);
console.log("Timezone formatter reuse and DST tests passed.");
