import assert from "node:assert/strict";
import { test } from "node:test";
import { context, update, key, date, S, T, getServiceDayStart, entityKey } from "./fixtures/runtime-audit.mjs";
import { augmentTrip } from "../dist/utils/augmentedTrip.js";
import {
	getAugmentedTripInstance,
	getTripIdsByServiceDate,
	registerAugmentedTrip,
} from "../dist/cache/augmentedEntities.js";
import { getOnboardReachableStops } from "../dist/utils/passengerContinuations.js";
import { refreshRealtimeCache, refreshStaticCache } from "../dist/cache/refreshCaches.js";
import {
	getDeparturesForInstantWindow,
	getDeparturesForStop,
	getServiceDateDeparturesForStop,
} from "../dist/utils/departures.js";
import { parseAnyTripNswOccupancy } from "../dist/region-specific/AU/NSW/anytrip-occupancy.js";
import { createTransitAppPlugin } from "../dist/plugins/transit-app.js";
import { canonicalizeRealtimeTripUpdate, mergeSupplementalTripUpdates } from "../dist/cache/realtime.js";
import { loadServiceCalendarRules } from "../dist/utils/calendar.js";
import { addDaysToServiceDate } from "../dist/utils/time.js";
import { encodeTripInstanceId } from "../dist/identity.js";
import { TRAX } from "../dist/index.js";

function materialize(ctx, trip, updates) {
	return augmentTrip(trip, ctx, new Map([[key, updates]]), undefined, { serviceDates: [date] }).instances[0];
}

test("NO_DATA ends timing propagation, a later timed call resumes it", () => {
	const { ctx, trip } = context();
	const inst = materialize(ctx, trip, [
		update([
			{ stop_sequence: 1, stop_id: "A", departure_delay: 300 },
			{ stop_sequence: 2, stop_id: "B", schedule_relationship: S.NO_DATA },
		]),
	]);
	assert.equal(inst.stopTimes[2].actual_departure_time, 37200);
	assert.equal(inst.stopTimes[1].realtime, false);
	assert.equal(inst.stopTimes[2].realtime, false);
	const resumed = materialize(ctx, trip, [
		update([
			{ stop_sequence: 1, stop_id: "A", departure_delay: 300 },
			{ stop_sequence: 2, stop_id: "B", schedule_relationship: S.NO_DATA },
			{ stop_sequence: 3, stop_id: "C", departure_delay: 60 },
		]),
	]);
	assert.equal(resumed.stopTimes[2].actual_departure_time, 37260);
	assert.equal(resumed.stopTimes[2].realtime, true);
});

test("NO_DATA retains scheduled boarding and alighting on the same trip", () => {
	for (const noDataAt of ["A", "B"]) {
		const { ctx, trip } = context();
		const inst = materialize(ctx, trip, [
			update([{ stop_sequence: noDataAt === "A" ? 1 : 2, stop_id: noDataAt, schedule_relationship: S.NO_DATA }]),
		]);
		const augmented = { ...trip, instances: [inst], scheduledStartServiceDates: [date] };
		ctx.augmented.tripsRec.set(key, augmented);
		registerAugmentedTrip(ctx, augmented);
		assert.deepEqual(
			getOnboardReachableStops(ctx, inst.instance_id, { stopIds: ["A"], departureTime: 36000 }).map(
				(s) => s.stop_id,
			),
			["B", "C"],
		);
	}
});

test("absolute event time wins over conflicting delay for arrival and departure", () => {
	const { ctx, trip } = context();
	const epoch = getServiceDayStart(date, "UTC");
	const inst = materialize(ctx, trip, [
		update([
			{
				stop_sequence: 1,
				stop_id: "A",
				arrival_delay: 300,
				departure_delay: 300,
				arrival_time: epoch + 36060,
				departure_time: epoch + 36060,
			},
		]),
	]);
	assert.equal(inst.stopTimes[0].actual_arrival_time, 36060);
	assert.equal(inst.stopTimes[0].actual_departure_time, 36060);
	assert.equal(inst.stopTimes[1].actual_departure_time, 36660);
});

