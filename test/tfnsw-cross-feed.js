import assert from "node:assert/strict";
import { resolveConfig, getPlaceForStation } from "../dist/config.js";
import { createEmptyAugmentedCache, createEmptyRawCache, createRuntimeState } from "../dist/cache/factories.js";
import { entityKey, encodeTripInstanceId } from "../dist/identity.js";
import {
	buildTfnswCrossFeedIndex,
	resolveTfnswCanonicalInstanceId,
	getTfnswCrossFeedPair,
	getTfnswCanonicalTripInstance,
	expandTfnswChangedTripKeys,
	reconcileTfnswDepartures,
	normalizeTfnswRunNumber,
	TFNSW_SYDNEY_TRAINS_FEED_ID,
	TFNSW_TRAINLINK_FEED_ID,
} from "../dist/region-specific/AU/NSW/tfnsw-cross-feed.js";
import { getAugmentedTripInstance } from "../dist/cache/augmentedEntities.js";

const SYD = TFNSW_SYDNEY_TRAINS_FEED_ID;
const TL = TFNSW_TRAINLINK_FEED_ID;
const NETWORK_ID = "tfnsw-cross-feed-test";
const SERVICE_DATE = "20260822";
const OTHER_DATE = "20260823";

function makeConfig() {
	const config = resolveConfig(
		{
			id: NETWORK_ID,
			name: "TfNSW cross-feed test",
			feeds: [
				{ id: SYD, staticSource: { url: "https://example.test/syd.zip" }, realtimeSources: [] },
				{ id: TL, staticSource: { url: "https://example.test/tl.zip" }, realtimeSources: [] },
			],
			modes: ["rail"],
			plugins: [],
			places: [
				{
					id: "sydney-central",
					name: "Sydney Central",
					members: [
						{ feedId: SYD, localId: "200060" },
						{ feedId: TL, localId: "200060" },
					],
				},
				{
					id: "hilldale",
					name: "Hilldale",
					members: [
						{ feedId: SYD, localId: "242040" },
						{ feedId: TL, localId: "242040" },
					],
				},
				{
					id: "dungog",
					name: "Dungog",
					members: [
						{ feedId: SYD, localId: "242010" },
						{ feedId: TL, localId: "242010" },
					],
				},
				{
					id: "maitland",
					name: "Maitland",
					members: [
						{ feedId: SYD, localId: "242020" },
						{ feedId: TL, localId: "242020" },
					],
				},
			],
		},
		{ progressLog: () => {}, logFunction: () => {} },
	);
	config.feedTimeZones.set(SYD, "Australia/Sydney");
	config.feedTimeZones.set(TL, "Australia/Sydney");
	return config;
}

function makeCtx() {
	const config = makeConfig();
	return {
		raw: createEmptyRawCache(),
		augmented: createEmptyAugmentedCache(),
		config,
		pluginState: new Map(),
		runtimeState: createRuntimeState(),
	};
}

function toSecs(h, m) {
	return h * 3600 + m * 60;
}

