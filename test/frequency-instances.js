import assert from "node:assert/strict";
import { RouteType, TripScheduleRelationship } from "qdf-gtfs";
import { augmentTrip, getOperationalServiceDatesForTrip } from "../dist/utils/augmentedTrip.js";
import { createEmptyAugmentedCache, createEmptyRawCache, createRuntimeState } from "../dist/cache/factories.js";
import { resolveConfig } from "../dist/config.js";
import { entityKey } from "../dist/identity.js";
import { createEmptyCorridorIndex } from "../dist/utils/corridor/shapeIndex.js";
import {
	getStopDeparturesCached,
	getVehicleTripInstance,
	getRunSeries,
	setRunSeries,
	registerAugmentedTrip,
} from "../dist/cache/augmentedEntities.js";
import { refreshStaticCache } from "../dist/cache/refreshCaches.js";

const q = (feedId, localId) => entityKey({ feedId, localId });

function testContext() {
	const config = resolveConfig(
		{
			id: "frequency-instance-test",
			name: "Frequency instance test",
			feeds: [{ id: "feed", staticSource: { url: "https://example.test/static.zip" }, realtimeSources: [] }],
			modes: ["rail"],
			plugins: [],
		},
		{ progressLog: () => {}, logFunction: () => {} },
	);
	config.feedTimeZones.set("feed", "Australia/Brisbane");
	const augmented = createEmptyAugmentedCache();
	augmented.corridorIndex = createEmptyCorridorIndex(config.corridor.version);
	const ctx = {
		raw: createEmptyRawCache(),
		augmented,
		config,
		gtfs: {
			getStops: (filter = {}) => {
				const stops = [
					{ feed_id: "feed", stop_id: "a", stop_name: "A", stop_lat: -27, stop_lon: 153, parent_station: null },
					{ feed_id: "feed", stop_id: "b", stop_name: "B", stop_lat: -27, stop_lon: 153.001, parent_station: null },
				];
				return stops.filter(
					(stop) =>
						(!filter.feed_id || filter.feed_id === stop.feed_id) &&
						(!filter.stop_id || filter.stop_id === stop.stop_id),
				);
			},
			getStaticOccupancies: () => [],
		},
		pluginState: new Map(),
		runtimeState: createRuntimeState(),
	};
	ctx.raw.routesByKey.set(
		q("feed", "r"),
		{
			feed_id: "feed",
			route_id: "r",
			agency_id: null,
			route_short_name: "R",
			route_long_name: "Rail",
			route_desc: null,
			route_type: RouteType.Rail,
			route_url: null,
			route_color: null,
			route_text_color: null,
			continuous_pickup: null,
			continuous_drop_off: null,
			route_sort_order: null,
			network_id: null,
		},
	);
	for (const stop of ctx.gtfs.getStops()) ctx.raw.stopsByKey.set(q("feed", stop.stop_id), stop);
	return ctx;
}

function setupTrip(ctx, { tripId = "freq-trip", frequencies, templateStart = 21_600 }) {
	const trip = {
		feed_id: "feed",
		trip_id: tripId,
		route_id: "r",
		service_id: "daily",
		direction_id: 0,
		shape_id: null,
		trip_headsign: null,
		trip_short_name: null,
		block_id: null,
		wheelchair_accessible: null,
		bikes_allowed: null,
	};
	const stopTimes = [
		{
			feed_id: "feed",
			trip_id: tripId,
			stop_id: "a",
			stop_sequence: 1,
			arrival_time: templateStart,
			departure_time: templateStart,
			pickup_type: 0,
			drop_off_type: 0,
			shape_dist_traveled: null,
			timepoint: 1,
			continuous_pickup: null,
			continuous_drop_off: null,
		},
		{
			feed_id: "feed",
			trip_id: tripId,
			stop_id: "b",
			stop_sequence: 2,
			arrival_time: templateStart + 1_800,
			departure_time: templateStart + 1_800,
			pickup_type: 0,
			drop_off_type: 0,
			shape_dist_traveled: null,
			timepoint: 1,
			continuous_pickup: null,
			continuous_drop_off: null,
		},
	];
	ctx.augmented.rawStopTimesCache.set(q("feed", tripId), stopTimes);
	ctx.raw.frequenciesByTripKey.set(
		q("feed", tripId),
		frequencies.map((row) => ({ feed_id: "feed", trip_id: tripId, ...row })),
	);
	return trip;
}