test("arrival-only delay propagates, and missing predictions before the first anchor remain scheduled", () => {
	const { ctx, trip } = context();
	const inst = materialize(ctx, trip, [update([{ stop_sequence: 2, stop_id: "B", arrival_delay: 300 }])]);
	assert.equal(inst.stopTimes[0].realtime, false);
	assert.equal(inst.stopTimes[1].actual_departure_time, 36900);
	assert.equal(inst.stopTimes[2].actual_departure_time, 37500);
});

test("trip-level delay propagates until an explicit event replaces it, including zero", () => {
	const { ctx, trip } = context();
	const inst = materialize(ctx, trip, [
		update([{ stop_sequence: 3, stop_id: "C", departure_delay: 0, arrival_delay: 0 }], { delay: 300 }),
	]);
	assert.deepEqual(
		inst.stopTimes.map((s) => s.actual_departure_time),
		[36300, 36900, 37200],
	);
});

test("Transit fills a missing agency call inside one dated instance, preserving agency predictions", async () => {
	const realNow = Date.now,
		now = Date.parse("2026-10-03T10:00:00Z");
	Date.now = () => now;
	try {
		for (const startTime of ["", "10:00:00"]) {
			const discovery = {
				routes: [
					{
						feed_id: 1,
						global_route_id: 42,
						realtime_recipe_id: 9,
						short_name: "R",
						long_name: "Rail",
						itineraries: [
							{
								itineraries: [{ realTimeRouteIds: ["R"] }],
								stops_by_itinerary_id_map: { 0: [{ stop_stable_id: 44, raw_stop_id: "B" }] },
							},
						],
					},
				],
			};
			const plugin = createTransitAppPlugin({
				installationId: "12345678-1234-1234-1234-123456789012",
				apiKey: "test-key",
				feeds: [{ feedId: "rail", transitFeedId: 1, latitude: 43, longitude: -79 }],
				client: {
					searchRoutes: async () => discovery,
					vehicles: async () => [],
					predictions: async (routes) => [
						{
							route: routes[0],
							stopId: "B",
							prediction: {
								tripId: "trip",
								departureAt: now + 660000,
								scheduledDepartureAt: now + 600000,
								observedAt: now,
							},
						},
					],
				},
			});
			const { ctx, gtfs } = context([plugin]);
			const official = update([{ stop_sequence: 1, stop_id: "A", arrival_delay: 300, departure_delay: 300 }], {
				timestamp: now / 1000 - 20,
				startTime,
			});
			gtfs.getRealtimeTripUpdates = () => [official];
			await plugin.beforeRealtime(ctx);
			await refreshRealtimeCache(gtfs, ctx.config, ctx);
			const dated = ctx.augmented.tripsRec.get(key).instances.filter((i) => i.serviceDate === date);
			assert.equal(dated.length, 1);
			assert.equal(dated[0].stopTimes[0].actual_departure_time, 36300);
			assert.equal(dated[0].stopTimes[1].actual_departure_time, 36660);
		}
	} finally {
		Date.now = realNow;
	}
});

test("timestamp-only competing source reversals rebuild the selected prediction", async () => {
	const { ctx, gtfs } = context();
	const first = update([{ stop_sequence: 1, stop_id: "A", departure_delay: 300 }], {
		id: "first",
		source: "one",
		timestamp: 1,
	});
	const second = update([{ stop_sequence: 1, stop_id: "A", departure_delay: 60 }], {
		id: "second",
		source: "two",
		timestamp: 2,
	});
	gtfs.getRealtimeTripUpdates = () => [first, second];
	await refreshRealtimeCache(gtfs, ctx.config, ctx);
	assert.equal(
		ctx.augmented.tripsRec.get(key).instances.find((i) => i.serviceDate === date).stopTimes[0]
			.actual_departure_time,
		36060,
	);
	first.timestamp = 3;
	await refreshRealtimeCache(gtfs, ctx.config, ctx);
	assert.equal(
		ctx.augmented.tripsRec.get(key).instances.find((i) => i.serviceDate === date).stopTimes[0]
			.actual_departure_time,
		36300,
	);
});