function makeStopTime({
	feedId,
	tripId,
	instanceId,
	serviceDate,
	station,
	time,
	seq,
	delaySecs = null,
	realtime = false,
}) {
	const scheduled = time;
	const actual = delaySecs != null ? time + delaySecs : time;
	return {
		_stopTime: { stop_sequence: seq },
		feed_id: feedId,
		trip_id: tripId,
		passing: false,
		pickup_type: 0,
		drop_off_type: 0,
		instance_id: instanceId,
		service_date: serviceDate,
		schedule_relationship: "SCHEDULED",
		service_capacity: 0,
		occupancy: null,
		actual_exit_side: null,
		scheduled_exit_side: null,
		actual_arrival_time: actual,
		actual_departure_time: actual,
		actual_stop_id: station,
		actual_parent_station_id: station,
		actual_platform_code: null,
		actual_arrival_boarding_locations: [],
		actual_departure_boarding_locations: [],
		rt_stop_updated: false,
		rt_parent_station_updated: false,
		rt_platform_code_updated: false,
		rt_arrival_updated: realtime,
		rt_departure_updated: realtime,
		scheduled_arrival_time: scheduled,
		scheduled_departure_time: scheduled,
		scheduled_stop_id: station,
		scheduled_parent_station_id: station,
		scheduled_platform_code: null,
		scheduled_arrival_dates: [serviceDate],
		actual_arrival_dates: [serviceDate],
		scheduled_arrival_date_offset: 0,
		actual_arrival_date_offset: 0,
		scheduled_departure_dates: [serviceDate],
		actual_departure_dates: [serviceDate],
		scheduled_departure_date_offset: 0,
		actual_departure_date_offset: 0,
		...(realtime
			? {
					realtime: true,
					realtime_info: {
						delay_secs: delaySecs ?? 0,
						delay_string: "late",
						delay_class: "late",
						schedule_relationship: "SCHEDULED",
						propagated: false,
						rt_start_date: serviceDate,
					},
				}
			: { realtime: false, realtime_info: null }),
	};
}

function addTrip(ctx, { feedId, tripId, runNumber, serviceDate, calls, realtimeDelays = {} }) {
	const instanceId = encodeTripInstanceId({
		networkId: NETWORK_ID,
		feedId,
		kind: "trip",
		localId: tripId,
		serviceDate,
		realtimeStartTime: "",
	});
	const stopTimes = calls.map((call, index) => {
		const delay = realtimeDelays[call.station] ?? null;
		return makeStopTime({
			feedId,
			tripId,
			instanceId,
			serviceDate,
			station: call.station,
			time: call.time,
			seq: call.seq ?? index + 1,
			delaySecs: delay,
			realtime: delay != null,
		});
	});
	// Wire instance/stopTime back-references expected by departures mapping.
	for (const st of stopTimes) {
		st.instance_id = instanceId;
		st.service_date = serviceDate;
	}
	const instance = {
		feed_id: feedId,
		trip_id: tripId,
		instance_id: instanceId,
		serviceDate,
		schedule_relationship: "SCHEDULED",
		stopTimes,
		realtime_update: null,
		expressInfo: [],
		vehicle_model: null,
		vehicle_id: null,
		passenger_cars: null,
		scheduled_passenger_cars: null,
		consist: null,
		nonRevenue: false,
		scheduledTripDates: [serviceDate],
		actualTripDates: [serviceDate],
		trip_number: runNumber,
		rt_start_date: null,
		seq_diagram_prev_trip_id: null,
		seq_diagram_next_trip_id: null,
		seq_diagram_block_id: null,
		seq_diagram_prev_instance_id: null,
		seq_diagram_next_instance_id: null,
		seq_diagram_prev_link_broken: false,
		seq_diagram_next_link_broken: false,
	};
	const tripKey = entityKey({ feedId, localId: tripId });
	const trip = {
		feed_id: feedId,
		trip_id: tripId,
		route_id: "hunter",
		service_id: "daily",
		trip_headsign: null,
		trip_short_name: null,
		direction_id: 0,
		block_id: null,
		shape_id: null,
		wheelchair_accessible: null,
		bikes_allowed: null,
		scheduledStartServiceDates: [serviceDate],
		instances: [instance],
	};
	ctx.augmented.tripsRec.set(tripKey, trip);
	ctx.augmented.instancesRec.set(instanceId, instance);
	return { tripKey, instanceId, instance, trip };
}

function hilldaleCalls(offsetSecs = 0) {
	return [
		{ station: "200060", time: toSecs(8, 0) + offsetSecs },
		{ station: "242040", time: toSecs(9, 0) + offsetSecs },
		{ station: "242020", time: toSecs(9, 30) + offsetSecs },
		{ station: "242010", time: toSecs(10, 0) + offsetSecs },
	];
}