function realtimeUpdate({ tripId, startDate, startTime, relationship }) {
	const update = {
		update_id: `update-${tripId}-${startDate}-${startTime ?? "no-start"}-${relationship}`,
		is_deleted: false,
		trip: {
			trip_id: tripId,
			route_id: "r",
			direction_id: 0,
			start_date: startDate,
			schedule_relationship: relationship,
			feed_id: "feed",
		},
		vehicle: { id: "", label: "", license_plate: "" },
		stop_time_updates: [],
		timestamp: null,
		delay: null,
		feed_id: "feed",
		source_id: "realtime",
	};
	if (startTime !== undefined) update.trip.start_time = startTime;
	return update;
}

// 1. CANCELED frequency template update with missing start_time must cancel
// the date's runs instead of being dropped.
{
	const ctx = testContext();
	const trip = setupTrip(ctx, {
		frequencies: [{ start_time: 21_600, end_time: 25_200, headway_secs: 900, exact_times: 1 }],
		templateStart: 0,
	});
	const serviceDate = "20260827";
	const canceled = realtimeUpdate({
		tripId: trip.trip_id,
		startDate: serviceDate,
		relationship: TripScheduleRelationship.CANCELED,
	});
	// No start_time key at all: date-level template cancel.
	assert.equal("start_time" in canceled.trip, false);
	const result = augmentTrip(
		trip,
		ctx,
		new Map([[q("feed", trip.trip_id), [canceled]]]),
		undefined,
		{ serviceDates: [serviceDate], realtimeDates: [serviceDate] },
	);
	const canceledRuns = result.instances.filter(
		(instance) => instance.schedule_relationship === TripScheduleRelationship.CANCELED,
	);
	const scheduledRuns = result.instances.filter(
		(instance) => instance.schedule_relationship === TripScheduleRelationship.SCHEDULED,
	);
	assert.deepEqual(
		canceledRuns.map((instance) => instance.frequency_start_time).sort((a, b) => a - b),
		[21_600, 22_500, 23_400, 24_300],
		"a date-level CANCELED without start_time must cancel every exact run for the date",
	);
	assert.equal(scheduledRuns.length, 0, "canceled runs must not leave SCHEDULED ghosts for the same date");
}

// 2. exact_times=0 headway service must not be materialized as exact discrete schedule.
{
	const ctx = testContext();
	const trip = setupTrip(ctx, {
		tripId: "headway-trip",
		frequencies: [{ start_time: 21_600, end_time: 25_200, headway_secs: 900, exact_times: 0 }],
		templateStart: 0,
	});
	const result = augmentTrip(trip, ctx, new Map(), undefined, { serviceDates: ["20260827"], realtimeDates: [] });
	const scheduledExact = result.instances.filter(
		(instance) =>
			instance.schedule_relationship === TripScheduleRelationship.SCHEDULED && instance.frequency_exact === true,
	);
	const scheduledAny = result.instances.filter(
		(instance) => instance.schedule_relationship === TripScheduleRelationship.SCHEDULED,
	);
	assert.equal(
		scheduledExact.length,
		0,
		"headway-only exact_times=0 service must not produce exact discrete SCHEDULED instances",
	);
	assert.equal(
		scheduledAny.length,
		0,
		"headway-only service must not be blindly materialized as discrete exact schedule",
	);
}

