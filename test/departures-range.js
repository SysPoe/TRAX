import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

import { createEmptyAugmentedCache, createEmptyRawCache, createRuntimeState } from "../dist/cache/factories.js";
import { resolveConfig } from "../dist/config.js";
import { entityKey } from "../dist/identity.js";
import { getDeparturesForStop, getServiceDateDeparturesForStop } from "../dist/utils/departures.js";
import { ServiceCapacity } from "../dist/utils/serviceCapacity.js";

const FEED_ID = "test";
const TIME_ZONE = "UTC";
const SERVICE_DATE = "20260828";
const NEXT_SERVICE_DATE = "20260829";

function makeConfig(plugins = []) {
	const config = resolveConfig(
		{
			id: "departure-range-test",
			name: "Departure range test",
			feeds: [
				{
					id: FEED_ID,
					staticSource: { url: "https://example.test/static.zip" },
					realtimeSources: [],
					timeZone: TIME_ZONE,
				},
			],
			modes: ["rail"],
			plugins,
		},
		{ disableTimers: true },
	);
	config.feedTimeZones.set(FEED_ID, TIME_ZONE);
	return config;
}

function makeStopTime(
	instanceId,
	serviceDate,
	time,
	stopId,
	parentId = null,
	serviceCapacity = ServiceCapacity.UNKNOWN,
) {
	return {
		_stopTime: null,
		feed_id: FEED_ID,
		trip_id: instanceId,
		passing: false,
		pickup_type: 0,
		drop_off_type: 0,
		instance_id: instanceId,
		service_date: serviceDate,
		schedule_relationship: "SCHEDULED",
		service_capacity: serviceCapacity,
		occupancy: null,
		actual_exit_side: null,
		scheduled_exit_side: null,
		actual_arrival_time: null,
		actual_departure_time: null,
		actual_stop_id: stopId,
		actual_parent_station_id: parentId,
		actual_platform_code: null,
		actual_arrival_boarding_locations: [],
		actual_departure_boarding_locations: [],
		rt_stop_updated: false,
		rt_parent_station_updated: false,
		rt_platform_code_updated: false,
		rt_arrival_updated: false,
		rt_departure_updated: false,
		scheduled_arrival_time: time,
		scheduled_departure_time: time,
		scheduled_stop_id: stopId,
		scheduled_parent_station_id: parentId,
		scheduled_platform_code: null,
		scheduled_arrival_dates: [],
		actual_arrival_dates: [],
		scheduled_arrival_date_offset: 0,
		actual_arrival_date_offset: 0,
		scheduled_departure_dates: [],
		actual_departure_dates: [],
		scheduled_departure_date_offset: 0,
		actual_departure_date_offset: 0,
		realtime: false,
		realtime_info: null,
	};
}

function trackRows(rows, counter) {
	return new Proxy(rows, {
		get(target, property, receiver) {
			if (typeof property === "string" && /^\d+$/.test(property)) counter.rowsExamined++;
			return Reflect.get(target, property, receiver);
		},
	});
}

function makeContext(stopRows, options = {}) {
	const capacityCalls = { count: 0 };
	const plugins = options.countCapacity
		? [
				{
					id: "capacity-counter",
					feedIds: [FEED_ID],
					serviceCapacity: () => {
						capacityCalls.count++;
						return ServiceCapacity.MANY_SEATS_AVAILABLE;
					},
				},
			]
		: [];
	const config = makeConfig(plugins);
	const augmented = createEmptyAugmentedCache();
	augmented.timer.disabled = true;
	const runtimeState = createRuntimeState();
	const ctx = {
		raw: createEmptyRawCache(),
		augmented,
		config,
		pluginState: new Map(),
		runtimeState,
	};
	const counter = options.counter ?? { rowsExamined: 0 };

	for (const [stopId, dates] of Object.entries(stopRows)) {
		const byDate = new Map();
		for (const [serviceDate, rows] of Object.entries(dates)) {
			runtimeState.operationalServiceDates.add(serviceDate);
			const tracked = options.track ? trackRows(rows, counter) : rows;
			byDate.set(serviceDate, tracked);
			for (const row of rows) {
				augmented.instancesRec.set(row.instance_id, {
					instance_id: row.instance_id,
					feed_id: FEED_ID,
					serviceDate,
					expressInfo: [],
				});
			}
		}
		augmented.stopDeparturesCached.set(entityKey({ feedId: FEED_ID, localId: stopId }), byDate);
	}

	return { ctx, counter, capacityCalls };
}