// 1. schedule-only pair merges to one canonical trip.
{
	const ctx = makeCtx();
	const a = addTrip(ctx, {
		feedId: SYD,
		tripId: "ST21.syd.X.7.1",
		runNumber: "ST21",
		serviceDate: SERVICE_DATE,
		calls: hilldaleCalls(0),
	});
	const b = addTrip(ctx, {
		feedId: TL,
		tripId: "ST21.tl.X.7.2",
		runNumber: "ST21",
		serviceDate: SERVICE_DATE,
		calls: hilldaleCalls(60),
	});
	const index = buildTfnswCrossFeedIndex(ctx);
	assert.equal(index.pairs.length, 1, "schedule-only pair should match");
	const pair = index.pairs[0];
	assert.equal(pair.serviceDate, SERVICE_DATE);
	assert.equal(pair.runNumber, "ST21");
	const canonA = resolveTfnswCanonicalInstanceId(ctx, a.instanceId);
	const canonB = resolveTfnswCanonicalInstanceId(ctx, b.instanceId);
	assert.equal(canonA, canonB, "both members share one canonical ID");
	assert.equal(canonA, a.instanceId);
	const canonical = getTfnswCanonicalTripInstance(ctx, a.instanceId);
	assert.ok(canonical, "canonical presentation exists");
	assert.equal(canonical.instance_id, canonA);
	assert.equal(
		getAugmentedTripInstance(ctx, b.instanceId).instance_id,
		canonical.instance_id,
		"original links preserved",
	);
	// Canonical prefers Sydney Trains schedule (primary) and keeps its stopping pattern.
	assert.equal(canonical.feed_id, SYD);
	assert.deepEqual(
		canonical.stopTimes.map((st) => st.scheduled_stop_id),
		["200060", "242040", "242020", "242010"],
	);
	// Departures at shared Hilldale collapse to one.
	const depA = a.instance.stopTimes.find((st) => st.scheduled_stop_id === "242040");
	const depB = b.instance.stopTimes.find((st) => st.scheduled_stop_id === "242040");
	const reconciled = reconcileTfnswDepartures(ctx, [depA, depB]);
	assert.equal(reconciled.length, 1, "Hilldale duplicate departures collapse to one");
	// Public lookup returns presentation, not raw.
	const viaPublic = getAugmentedTripInstance(ctx, b.instanceId);
	assert.ok(viaPublic, "public lookup resolves paired raw ID");
	assert.equal(viaPublic.instance_id, canonA, "public lookup returns canonical ID");
}

// 2. realtime from either source preserved; canonical ID stable.
{
	const ctx = makeCtx();
	const a = addTrip(ctx, {
		feedId: SYD,
		tripId: "ST21.syd.X.7.1",
		runNumber: "ST21",
		serviceDate: SERVICE_DATE,
		calls: hilldaleCalls(0),
	});
	const b = addTrip(ctx, {
		feedId: TL,
		tripId: "ST21.tl.X.7.2",
		runNumber: "ST21",
		serviceDate: SERVICE_DATE,
		calls: hilldaleCalls(60),
		realtimeDelays: { 242040: 600 },
	});
	const before = buildTfnswCrossFeedIndex(ctx);
	const canonBefore = resolveTfnswCanonicalInstanceId(ctx, a.instanceId);
	assert.equal(before.pairs.length, 1, "realtime pair should still match");
	const canonical = getTfnswCanonicalTripInstance(ctx, a.instanceId);
	assert.ok(canonical);
	const hilldale = canonical.stopTimes.find((st) => st.scheduled_stop_id === "242040");
	assert.ok(
		hilldale.realtime === true ||
			hilldale.rt_departure_updated === true ||
			hilldale.actual_departure_time !== hilldale.scheduled_departure_time,
		"realtime from TrainLink preserved on canonical Hilldale call",
	);
	// Canonical ID must not switch when realtime appears on the secondary.
	const ctx2 = makeCtx();
	const a2 = addTrip(ctx2, {
		feedId: SYD,
		tripId: "ST21.syd.X.7.1",
		runNumber: "ST21",
		serviceDate: SERVICE_DATE,
		calls: hilldaleCalls(0),
	});
	const b2 = addTrip(ctx2, {
		feedId: TL,
		tripId: "ST21.tl.X.7.2",
		runNumber: "ST21",
		serviceDate: SERVICE_DATE,
		calls: hilldaleCalls(60),
	});
	buildTfnswCrossFeedIndex(ctx2);
	const canonNoRt = resolveTfnswCanonicalInstanceId(ctx2, a2.instanceId);
	assert.equal(canonBefore, canonNoRt, "canonical ID stable with/without realtime");
	assert.equal(getTfnswCrossFeedPair(ctx, a.instanceId)?.canonicalInstanceId, canonBefore);
}