// 3. Silent 10k truncation must become an explicit bound/error.
{
	const ctx = testContext();
	const trip = setupTrip(ctx, {
		tripId: "exploding-trip",
		frequencies: [{ start_time: 0, end_time: 86_400, headway_secs: 1, exact_times: 1 }],
		templateStart: 0,
	});
	assert.throws(
		() => augmentTrip(trip, ctx, new Map(), undefined, { serviceDates: [], realtimeDates: [] }),
		/ frequency .* bound | exceeds .* frequency | too many frequency runs /i,
		"pathological frequency expansion must throw an explicit bound error instead of silently truncating",
	);
}

// 4. P0: departures must index every distinct frequency instance, not just the first.
{
	const ctx = testContext();
	const trip = setupTrip(ctx, {
		frequencies: [{ start_time: 21_600, end_time: 25_200, headway_secs: 900, exact_times: 1 }],
		templateStart: 0,
	});
	const serviceDate = "20260827";
	const aug = augmentTrip(trip, ctx, new Map(), undefined, { serviceDates: [serviceDate], realtimeDates: [serviceDate] });
	assert.equal(aug.instances.length, 4);
	const tripKey = q("feed", trip.trip_id);
	ctx.augmented.tripsRec.set(tripKey, aug);
	ctx.augmented.trips.push(aug);
	registerAugmentedTrip(ctx, aug);
	ctx.runtimeState.operationalServiceDates.add(serviceDate);
	const deps = getStopDeparturesCached(ctx, { feedId: "feed", localId: "a" }, serviceDate);
	assert.equal(deps.length, 4, `departures must index every frequency run, got ${deps.length}`);
}

// 5. P0: vehicle lookup must resolve the correct frequency run via normalized start_time.
{
	const ctx = testContext();
	const trip = setupTrip(ctx, {
		tripId: "freq-veh",
		frequencies: [{ start_time: 21_600, end_time: 25_200, headway_secs: 900, exact_times: 1 }],
		templateStart: 0,
	});
	const serviceDate = "20260827";
	const aug = augmentTrip(trip, ctx, new Map(), undefined, { serviceDates: [serviceDate], realtimeDates: [serviceDate] });
	const tripKey = q("feed", trip.trip_id);
	ctx.augmented.tripsRec.set(tripKey, aug);
	ctx.augmented.trips.push(aug);
	registerAugmentedTrip(ctx, aug);
	ctx.augmented.rawTripsRec.set(tripKey, trip);
	ctx.raw.tripsByKey.set(tripKey, trip);
	const inst = getVehicleTripInstance(ctx, {
		feed_id: "feed",
		trip: { trip_id: trip.trip_id, start_date: serviceDate, start_time: "06:15:00" },
	});
	assert.equal(inst?.frequency_start_time, 22_500, "vehicle must resolve second frequency run");
}

// 6. P0: run-series must aggregate every distinct frequency instance.
{
	const ctx = testContext();
	const trip = setupTrip(ctx, {
		tripId: "T-1689",
		frequencies: [{ start_time: 21_600, end_time: 23_400, headway_secs: 900, exact_times: 1 }],
		templateStart: 0,
	});
	const serviceDate = "20260827";
	const aug = augmentTrip(trip, ctx, new Map(), undefined, { serviceDates: [serviceDate], realtimeDates: [serviceDate] });
	aug.instances.forEach((inst, i) => {
		inst.vehicle_id = `veh-${i}`;
		inst.trip_number = "1689";
	});
	const tripKey = q("feed", trip.trip_id);
	ctx.augmented.tripsRec.set(tripKey, aug);
	ctx.augmented.trips.push(aug);
	registerAugmentedTrip(ctx, aug);
	ctx.runtimeState.operationalServiceDates.add(serviceDate);
	const rs = getRunSeries(ctx, serviceDate, "1689");
	assert.ok(
		rs.vehicle_sightings.length >= aug.instances.length,
		`run-series must index every run, got ${rs.vehicle_sightings.length} vs ${aug.instances.length}`,
	);
}