function makeStationStop(stopId, parentId = null, childIds = []) {
	return {
		feed_id: FEED_ID,
		stop_id: stopId,
		parent_stop_id: parentId,
		child_stop_ids: childIds,
	};
}

function ids(departures) {
	return departures.map((departure) => departure.instance_id);
}

function assertRangeResult(invoke, expectedIds, counter, totalRows, capacityCalls = null) {
	const result = invoke();
	assert.deepEqual(ids(result), expectedIds);
	assert.ok(
		counter.rowsExamined < totalRows,
		`range query examined ${counter.rowsExamined} of ${totalRows} cached rows`,
	);
	if (capacityCalls) assert.equal(capacityCalls.count, expectedIds.length);
	return result;
}

function makeUniformRows(stopId, serviceDate, count, prefix, parentId = null) {
	return Array.from({ length: count }, (_, index) => {
		const time = Math.floor(((index + 1) * 86_400) / (count + 1));
		return makeStopTime(`${prefix}-${index}`, serviceDate, time, stopId, parentId);
	});
}

function testRangeMergeAndEarlyDeduplication() {
	const parentRows = [
		...Array.from({ length: 400 }, (_, index) =>
			makeStopTime(`parent-before-${index}`, SERVICE_DATE, index * 60, "parent"),
		),
		makeStopTime("parent-first", SERVICE_DATE, 8 * 3600 + 5 * 60, "parent", null, ServiceCapacity.NOT_CALCULATED),
		makeStopTime("shared", SERVICE_DATE, 8 * 3600 + 10 * 60, "parent", null, ServiceCapacity.NOT_CALCULATED),
		makeStopTime("parent-last", SERVICE_DATE, 8 * 3600 + 20 * 60, "parent", null, ServiceCapacity.NOT_CALCULATED),
		...Array.from({ length: 400 }, (_, index) =>
			makeStopTime(`parent-after-${index}`, SERVICE_DATE, 10 * 3600 + index * 60, "parent"),
		),
	];
	const platformRows = [
		...Array.from({ length: 400 }, (_, index) =>
			makeStopTime(`platform-before-${index}`, SERVICE_DATE, index * 60, "platform", "parent"),
		),
		makeStopTime("shared", SERVICE_DATE, 8 * 3600 + 12 * 60, "platform", "parent", ServiceCapacity.NOT_CALCULATED),
		makeStopTime(
			"platform-middle",
			SERVICE_DATE,
			8 * 3600 + 15 * 60,
			"platform",
			"parent",
			ServiceCapacity.NOT_CALCULATED,
		),
		...Array.from({ length: 400 }, (_, index) =>
			makeStopTime(`platform-after-${index}`, SERVICE_DATE, 10 * 3600 + index * 60, "platform", "parent"),
		),
	];
	const counter = { rowsExamined: 0 };
	const { ctx, capacityCalls } = makeContext(
		{ parent: { [SERVICE_DATE]: parentRows }, platform: { [SERVICE_DATE]: platformRows } },
		{ track: true, counter, countCapacity: true },
	);
	const stop = makeStationStop("parent", null, ["platform"]);
	const expected = ["parent-first", "shared", "platform-middle", "parent-last"];
	const totalRows = parentRows.length + platformRows.length;

	assertRangeResult(
		() => getDeparturesForStop(stop, SERVICE_DATE, "08:00:00", "08:30:00", ctx),
		expected,
		counter,
		totalRows,
		capacityCalls,
	);
}