// 3. ambiguous duplicates stay separate.
{
	const ctx = makeCtx();
	addTrip(ctx, {
		feedId: SYD,
		tripId: "ST21.syd.X.7.1",
		runNumber: "ST21",
		serviceDate: SERVICE_DATE,
		calls: hilldaleCalls(0),
	});
	const b = addTrip(ctx, {
		feedId: TL,
		tripId: "ST21.tl.X.7.2",
		runNumber: "ST21",
		serviceDate: SERVICE_DATE,
		calls: hilldaleCalls(60),
	});
	addTrip(ctx, {
		feedId: TL,
		tripId: "ST21.tl.X.7.3",
		runNumber: "ST21",
		serviceDate: SERVICE_DATE,
		calls: hilldaleCalls(90),
	});
	const index = buildTfnswCrossFeedIndex(ctx);
	assert.equal(index.pairs.length, 0, "ambiguous duplicates must stay separate");
	assert.equal(
		resolveTfnswCanonicalInstanceId(ctx, b.instanceId),
		b.instanceId,
		"ambiguous member resolves to itself",
	);
	const depRows = [];
	for (const trip of ctx.augmented.tripsRec.values()) {
		for (const inst of trip.instances) {
			const st = inst.stopTimes.find((s) => s.scheduled_stop_id === "242040");
			if (st) depRows.push(st);
		}
	}
	assert.equal(reconcileTfnswDepartures(ctx, depRows).length, 3, "ambiguous departures all retained");
}

// 4. repeat visits map by ordered occurrence.
{
	const ctx = makeCtx();
	const loopA = [
		{ station: "200060", time: toSecs(8, 0) },
		{ station: "242040", time: toSecs(8, 30) },
		{ station: "242020", time: toSecs(9, 0) },
		{ station: "242040", time: toSecs(9, 30) },
		{ station: "242010", time: toSecs(10, 0) },
	];
	const loopB = [
		{ station: "200060", time: toSecs(8, 1) },
		{ station: "242040", time: toSecs(8, 31) },
		{ station: "242020", time: toSecs(9, 1) },
		{ station: "242040", time: toSecs(9, 31) },
		{ station: "242010", time: toSecs(10, 1) },
	];
	const a = addTrip(ctx, {
		feedId: SYD,
		tripId: "ST21.syd.loop",
		runNumber: "ST21",
		serviceDate: SERVICE_DATE,
		calls: loopA,
	});
	const b = addTrip(ctx, {
		feedId: TL,
		tripId: "ST21.tl.loop",
		runNumber: "ST21",
		serviceDate: SERVICE_DATE,
		calls: loopB,
	});
	const index = buildTfnswCrossFeedIndex(ctx);
	assert.equal(index.pairs.length, 1, "loop pair matches");
	const rows = [];
	for (const inst of [a.instance, b.instance]) {
		for (const st of inst.stopTimes) if (st.scheduled_stop_id === "242040") rows.push(st);
	}
	assert.equal(rows.length, 4, "two visits x two feeds");
	const reconciled = reconcileTfnswDepartures(ctx, rows);
	assert.equal(reconciled.length, 2, "repeat visits keep one row per ordered occurrence");
}