// 7. P0: non-finite bounds must yield finite bounded lookback, never Infinity/hang.
{
	const ctx = testContext();
	const trip = setupTrip(ctx, { tripId: "lookback-trip", frequencies: [], templateStart: 0 });
	const bounds = {
		feed_id: "feed",
		trip_id: trip.trip_id,
		start_time: 0,
		end_time: Number.POSITIVE_INFINITY,
		first_stop_id: "a",
		last_stop_id: "b",
	};
	const start = Date.now();
	const dates = getOperationalServiceDatesForTrip(trip, ctx, bounds);
	assert.ok(Date.now() - start < 2000, "non-finite bounds must not hang");
	assert.deepEqual(dates, [], "non-finite bounds must yield no dates with bounded lookback");
}

// 8. P1: single >10k trip must quarantine, healthy network still publishes.
{
	const feedId = "feed";
	const qcfg = resolveConfig(
		{
			id: "quarantine-test",
			name: "Quarantine",
			feeds: [{ id: feedId, staticSource: { url: "https://example.test/s.zip" }, realtimeSources: [] }],
			modes: ["rail"],
			plugins: [],
		},
		{ progressLog: () => {}, logFunction: () => {} },
	);
	qcfg.feedTimeZones.set(feedId, "Australia/Brisbane");
	const stops = [
		{ feed_id: feedId, stop_id: "a", stop_name: "A", stop_lat: -27, stop_lon: 153, parent_station: null, stop_code: null, stop_desc: null, zone_id: null, stop_url: null, location_type: null, stop_timezone: null, wheelchair_boarding: null, level_id: null, platform_code: null },
		{ feed_id: feedId, stop_id: "b", stop_name: "B", stop_lat: -27, stop_lon: 153.001, parent_station: null, stop_code: null, stop_desc: null, zone_id: null, stop_url: null, location_type: null, stop_timezone: null, wheelchair_boarding: null, level_id: null, platform_code: null },
	];
	const route = { feed_id: feedId, route_id: "r", agency_id: null, route_short_name: "R", route_long_name: "Rail", route_desc: null, route_type: RouteType.Rail, route_url: null, route_color: null, route_text_color: null, continuous_pickup: null, continuous_drop_off: null, route_sort_order: null, network_id: null };
	const healthyTrip = { feed_id: feedId, trip_id: "healthy-trip", route_id: "r", service_id: "daily", direction_id: 0, shape_id: null, trip_headsign: null, trip_short_name: null, block_id: null, wheelchair_accessible: null, bikes_allowed: null };
	const explodingTrip = { feed_id: feedId, trip_id: "exploding-trip", route_id: "r", service_id: "daily", direction_id: 0, shape_id: null, trip_headsign: null, trip_short_name: null, block_id: null, wheelchair_accessible: null, bikes_allowed: null };
	const pack = (tripIds) => {
		const strings = ["", feedId, "healthy-trip", "exploding-trip", "a", "b"];
		const idx = (s) => strings.indexOf(s);
		const t = [], sids = [], arr = [], dep = [], seq = [], feed = [];
		for (const tid of tripIds) {
			for (const [sid, sq] of [["a", 1], ["b", 2]]) {
				t.push(idx(tid)); sids.push(idx(sid)); arr.push(sq === 1 ? 0 : 600); dep.push(sq === 1 ? 0 : 600); seq.push(sq); feed.push(idx(feedId));
			}
		}
		const n = t.length;
		return { strings, tripIds: new Uint32Array(t), stopIds: new Uint32Array(sids), arrivalTimes: new Int32Array(arr), departureTimes: new Int32Array(dep), stopSequences: new Int32Array(seq), stopHeadsigns: new Uint32Array(new Array(n).fill(0xffffffff)), pickupTypes: new Uint8Array(new Array(n).fill(0)), dropOffTypes: new Uint8Array(new Array(n).fill(0)), shapeDistances: new Float64Array(new Array(n).fill(NaN)), timepoints: new Int8Array(new Array(n).fill(1)), continuousPickups: new Int8Array(new Array(n).fill(-1)), continuousDropOffs: new Int8Array(new Array(n).fill(-1)), feedIds: new Uint32Array(feed) };
	};
	const gtfs = {
		getRealtimeTripUpdates: () => [
			{ update_id: "u-healthy", is_deleted: false, trip: { trip_id: "healthy-trip", route_id: "r", direction_id: 0, start_date: "20260827", schedule_relationship: 0, feed_id: feedId }, vehicle: { id: "", label: "", license_plate: "" }, stop_time_updates: [], timestamp: 10, delay: null, feed_id: feedId, source_id: "realtime" },
			{ update_id: "u-exploding", is_deleted: false, trip: { trip_id: "exploding-trip", route_id: "r", direction_id: 0, start_date: "20260827", schedule_relationship: 0, feed_id: feedId }, vehicle: { id: "", label: "", license_plate: "" }, stop_time_updates: [], timestamp: 10, delay: null, feed_id: feedId, source_id: "realtime" },
		],
		getStops: (f = {}) => stops.filter((s) => (!f.feed_id || f.feed_id === s.feed_id) && (!f.stop_id || f.stop_id === s.stop_id)),
		getCalendars: () => [],
		getCalendarDates: () => [],
		getRoutes: () => [route],
		getTrips: () => [healthyTrip, explodingTrip],
		getTripStopTimeBounds: () => [
			{ feed_id: feedId, trip_id: "healthy-trip", start_time: 0, end_time: 600, first_stop_id: "a", last_stop_id: "b" },
			{ feed_id: feedId, trip_id: "exploding-trip", start_time: 0, end_time: 600, first_stop_id: "a", last_stop_id: "b" },
		],
		getFrequencies: () => [{ feed_id: feedId, trip_id: "exploding-trip", start_time: 0, end_time: 86_400, headway_secs: 1, exact_times: 1 }],
		getTransfers: () => [],
		getStopTimesPacked: ({ trip_ids }) => pack(trip_ids),
		getShapes: () => [],
		getStaticOccupancies: () => [],
	};
	const ctx = await refreshStaticCache(gtfs, qcfg);
	assert.ok(ctx.augmented.trips.some((t) => t.trip_id === "healthy-trip"), "healthy trip must publish despite quarantined exploding trip");
	assert.ok(!ctx.augmented.trips.some((t) => t.trip_id === "exploding-trip"), "exploding trip must be quarantined");
}