function testServiceDateRangeMergeAndEarlyDeduplication() {
	const parentRows = [
		...Array.from({ length: 400 }, (_, index) =>
			makeStopTime(`parent-before-${index}`, SERVICE_DATE, index * 60, "parent"),
		),
		makeStopTime("parent-first", SERVICE_DATE, 8 * 3600 + 5 * 60, "parent", null, ServiceCapacity.NOT_CALCULATED),
		makeStopTime("shared", SERVICE_DATE, 8 * 3600 + 10 * 60, "parent", null, ServiceCapacity.NOT_CALCULATED),
		makeStopTime("parent-last", SERVICE_DATE, 8 * 3600 + 20 * 60, "parent", null, ServiceCapacity.NOT_CALCULATED),
		...Array.from({ length: 400 }, (_, index) =>
			makeStopTime(`parent-after-${index}`, SERVICE_DATE, 10 * 3600 + index * 60, "parent"),
		),
	];
	const platformRows = [
		...Array.from({ length: 400 }, (_, index) =>
			makeStopTime(`platform-before-${index}`, SERVICE_DATE, index * 60, "platform", "parent"),
		),
		makeStopTime("shared", SERVICE_DATE, 8 * 3600 + 12 * 60, "platform", "parent", ServiceCapacity.NOT_CALCULATED),
		makeStopTime(
			"platform-middle",
			SERVICE_DATE,
			8 * 3600 + 15 * 60,
			"platform",
			"parent",
			ServiceCapacity.NOT_CALCULATED,
		),
		...Array.from({ length: 400 }, (_, index) =>
			makeStopTime(`platform-after-${index}`, SERVICE_DATE, 10 * 3600 + index * 60, "platform", "parent"),
		),
	];
	const counter = { rowsExamined: 0 };
	const { ctx, capacityCalls } = makeContext(
		{ parent: { [SERVICE_DATE]: parentRows }, platform: { [SERVICE_DATE]: platformRows } },
		{ track: true, counter, countCapacity: true },
	);
	const stop = makeStationStop("parent", null, ["platform"]);
	const expected = ["parent-first", "shared", "platform-middle", "parent-last"];

	assertRangeResult(
		() => getServiceDateDeparturesForStop(stop, SERVICE_DATE, 8 * 3600, 8 * 3600 + 30 * 60, ctx),
		expected,
		counter,
		parentRows.length + platformRows.length,
		capacityCalls,
	);
}

function testCrossMidnightWindows() {
	const currentRows = [
		...Array.from({ length: 500 }, (_, index) =>
			makeStopTime(`before-midnight-${index}`, SERVICE_DATE, index * 60, "station"),
		),
		makeStopTime("before-midnight", SERVICE_DATE, 23 * 3600 + 20 * 60, "station"),
		makeStopTime("current-late", SERVICE_DATE, 23 * 3600 + 40 * 60, "station"),
		makeStopTime("extended-current", SERVICE_DATE, 24 * 3600 + 10 * 60, "station"),
		makeStopTime("outside-current", SERVICE_DATE, 25 * 3600 + 30 * 60, "station"),
		...Array.from({ length: 500 }, (_, index) =>
			makeStopTime(`after-midnight-${index}`, SERVICE_DATE, 26 * 3600 + index * 60, "station"),
		),
	];
	const nextRows = [
		makeStopTime("next-early", NEXT_SERVICE_DATE, 5 * 60, "station"),
		makeStopTime("next-middle", NEXT_SERVICE_DATE, 40 * 60, "station"),
		makeStopTime("next-late", NEXT_SERVICE_DATE, 65 * 60, "station"),
		...Array.from({ length: 500 }, (_, index) =>
			makeStopTime(`next-after-${index}`, NEXT_SERVICE_DATE, 2 * 3600 + index * 60, "station"),
		),
	];
	const stop = makeStationStop("station");

	{
		const counter = { rowsExamined: 0 };
		const { ctx } = makeContext(
			{ station: { [SERVICE_DATE]: currentRows, [NEXT_SERVICE_DATE]: nextRows } },
			{ track: true, counter },
		);
		assertRangeResult(
			() => getDeparturesForStop(stop, SERVICE_DATE, "23:30:00", "25:00:00", ctx),
			["current-late", "next-early", "extended-current", "next-middle"],
			counter,
			currentRows.length + nextRows.length,
		);
	}

	{
		const counter = { rowsExamined: 0 };
		const { ctx } = makeContext({ station: { [SERVICE_DATE]: currentRows } }, { track: true, counter });
		assertRangeResult(
			() => getServiceDateDeparturesForStop(stop, SERVICE_DATE, 23.5 * 3600, 25 * 3600, ctx),
			["current-late", "extended-current"],
			counter,
			currentRows.length,
		);
	}
}