// 5. service dates separate; run normalization.
{
	const ctx = makeCtx();
	const a = addTrip(ctx, {
		feedId: SYD,
		tripId: "ST21.syd.X.7.1",
		runNumber: "ST21",
		serviceDate: SERVICE_DATE,
		calls: hilldaleCalls(0),
	});
	const b = addTrip(ctx, {
		feedId: TL,
		tripId: "ST21.tl.X.7.2",
		runNumber: "ST21",
		serviceDate: OTHER_DATE,
		calls: hilldaleCalls(60),
	});
	const index = buildTfnswCrossFeedIndex(ctx);
	assert.equal(index.pairs.length, 0, "different service dates never pair");
	assert.equal(resolveTfnswCanonicalInstanceId(ctx, a.instanceId), a.instanceId);
	assert.equal(normalizeTfnswRunNumber(" st21 "), "ST21");
	assert.equal(normalizeTfnswRunNumber(""), null);
	assert.equal(getTfnswCrossFeedPair(ctx, b.instanceId), null);
}

// 6. source expiry falls back to singleton.
{
	const ctx = makeCtx();
	const a = addTrip(ctx, {
		feedId: SYD,
		tripId: "ST21.syd.X.7.1",
		runNumber: "ST21",
		serviceDate: SERVICE_DATE,
		calls: hilldaleCalls(0),
	});
	const b = addTrip(ctx, {
		feedId: TL,
		tripId: "ST21.tl.X.7.2",
		runNumber: "ST21",
		serviceDate: SERVICE_DATE,
		calls: hilldaleCalls(60),
	});
	let index = buildTfnswCrossFeedIndex(ctx);
	assert.equal(index.pairs.length, 1);
	// Expire TrainLink source.
	ctx.augmented.tripsRec.delete(entityKey({ feedId: TL, localId: "ST21.tl.X.7.2" }));
	ctx.augmented.instancesRec.delete(b.instanceId);
	index = buildTfnswCrossFeedIndex(ctx);
	assert.equal(index.pairs.length, 0, "expired source dissolves pair");
	assert.equal(resolveTfnswCanonicalInstanceId(ctx, a.instanceId), a.instanceId);
	const depA = a.instance.stopTimes.find((st) => st.scheduled_stop_id === "242040");
	assert.equal(reconcileTfnswDepartures(ctx, [depA]).length, 1);
}

// 7. stop sequence differs; no blind sequence/delay copy.
{
	const ctx = makeCtx();
	const a = addTrip(ctx, {
		feedId: SYD,
		tripId: "ST21.syd.X.7.1",
		runNumber: "ST21",
		serviceDate: SERVICE_DATE,
		calls: hilldaleCalls(0),
	});
	// TrainLink inserts an extra Maitland-area call and shifts sequences.
	const bCalls = [
		{ station: "200060", time: toSecs(8, 0) + 30, seq: 1 },
		{ station: "242040", time: toSecs(9, 0) + 45, seq: 5 },
		{ station: "242020", time: toSecs(9, 30) + 30, seq: 9 },
		{ station: "242010", time: toSecs(10, 0) + 20, seq: 12 },
	];
	const b = addTrip(ctx, {
		feedId: TL,
		tripId: "ST21.tl.X.7.2",
		runNumber: "ST21",
		serviceDate: SERVICE_DATE,
		calls: bCalls,
		realtimeDelays: { 242020: 300 },
	});
	const index = buildTfnswCrossFeedIndex(ctx);
	assert.equal(index.pairs.length, 1, "differing sequences still pair via ordered canonical anchors");
	const canonical = getTfnswCanonicalTripInstance(ctx, a.instanceId);
	assert.deepEqual(
		canonical.stopTimes.map((st) => st.scheduled_stop_id),
		["200060", "242040", "242020", "242010"],
		"presentation preserves primary stopping pattern, not secondary sequences",
	);
	assert.deepEqual(
		canonical.stopTimes.map((st) => st._stopTime?.stop_sequence ?? null),
		a.instance.stopTimes.map((st) => st._stopTime?.stop_sequence ?? null),
		"no blind sequence copy",
	);
	const maitland = canonical.stopTimes.find((st) => st.scheduled_stop_id === "242020");
	const hilldale = canonical.stopTimes.find((st) => st.scheduled_stop_id === "242040");
	assert.ok(maitland.actual_departure_time !== maitland.scheduled_departure_time, "mapped Maitland realtime applied");
	assert.equal(
		hilldale.actual_departure_time,
		hilldale.scheduled_departure_time,
		"unmapped Hilldale delay not copied",
	);
}