// 9. P1: duplicate same-key updates must deterministically dedupe without losing distinct runs.
for (const rel of [TripScheduleRelationship.SCHEDULED, TripScheduleRelationship.ADDED, TripScheduleRelationship.UNSCHEDULED, TripScheduleRelationship.CANCELED]) {
	const ctx = testContext();
	const trip = setupTrip(ctx, { tripId: `dedupe-${rel}`, frequencies: [], templateStart: 0 });
	const serviceDate = "20260827";
	const mk = (startTime, suffix, ts) => {
		const u = { update_id: `u-${trip.trip_id}-${serviceDate}-${startTime}-${rel}-${suffix}`, is_deleted: false, trip: { trip_id: trip.trip_id, route_id: "r", direction_id: 0, start_date: serviceDate, schedule_relationship: rel, feed_id: "feed" }, vehicle: { id: "", label: "", license_plate: "" }, stop_time_updates: [], timestamp: ts, delay: null, feed_id: "feed", source_id: "realtime" };
		if (startTime !== undefined) u.trip.start_time = startTime;
		return u;
	};
	const aug = augmentTrip(
		trip,
		ctx,
		new Map([[q("feed", trip.trip_id), [mk("10:00:00", "a", 10), mk("10:00:00", "b", 20)]]]),
		undefined,
		{ serviceDates: [serviceDate], realtimeDates: [serviceDate] },
	);
	assert.equal(aug.instances.length, 1, `duplicate ${rel} must dedupe to 1, got ${aug.instances.length}`);
	assert.equal(aug.instances[0].realtime_update.timestamp, 20, "latest timestamp must win");
	const distinct = augmentTrip(
		trip,
		ctx,
		new Map([[q("feed", trip.trip_id), [mk("10:00:00", "a", 10), mk("11:00:00", "b", 10)]]]),
		undefined,
		{ serviceDates: [], realtimeDates: [serviceDate] },
	);
	assert.equal(distinct.instances.length, 2, "distinct start_times must not collapse");
}