test("mixed arrival and departure producers retain separate observation identities", () => {
	const { ctx, trip } = context();
	const now = Date.now() / 1000;
	const agency = update([{ stop_sequence: 1, stop_id: "A", arrival_delay: 30 }], { timestamp: now - 30 });
	const transit = update([{ stop_id: "A", departure_delay: 60 }], { source: "transit-app", timestamp: now });
	const merged = mergeSupplementalTripUpdates([agency, transit], ctx);
	assert.equal(merged.length, 1);
	const inst = materialize(ctx, trip, merged),
		stop = inst.stopTimes[0];
	assert.equal(stop.actual_arrival_time, 36030);
	assert.equal(stop.actual_departure_time, 36060);
	assert.deepEqual(stop.realtime_info.arrival_observation, { source_id: "agency", timestamp: now - 30 });
	assert.deepEqual(stop.realtime_info.departure_observation, { source_id: "transit-app", timestamp: now });
	assert.equal(inst.stopTimes[1].realtime_info.arrival_observation.source_id, "transit-app");
});

test("supplemental merge preserves feed and frequency-run identity", () => {
	const { ctx, trip } = context();
	ctx.raw.frequenciesByTripKey.set(key, [
		{ feed_id: "rail", trip_id: "trip", exact_times: 1, start_time: 36000, end_time: 37200, headway_secs: 600 },
	]);
	const agency = update([{ stop_sequence: 1, stop_id: "A", departure_delay: 300 }], { startTime: "10:00:00" });
	const same = update([{ stop_sequence: 1, stop_id: "A", departure_delay: 60 }], {
		source: "transit-app",
		startTime: "10:00",
	});
	const other = update([{ stop_sequence: 1, stop_id: "A", departure_delay: 120 }], {
		source: "transit-app",
		startTime: "10:10:00",
	});
	const anotherFeed = {
		...same,
		feed_id: "other",
		trip: { ...same.trip, feed_id: "other" },
		stop_time_updates: same.stop_time_updates.map((s) => ({ ...s, feed_id: "other" })),
	};
	const merged = mergeSupplementalTripUpdates([agency, same, other, anotherFeed], ctx);
	assert.equal(merged.length, 3);
	const instances = augmentTrip(trip, ctx, new Map([[key, merged.filter((u) => u.feed_id === "rail")]]), undefined, {
		serviceDates: [date],
	}).instances;
	assert.equal(
		instances.find((i) => i.realtime_update?.trip.start_time === "10:00:00").stopTimes[0].actual_departure_time,
		36300,
	);
	assert.equal(
		instances.find((i) => i.realtime_update?.trip.start_time === "10:10:00").stopTimes[0].actual_departure_time,
		36720,
	);
	assert.equal(merged.find((u) => u.feed_id === "other").source_id, "transit-app");
});

test("metadata-only observations refresh event ages without re-augmenting predictions", async () => {
	const { ctx, gtfs } = context();
	const old = Date.now() / 1000 - 60;
	let current = update([{ stop_sequence: 1, stop_id: "A", departure_delay: 60 }], { timestamp: old });
	gtfs.getRealtimeTripUpdates = () => [current];
	await refreshRealtimeCache(gtfs, ctx.config, ctx);
	const first = ctx.augmented.tripsRec.get(key).instances.find((i) => i.serviceDate === date);
	current = { ...current, timestamp: old + 30 };
	await refreshRealtimeCache(gtfs, ctx.config, ctx);
	const next = ctx.augmented.tripsRec.get(key).instances.find((i) => i.serviceDate === date);
	assert.equal(next, first);
	assert.equal(next.stopTimes[0].realtime_info.timestamp, old + 30);
	assert.equal(next.stopTimes[0].realtime_info.departure_observation.timestamp, old + 30);
	assert.equal(next.stopTimes[1].realtime_info.arrival_observation.timestamp, old + 30);
});