// 8. changed-trip expansion refreshes paired trip.
{
	const ctx = makeCtx();
	const a = addTrip(ctx, {
		feedId: SYD,
		tripId: "ST21.syd.X.7.1",
		runNumber: "ST21",
		serviceDate: SERVICE_DATE,
		calls: hilldaleCalls(0),
	});
	const b = addTrip(ctx, {
		feedId: TL,
		tripId: "ST21.tl.X.7.2",
		runNumber: "ST21",
		serviceDate: SERVICE_DATE,
		calls: hilldaleCalls(60),
	});
	buildTfnswCrossFeedIndex(ctx);
	const changed = new Set([a.tripKey]);
	const expanded = expandTfnswChangedTripKeys(ctx, changed);
	assert.ok(expanded.has(a.tripKey), "changed set retains original");
	assert.ok(expanded.has(b.tripKey), "paired trip added for refresh");
	const unrelated = expandTfnswChangedTripKeys(ctx, new Set(["99:xxunknown"]));
	assert.equal(unrelated.size, 1, "unknown keys pass through");
}

// Matching must tolerate terminal layovers, but reject a different itinerary.
for (const variant of ["layover", "opposite", "partial", "different-run", "different-time", "two-stops"]) {
	const ctx = makeCtx();
	const a = addTrip(ctx, {
		feedId: SYD,
		tripId: "V945.syd",
		runNumber: "V945",
		serviceDate: SERVICE_DATE,
		calls: hilldaleCalls(),
	});
	let calls = hilldaleCalls(48);
	if (variant === "opposite") calls.reverse();
	if (variant === "partial") calls = calls.slice(1);
	if (variant === "two-stops") {
		calls = calls.slice(0, 2);
		a.instance.stopTimes = a.instance.stopTimes.slice(0, 2);
	}
	if (variant === "different-time") calls = hilldaleCalls(121);
	const b = addTrip(ctx, {
		feedId: TL,
		tripId: "V945.tl",
		runNumber: variant === "different-run" ? "V947" : "V945",
		serviceDate: SERVICE_DATE,
		calls,
	});
	if (variant === "layover") {
		a.instance.stopTimes[0].scheduled_arrival_time -= 3600;
		a.instance.stopTimes.at(-1).scheduled_departure_time += 3600;
	}
	assert.equal(buildTfnswCrossFeedIndex(ctx).pairs.length, variant === "layover" ? 1 : 0, variant);
}

// Delay metadata is relative to the canonical schedule, not the other feed.
{
	const ctx = makeCtx();
	const a = addTrip(ctx, {
		feedId: SYD,
		tripId: "V945.syd",
		runNumber: "V945",
		serviceDate: SERVICE_DATE,
		calls: hilldaleCalls(),
	});
	const b = addTrip(ctx, {
		feedId: TL,
		tripId: "V945.tl",
		runNumber: "V945",
		serviceDate: SERVICE_DATE,
		calls: hilldaleCalls(48),
		realtimeDelays: { 242040: 600 },
	});
	buildTfnswCrossFeedIndex(ctx);
	const row = getTfnswCanonicalTripInstance(ctx, a.instanceId).stopTimes[1];
	assert.equal(row.realtime_info.delay_secs, 648);
	assert.equal(row.actual_departure_time, b.instance.stopTimes[1].actual_departure_time);
	assert.equal(a.instance.stopTimes[1].realtime, false, "raw source remains unchanged");
	assert.equal(
		reconcileTfnswDepartures(ctx, [b.instance.stopTimes[1]])[0].instance_id,
		a.instanceId,
		"singleton per-feed queries canonicalize",
	);
}