// 10. P1: 6:00:00 vs 06:00:00 must share one normalized identity.
{
	const ctx = testContext();
	const trip = setupTrip(ctx, { tripId: "norm-trip", frequencies: [], templateStart: 0 });
	const serviceDate = "20260827";
	const mk = (startTime, suffix, ts = 10) => {
		const u = { update_id: `u-${serviceDate}-${startTime}-${suffix}`, is_deleted: false, trip: { trip_id: trip.trip_id, route_id: "r", direction_id: 0, start_date: serviceDate, schedule_relationship: TripScheduleRelationship.SCHEDULED, feed_id: "feed" }, vehicle: { id: "", label: "", license_plate: "" }, stop_time_updates: [], timestamp: ts, delay: null, feed_id: "feed", source_id: "realtime" };
		if (startTime !== undefined) u.trip.start_time = startTime;
		return u;
	};
	const aug = augmentTrip(
		trip,
		ctx,
		new Map([[q("feed", trip.trip_id), [mk("6:00:00", "a", 10), mk("06:00:00", "b", 20)]]]),
		undefined,
		{ serviceDates: [], realtimeDates: [serviceDate] },
	);
	assert.equal(aug.instances.length, 1, `equivalent clocks must normalize, got ${aug.instances.length}`);
}

// 11. P1: run-series inner map must stay bounded with oldest eviction.
{
	const ctx = { augmented: { runSeriesCache: new Map() }, runtimeState: {} };
	for (let i = 0; i < 100; i++) {
		setRunSeries("20260827", `SERIES-${i}`, { trips: [], vehicle_sightings: [], series: `SERIES-${i}`, date: "20260827" }, ctx);
	}
	assert.ok(ctx.augmented.runSeriesCache.get("20260827").size <= 32, "inner run-series must stay bounded");
	assert.equal(ctx.augmented.runSeriesCache.get("20260827").has("SERIES-0"), false, "oldest inner entry must be evicted");
}

// 12. P1: NaN frequency bounds must not poison lookback; iteration must stay finite.
{
	const ctx = testContext();
	setupTrip(ctx, {
		tripId: "nan-trip",
		frequencies: [
			{ start_time: 0, end_time: 100, headway_secs: 10, exact_times: 1 },
			{ start_time: NaN, end_time: NaN, headway_secs: NaN, exact_times: 1 },
		],
		templateStart: 0,
	});
	const trip = { feed_id: "feed", trip_id: "nan-trip", route_id: "r", service_id: "daily", direction_id: 0, shape_id: null, trip_headsign: null, trip_short_name: null, block_id: null, wheelchair_accessible: null, bikes_allowed: null };
	const bounds = { feed_id: "feed", trip_id: "nan-trip", start_time: 0, end_time: 3600, first_stop_id: "a", last_stop_id: "b" };
	const dates = getOperationalServiceDatesForTrip(trip, ctx, bounds);
	assert.ok(Array.isArray(dates), "NaN rows must be ignored without poisoning");
}

console.log("Frequency instance tests passed.");