test("partial transport success renews only the successful source observation", async () => {
	const { ctx, gtfs } = context();
	ctx.config.network.feeds[0].realtimeSources.push({
		id: "other",
		targetFeedId: "rail",
		kind: "trip-updates",
		source: { url: "https://example.test/other" },
	});
	let failAgency = false;
	gtfs.updateRealtimeFromUrl = async (sources) =>
		sources.map((s) => ({
			id: s.id,
			ok: !failAgency || s.id === "other",
			error: failAgency && s.id === "agency" ? "offline" : undefined,
		}));
	const runtime = new TRAX(ctx.config.network, { logFunction() {}, progressLog() {} });
	runtime.gtfs = gtfs;
	runtime.config = ctx.config;
	runtime.ctx = ctx;
	assert.equal(await runtime.updateRealtime(), true);
	const old = runtime.getRealtimeObservationTime({ source_id: "agency", timestamp: null });
	assert.ok(old);
	failAgency = true;
	assert.equal(await runtime.updateRealtime(), true);
	assert.equal(runtime.getRealtimeObservationTime({ source_id: "agency", timestamp: null }), old);
	assert.ok(runtime.getRealtimeObservationTime({ source_id: "other", timestamp: null }));
	assert.equal(runtime.getSourceHealth().find((s) => s.id === "agency").state, "error");
});

test("failed realtime cycle preserves source observation age and reports no successful completion", async () => {
	const { ctx, gtfs } = context();
	const old = Date.now() / 1000 - 3600;
	const retained = update([{ stop_sequence: 1, stop_id: "A", departure_delay: 300 }], { timestamp: old });
	gtfs.getRealtimeTripUpdates = () => [retained];
	gtfs.updateRealtimeFromUrl = async (sources) => sources.map((s) => ({ id: s.id, ok: false, error: "offline" }));
	await refreshRealtimeCache(gtfs, ctx.config, ctx);
	const runtime = new TRAX(ctx.config.network, { logFunction() {}, progressLog() {} });
	runtime.gtfs = gtfs;
	runtime.config = ctx.config;
	runtime.ctx = ctx;
	assert.equal(await runtime.updateRealtime(), false);
	assert.equal(runtime.getSourceHealth().find((s) => s.id === "agency").state, "error");
	assert.equal(runtime.getRealtimeObservationTime(retained), new Date(old * 1000).toISOString());
});

test("derived after-hooks do not turn failed source observation into a successful cycle", async () => {
	for (const failBefore of [false, true]) {
		const plugin = {
			id: "derived",
			feedIds: ["rail"],
			capabilities: ["supplemental-realtime"],
			afterRealtime() {},
			...(failBefore
				? {
						beforeRealtime() {
							throw new Error("offline");
						},
					}
				: {}),
		};
		const { ctx, gtfs } = context([plugin]);
		gtfs.updateRealtimeFromUrl = async (sources) => sources.map((s) => ({ id: s.id, ok: false, error: "offline" }));
		const runtime = new TRAX(ctx.config.network, { logFunction() {}, progressLog() {} });
		runtime.gtfs = gtfs;
		runtime.config = ctx.config;
		runtime.ctx = ctx;
		assert.equal(await runtime.updateRealtime(), false);
		if (failBefore)
			assert.equal(runtime.getSourceHealth().find((s) => s.id === "derived:supplemental").state, "error");
	}
});