function runTests() {
	testRangeMergeAndEarlyDeduplication();
	testServiceDateRangeMergeAndEarlyDeduplication();
	testCrossMidnightWindows();
	console.log("departure range tests passed");
}

function benchmarkContext() {
	const parentRows = makeUniformRows("parent", SERVICE_DATE, 24_000, "parent");
	const platformRows = makeUniformRows("platform", SERVICE_DATE, 8_000, "platform", "parent");
	const smallRows = makeUniformRows("small", SERVICE_DATE, 1_200, "small");
	const nextParentRows = makeUniformRows("parent", NEXT_SERVICE_DATE, 24_000, "next-parent");
	const nextPlatformRows = makeUniformRows("platform", NEXT_SERVICE_DATE, 8_000, "next-platform", "parent");
	return {
		parent: { [SERVICE_DATE]: parentRows, [NEXT_SERVICE_DATE]: nextParentRows },
		platform: { [SERVICE_DATE]: platformRows, [NEXT_SERVICE_DATE]: nextPlatformRows },
		small: { [SERVICE_DATE]: smallRows },
	};
}

function runBenchmarkCase(data, definition) {
	const counter = { rowsExamined: 0 };
	const { ctx } = makeContext(data, { track: true, counter });
	const stop = makeStationStop(definition.stopId, definition.parentId, definition.childIds);
	const invoke = () =>
		definition.method === "service-date"
			? getServiceDateDeparturesForStop(stop, SERVICE_DATE, definition.startSec, definition.endSec, ctx)
			: getDeparturesForStop(stop, SERVICE_DATE, definition.start, definition.end, ctx);
	const warmup = 5;
	const iterations = 20;
	for (let i = 0; i < warmup; i++) invoke();
	counter.rowsExamined = 0;
	const started = performance.now();
	let result = [];
	for (let i = 0; i < iterations; i++) result = invoke();
	const elapsed = performance.now() - started;
	return {
		name: definition.name,
		method: definition.method,
		msPerCall: elapsed / iterations,
		rowsExamined: counter.rowsExamined / iterations,
		rowsReturned: result.length,
	};
}

function runBenchmarks() {
	const data = benchmarkContext();
	const definitions = [
		{
			name: "busy parent, 8h",
			method: "string",
			stopId: "parent",
			parentId: null,
			childIds: ["platform"],
			start: "08:00:00",
			end: "16:00:00",
			startSec: 8 * 3600,
			endSec: 16 * 3600,
		},
		{
			name: "child platform, 30m",
			method: "service-date",
			stopId: "platform",
			parentId: "parent",
			childIds: [],
			start: "08:00:00",
			end: "08:30:00",
			startSec: 8 * 3600,
			endSec: 8 * 3600 + 30 * 60,
		},
		{
			name: "small station, 8h",
			method: "string",
			stopId: "small",
			parentId: null,
			childIds: [],
			start: "08:00:00",
			end: "16:00:00",
			startSec: 8 * 3600,
			endSec: 16 * 3600,
		},
		{
			name: "busy parent, 30m",
			method: "service-date",
			stopId: "parent",
			parentId: null,
			childIds: ["platform"],
			start: "08:00:00",
			end: "08:30:00",
			startSec: 8 * 3600,
			endSec: 8 * 3600 + 30 * 60,
		},
		{
			name: "busy parent, cross-midnight",
			method: "string",
			stopId: "parent",
			parentId: null,
			childIds: ["platform"],
			start: "23:30:00",
			end: "25:00:00",
			startSec: 23.5 * 3600,
			endSec: 25 * 3600,
		},
	];

	console.log("name\tmethod\tms/call\tcached rows examined/call\trows returned");
	for (const definition of definitions) {
		const result = runBenchmarkCase(data, definition);
		console.log(
			`${result.name}\t${result.method}\t${result.msPerCall.toFixed(3)}\t${result.rowsExamined.toFixed(1)}\t${result.rowsReturned}`,
		);
	}
}

if (!process.argv.includes("--benchmark-only")) runTests();
if (!process.argv.includes("--test-only")) runBenchmarks();
