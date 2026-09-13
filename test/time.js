import assert from "node:assert/strict";
import {
	getLocalISOString,
	getServiceDate,
	getServiceDayStart,
	getTimezoneOffsetSeconds,
	parseTimeWithConfig,
	secTimeDiff,
	serviceTimeToInstant,
	timeDiff,
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
assert.equal(getServiceDayStart("20260308", "America/Toronto"), Date.parse("2026-03-08T05:00:00Z") / 1000);
assert.equal(getServiceDayStart("20261101", "America/Toronto"), Date.parse("2026-11-01T04:00:00Z") / 1000);
assert.equal(
	new Date(parseTimeWithConfig("2026-03-08T02:30:00", "America/Toronto")).toISOString(),
	"2026-03-08T07:30:00.000Z",
);
assert.equal(
	new Date(parseTimeWithConfig("2026-11-01T01:30:00", "America/Toronto")).toISOString(),
	"2026-11-01T05:30:00.000Z",
);
assert.equal(
	new Date(parseTimeWithConfig("2026-10-04T02:30:00", "Australia/Sydney")).toISOString(),
	"2026-10-03T16:30:00.000Z",
);
assert.equal(serviceTimeToInstant("20260908", 25 * 3600, "Australia/Brisbane"), "2026-09-08T15:00:00.000Z");
assert.equal(secTimeDiff("00:00:30", "00:00:00"), 30);
assert.equal(timeDiff("00:00:30", "00:00:00"), "0h 0m 30s");
// Seconds must survive the minute-level legacy path.
assert.equal(secTimeDiff("10:00:10", "10:00:00"), 10);
assert.equal(secTimeDiff("10:00", "10:00:00"), 0);
assert.equal(timeDiff("10:00:10", "10:00:00"), "0h 0m 10s");
assert.equal(timeDiff("10:01:00", "10:00:00"), "0h 1m");
assert.equal(timeDiff("01:02:03", "00:00:00"), "1h 2m 3s");
assert.equal(secTimeDiff("01:00:00", "23:00:00"), 2 * 3600);
// Civil midnight uses the explicit feed timezone (GTFS service day starts at
// local midnight, not noon-minus-12). DST days prove the difference: noon on
// 2026-03-08 in Toronto is EDT (-4) while midnight is still EST (-5).
assert.equal(getServiceDayStart("20260329", "Europe/London"), Date.parse("2026-03-29T00:00:00Z") / 1000);
assert.equal(getServiceDayStart("20261025", "Europe/London"), Date.parse("2026-10-24T23:00:00Z") / 1000);
assert.equal(getServiceDayStart("20260405", "Australia/Sydney"), Date.parse("2026-04-04T13:00:00Z") / 1000);
assert.equal(getServiceDayStart("20261004", "Australia/Sydney"), Date.parse("2026-10-03T14:00:00Z") / 1000);
// Same service date starts at different instants per feed timezone.
assert.notEqual(
	getServiceDayStart("20260828", "Australia/Brisbane"),
	getServiceDayStart("20260828", "America/Toronto"),
);
// Day-start instants round-trip to their own service date in the same zone.
for (const [serviceDate, timeZone] of [
	["20260308", "America/Toronto"],
	["20261101", "America/Toronto"],
	["20260329", "Europe/London"],
	["20261025", "Europe/London"],
	["20260405", "Australia/Sydney"],
	["20261004", "Australia/Sydney"],
	["20260828", "Australia/Brisbane"],
]) {
	const dayStart = getServiceDayStart(serviceDate, timeZone);
	assert.equal(getServiceDate(new Date(dayStart * 1000), timeZone), serviceDate);
}
// DST gap has no exact match: 02:30 springs forward to 03:30 local.
assert.equal(getLocalISOString(new Date(parseTimeWithConfig("2026-03-08T02:30:00", "America/Toronto")), "America/Toronto"), "2026-03-08T03:30:00");
// DST overlap picks the earlier instant for 01:30.
assert.equal(getLocalISOString(new Date(parseTimeWithConfig("2026-11-01T01:30:00", "America/Toronto")), "America/Toronto"), "2026-11-01T01:30:00");
assert.ok(
	parseTimeWithConfig("2026-11-01T01:30:00", "America/Toronto") <
		parseTimeWithConfig("2026-11-01T01:45:00", "America/Toronto"),
);
// Deterministic invalid contracts: bad service dates resolve to epoch 0.
assert.equal(getServiceDayStart("not-a-date", "UTC"), 0);
assert.equal(getServiceDayStart("", "UTC"), 0);
assert.equal(parseTimeWithConfig("", "UTC"), 0);
assert.equal(parseTimeWithConfig("not-a-date", "UTC"), 0);
assert.throws(() => getServiceDate(new Date(), "Invalid/Timezone"), RangeError);
console.log("Timezone formatter reuse and DST tests passed.");