test("stopping timers during pending callbacks prevents both loops from restarting", async () => {
	for (const kind of ["realtime", "static"]) {
		const { ctx } = context();
		const runtime = new TRAX(ctx.config.network, { logFunction() {}, progressLog() {} });
		const realSet = globalThis.setTimeout,
			realClear = globalThis.clearTimeout;
		const scheduled = new Map();
		let next = 0,
			release;
		globalThis.setTimeout = (callback, ms) => {
			const id = ++next;
			scheduled.set(id, { callback, ms });
			return id;
		};
		globalThis.clearTimeout = (id) => scheduled.delete(id);
		try {
			runtime.updateRealtime =
				kind === "static"
					? async () => true
					: () =>
							new Promise((resolve) => {
								release = () => resolve(true);
							});
			runtime.refreshStatic = () =>
				new Promise((resolve) => {
					release = resolve;
				});
			runtime.startAutoRefresh(true, 60, 86400);
			const [id, { callback }] = [...scheduled].find(([, v]) => v.ms === (kind === "realtime" ? 60 : 86400));
			scheduled.delete(id);
			const running = callback();
			runtime.clearIntervals();
			release();
			await running;
			assert.equal(scheduled.size, 0);
		} finally {
			runtime.clearIntervals();
			globalThis.setTimeout = realSet;
			globalThis.clearTimeout = realClear;
		}
	}
});

test("one missing dated trip does not materialize the network, one valid trip only materializes itself", () => {
	const { ctx, trip, rows } = context();
	for (let i = 0; i < 5; i++) {
		const other = { ...trip, trip_id: "other" + i };
		const k = entityKey({ feedId: "rail", localId: other.trip_id });
		ctx.raw.tripsByKey.set(k, other);
		ctx.augmented.rawTripsRec.set(k, other);
		ctx.augmented.rawStopTimesCache.set(
			k,
			rows.map((r) => ({ ...r, trip_id: other.trip_id })),
		);
	}
	loadServiceCalendarRules(ctx, [
		{
			feed_id: "rail",
			service_id: "daily",
			monday: 1,
			tuesday: 1,
			wednesday: 1,
			thursday: 1,
			friday: 1,
			saturday: 1,
			sunday: 1,
			start_date: "20260101",
			end_date: "20261231",
		},
	]);
	const encoded = (localId) =>
		encodeTripInstanceId({
			networkId: "audit",
			feedId: "rail",
			kind: "trip",
			localId,
			serviceDate: "20261101",
			realtimeStartTime: "",
		});
	assert.equal(getAugmentedTripInstance(ctx, encoded("missing")), null);
	assert.equal(ctx.augmented.instancesRec.size, 0);
	assert.ok(getAugmentedTripInstance(ctx, encoded("trip")));
	assert.equal(ctx.augmented.instancesRec.size, 1);
	// A targeted trip materialization must not mark the whole date complete.
	getTripIdsByServiceDate(ctx, "20261101");
	assert.equal([...ctx.augmented.instancesRec.values()].filter((i) => i.serviceDate === "20261101").length, 6);
});

test("calendar range caches remain bounded as dated requests exceed lazy retention", () => {
	const { ctx } = context();
	loadServiceCalendarRules(ctx, [
		{
			feed_id: "rail",
			service_id: "daily",
			monday: 1,
			tuesday: 1,
			wednesday: 1,
			thursday: 1,
			friday: 1,
			saturday: 1,
			sunday: 1,
			start_date: "20260101",
			end_date: "20261231",
		},
	]);
	for (let i = 0; i < 80; i++) getTripIdsByServiceDate(ctx, addDaysToServiceDate(date, i));
	assert.ok(ctx.runtimeState.serviceDates.size <= 64);
	assert.equal(ctx.runtimeState.lazyServiceDates.size, 8);
});