// Frequency runs share trip/date/run-number but are distinct instances: canonical
// identity must include normalized frequency_start_time or runs collide.
{
	const ctx = makeCtx();
	const date = SERVICE_DATE;
	function addFreqTrip({ feedId, tripId, runNumber, freqStart }) {
		const instanceId = encodeTripInstanceId({
			networkId: NETWORK_ID,
			feedId,
			kind: "trip",
			localId: tripId,
			serviceDate: date,
			realtimeStartTime: `${String(Math.floor(freqStart / 3600)).padStart(2, "0")}:${String(Math.floor((freqStart % 3600) / 60)).padStart(2, "0")}:00`,
		});
		const base = freqStart;
		const calls = [
			{ station: "200060", time: base },
			{ station: "242040", time: base + 3600 },
			{ station: "242020", time: base + 5400 },
			{ station: "242010", time: base + 7200 },
		];
		const stopTimes = calls.map((call, index) =>
			makeStopTime({ feedId, tripId, instanceId, serviceDate: date, station: call.station, time: call.time, seq: index + 1 }),
		);
		for (const st of stopTimes) {
			st.instance_id = instanceId;
			st.service_date = date;
		}
		const instance = {
			feed_id: feedId,
			trip_id: tripId,
			instance_id: instanceId,
			serviceDate: date,
			schedule_relationship: "SCHEDULED",
			stopTimes,
			realtime_update: null,
			expressInfo: [],
			vehicle_model: null,
			vehicle_id: null,
			passenger_cars: null,
			scheduled_passenger_cars: null,
			consist: null,
			nonRevenue: false,
			scheduledTripDates: [date],
			actualTripDates: [date],
			trip_number: runNumber,
			rt_start_date: null,
			frequency_start_time: freqStart,
			frequency_headway_secs: 900,
			frequency_exact: true,
			seq_diagram_prev_trip_id: null,
			seq_diagram_next_trip_id: null,
			seq_diagram_block_id: null,
			seq_diagram_prev_instance_id: null,
			seq_diagram_next_instance_id: null,
			seq_diagram_prev_link_broken: false,
			seq_diagram_next_link_broken: false,
		};
		const tripKey = entityKey({ feedId, localId: tripId });
		let trip = ctx.augmented.tripsRec.get(tripKey);
		if (!trip) {
			trip = { feed_id: feedId, trip_id: tripId, route_id: "hunter", service_id: "daily", trip_headsign: null, trip_short_name: null, direction_id: 0, block_id: null, shape_id: null, wheelchair_accessible: null, bikes_allowed: null, scheduledStartServiceDates: [date], instances: [] };
			ctx.augmented.tripsRec.set(tripKey, trip);
		}
		trip.instances.push(instance);
		ctx.augmented.instancesRec.set(instanceId, instance);
		return instance;
	}
	const a1 = addFreqTrip({ feedId: SYD, tripId: "FREQ.syd", runNumber: "ST21", freqStart: 21_600 });
	const a2 = addFreqTrip({ feedId: SYD, tripId: "FREQ.syd", runNumber: "ST21", freqStart: 22_500 });
	addFreqTrip({ feedId: TL, tripId: "FREQ.tl", runNumber: "ST21", freqStart: 21_660 });
	addFreqTrip({ feedId: TL, tripId: "FREQ.tl", runNumber: "ST21", freqStart: 22_560 });
	const index = buildTfnswCrossFeedIndex(ctx);
	assert.equal(index.pairs.length, 2, "two frequency runs must pair separately without colliding");
	const c1 = resolveTfnswCanonicalInstanceId(ctx, a1.instance_id);
	const c2 = resolveTfnswCanonicalInstanceId(ctx, a2.instance_id);
	assert.notEqual(c1, c2, "canonical IDs must include normalized run identity");
}
console.log("TfNSW cross-feed reconciliation tests passed.");