test("scheduled descriptors infer a unique operating date but reject frequency and ambiguous runs", () => {
	const { ctx } = context();
	const omitted = update(
		[{ stop_sequence: 1, stop_id: "A", departure_time: getServiceDayStart(date, "UTC") + 36300 }],
		{ timestamp: getServiceDayStart(date, "UTC") + 36000 },
	);
	omitted.trip.start_date = null;
	assert.equal(canonicalizeRealtimeTripUpdate(omitted, ctx).trip.start_date, date);
	ctx.raw.frequenciesByTripKey.set(key, [{ exact_times: 1, start_time: 36000, end_time: 37200, headway_secs: 600 }]);
	assert.equal(canonicalizeRealtimeTripUpdate(omitted, ctx).trip.start_date, null);
	ctx.raw.frequenciesByTripKey.delete(key);
	ctx.gtfs.getServiceDatesByTrip = () => ["20261002", date];
	ctx.runtimeState.serviceDates.clear();
	ctx.raw.tripStopTimeBoundsByKey.set(key, { start_time: 0, end_time: 172800 });
	assert.equal(canonicalizeRealtimeTripUpdate(omitted, ctx).trip.start_date, null);
});

test("service-date inference uses the previous service day for after-midnight calls", () => {
	const { ctx } = context();
	ctx.raw.tripStopTimeBoundsByKey.set(key, { start_time: 88200, end_time: 90000 });
	const omitted = update(
		[{ stop_sequence: 1, stop_id: "A", departure_time: getServiceDayStart(date, "UTC") + 88800 }],
		{ timestamp: getServiceDayStart(date, "UTC") + 88800 },
	);
	omitted.trip.start_date = null;
	assert.equal(canonicalizeRealtimeTripUpdate(omitted, ctx).trip.start_date, date);
});

test("stale late and early estimates use scheduled window boundaries and ordering without changing cached rows", () => {
	const { ctx, trip, rows } = context();
	const now = Date.parse("2026-10-03T10:00:00Z");
	const originalNow = Date.now;
	Date.now = () => now;
	try {
		ctx.runtimeState.operationalServiceDates.add(date);
		for (const [id, offset, delay, age] of [
			["late", 0, 3600, 600],
			["early", 300, -3600, 600],
			["fresh", 600, 300, 60],
		]) {
			const raw = { ...trip, trip_id: id },
				tripKey = entityKey({ feedId: "rail", localId: id });
			ctx.raw.tripsByKey.set(tripKey, raw);
			ctx.augmented.rawTripsRec.set(tripKey, raw);
			ctx.augmented.rawStopTimesCache.set(
				tripKey,
				rows.map((r) => ({
					...r,
					trip_id: id,
					arrival_time: r.arrival_time + offset,
					departure_time: r.departure_time + offset,
				})),
			);
			const realtime = update([{ stop_sequence: 1, stop_id: "A", departure_delay: delay }], {
				timestamp: now / 1000 - age,
			});
			realtime.trip.trip_id = id;
			const augmented = augmentTrip(raw, ctx, new Map([[tripKey, [realtime]]]), undefined, {
				serviceDates: [date],
			});
			ctx.augmented.tripsRec.set(tripKey, augmented);
			registerAugmentedTrip(ctx, augmented);
		}
		const stop = ctx.augmented.stopsRec.get(entityKey({ feedId: "rail", localId: "A" })),
			epoch = getServiceDayStart(date, "UTC");
		const expected = ["late", "early", "fresh"];
		assert.deepEqual(
			getDeparturesForInstantWindow(stop, epoch + 35940, epoch + 36960, ctx).map((r) => r.trip_id),
			expected,
		);
		assert.deepEqual(
			getDeparturesForStop(stop, date, "09:59:00", "10:16:00", ctx).map((r) => r.trip_id),
			expected,
		);
		assert.deepEqual(
			getServiceDateDeparturesForStop(stop, date, 35940, 36960, ctx).map((r) => r.trip_id),
			expected,
		);
		const original = ctx.augmented.tripsRec.get(entityKey({ feedId: "rail", localId: "late" })).instances[0]
			.stopTimes[0];
		assert.equal(original.actual_departure_time, 39600);
	} finally {
		Date.now = originalNow;
	}
});

test("five-minute prediction boundary and missing-timestamp source ages match window selection", () => {
	const { ctx, trip } = context(),
		epoch = getServiceDayStart(date, "UTC"),
		now = (epoch + 36000) * 1000,
		originalNow = Date.now;
	Date.now = () => now;
	try {
		ctx.runtimeState.operationalServiceDates.add(date);
		const realtime = update([{ stop_sequence: 1, stop_id: "A", departure_delay: 3600 }], {
			timestamp: now / 1000 - 300,
		});
		const augmented = augmentTrip(trip, ctx, new Map([[key, [realtime]]]), undefined, { serviceDates: [date] });
		ctx.augmented.tripsRec.set(key, augmented);
		registerAugmentedTrip(ctx, augmented);
		const stop = ctx.augmented.stopsRec.get(entityKey({ feedId: "rail", localId: "A" }));
		assert.equal(getDeparturesForInstantWindow(stop, epoch + 39599, epoch + 39601, ctx).length, 1);
		Date.now = () => now + 1;
		assert.equal(getDeparturesForInstantWindow(stop, epoch + 35999, epoch + 36001, ctx).length, 1);
		for (const row of augmented.instances[0].stopTimes) {
			if (row.realtime_info) {
				row.realtime_info.timestamp = null;
				if (row.realtime_info.departure_observation) row.realtime_info.departure_observation.timestamp = null;
			}
		}
		ctx.getRealtimeObservationTime = () => new Date(now - 600000).toISOString();
		assert.equal(getDeparturesForInstantWindow(stop, epoch + 35999, epoch + 36001, ctx).length, 1);
	} finally {
		Date.now = originalNow;
	}
});

test("initial static construction infers a scheduled update date after loading calendar and bounds", async () => {
	const { ctx, gtfs, trip, route } = context();
	const now = Date.now() / 1000;
	const descriptor = update(
		[{ stop_sequence: 1, stop_id: "A", departure_time: getServiceDayStart(date, "UTC") + 36300 }],
		{ timestamp: now },
	);
	descriptor.trip.start_date = null;
	Object.assign(gtfs, {
		getRealtimeTripUpdates: () => [descriptor],
		getRoutes: () => [route],
		getTrips: () => [trip],
		getCalendars: () => [
			{
				feed_id: "rail",
				service_id: "daily",
				monday: 1,
				tuesday: 1,
				wednesday: 1,
				thursday: 1,
				friday: 1,
				saturday: 1,
				sunday: 1,
				start_date: date,
				end_date: date,
			},
		],
		getCalendarDates: () => [],
		getTripStopTimeBounds: () => [{ feed_id: "rail", trip_id: "trip", start_time: 36000, end_time: 37200 }],
		getFrequencies: () => [],
		getShapesPacked: () => ({
			feed_ids: [],
			shape_ids: [],
			route_ids: [],
			lats: new Float64Array(),
			lons: new Float64Array(),
			sequences: new Int32Array(),
			distances: new Float64Array(),
		}),
		getShapes: () => [],
	});
	const built = await refreshStaticCache(gtfs, ctx.config);
	assert.equal(built.augmented.tripUpdatesCache.get(key)[0].trip.start_date, date);
	assert.equal(
		built.augmented.tripsRec.get(key).instances.find((i) => i.serviceDate === date).stopTimes[0]
			.actual_departure_time,
		36300,
	);
});

test("AnyTrip occupancy accepts valid NOT_BOARDABLE and NO_DATA statuses while rejecting unknown values", () => {
	const payload = {
		header: { timestamp: 1 },
		response: {
			tripInstance: { trip: { id: "au2:st:trip" }, startDate: date },
			realtimePattern: [{ stopSequence: 1, departure: { occupancy: [7, 8, 9, -1, 1.5, "8"] } }],
		},
	};
	assert.deepEqual(
		parseAnyTripNswOccupancy(payload, { feedId: "nsw-sydney-trains", tripId: "trip", serviceDate: date })[0]
			?.statuses,
		[7, 8],
	);
});

test("QRT background publication advances its observation revision only after success and retains age through failures/static rebuild", async () => {
	const { ctx } = context();
	ctx.config.network.plugins.push({ id: "au-seq", feedIds: ["rail"], capabilities: ["supplemental-realtime"] });
	ctx.augmented.railStations = [...ctx.raw.stopsByKey.values()];
	const { refreshQRTTrainsInBackground, retainStaticRefreshState } = await import("../dist/cache/refreshCaches.js");
	const { getSeqState } = await import("../dist/plugins/seq-state.js");
	const { seqPlugin } = await import("../dist/plugins/seq.js");
	const originalFetch = globalThis.fetch,
		originalSet = globalThis.setTimeout,
		originalNow = Date.now;
	let now = Date.parse("2026-10-04T00:00:00Z");
	Date.now = () => now;
	const serviceLines = {
		ServiceLines: [
			{
				ServiceLineName: "Spirit",
				Directions: [{ DirectionName: "North", Services: [{ ServiceId: "301", ServiceDate: "20261004" }] }],
			},
		],
	};
	const services = [
		{ Title: "Q301 Service", qrt_Direction: "North", qrt_ServiceLine: "Spirit", ServiceDate: "20261004" },
	];
	const service = {
		Success: true,
		ServiceId: "301",
		TrainMovements: ["A", "B"].map((name, i) => ({
			PlaceName: name,
			PlaceCode: name,
			PlannedArrival: `2026-10-04T10:${i ? "10" : "00"}:00`,
			PlannedDeparture: `2026-10-04T10:${i ? "10" : "00"}:00`,
			ActualArrival: `2026-10-04T10:${i ? "15" : "05"}:00`,
			ActualDeparture: `2026-10-04T10:${i ? "15" : "05"}:00`,
		})),
	};
	const response = (value) =>
		new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
	try {
		globalThis.fetch = async (input) =>
			response(
				String(input).includes("/AllServices")
					? serviceLines
					: String(input).includes("/GetService")
						? service
						: services,
			);
		refreshQRTTrainsInBackground(ctx);
		await ctx.augmented.qrtRefreshInFlight;
		const first = seqPlugin.api(ctx).getQrtObservation();
		assert.equal(first.observedAt, new Date(now).toISOString());
		assert.equal(first.revision, 1);
		assert.equal(getSeqState(ctx).qrtTrains[0].observedAt, first.observedAt);
		assert.equal(getSeqState(ctx).qrtTrains[0].stops[0].departureDelaySeconds, 300);
		now += 360000;
		globalThis.fetch = async () => {
			throw new Error("QRT fixture offline");
		};
		globalThis.setTimeout = (callback) => {
			queueMicrotask(callback);
			return { unref() {} };
		};
		refreshQRTTrainsInBackground(ctx);
		await ctx.augmented.qrtRefreshInFlight;
		assert.deepEqual(seqPlugin.api(ctx).getQrtObservation(), first);
		const retained = retainStaticRefreshState(ctx);
		assert.equal(retained.qrtObservedAt, first.observedAt);
		assert.equal(retained.qrtRevision, first.revision);
		globalThis.fetch = async (input) =>
			response(
				String(input).includes("/AllServices")
					? serviceLines
					: String(input).includes("/GetService")
						? { Success: false }
						: services,
			);
		refreshQRTTrainsInBackground(ctx);
		await ctx.augmented.qrtRefreshInFlight;
		assert.deepEqual(
			seqPlugin.api(ctx).getQrtObservation(),
			first,
			"failed per-service tracking cannot publish a fresh empty snapshot",
		);
		assert.equal(getSeqState(ctx).qrtObservedAt, first.observedAt);
		assert.equal(getSeqState(ctx).qrtTrains[0].observedAt, first.observedAt);
	} finally {
		globalThis.fetch = originalFetch;
		globalThis.setTimeout = originalSet;
		Date.now = originalNow;
	}
});
