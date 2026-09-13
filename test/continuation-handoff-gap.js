import assert from "node:assert/strict";
import { PickupType, DropOffType, StopTimeScheduleRelationship, TransferType } from "qdf-gtfs";
import { getOnboardReachableStops } from "../dist/utils/passengerContinuations.js";
import { entityKey } from "../dist/identity.js";
import { createEmptyAugmentedCache, createEmptyRawCache, createRuntimeState } from "../dist/cache/factories.js";
import { resolveConfig } from "../dist/config.js";
import { createEmptyCorridorIndex } from "../dist/utils/corridor/shapeIndex.js";

function context() {
	const network = {
		id: "handoff-gap-test",
		name: "Handoff gap test",
		feeds: [{ id: "feed", staticSource: { url: "https://example.test/feed" }, realtimeSources: [] }],
		modes: ["rail"],
		plugins: [],
	};
	const config = resolveConfig(network, { corridor: { geometrySources: [], manualNetworks: [], version: "test" } });
	const augmented = createEmptyAugmentedCache();
	augmented.corridorIndex = createEmptyCorridorIndex(config.corridor.version);
	return { raw: createEmptyRawCache(), augmented, config, pluginState: new Map(), runtimeState: createRuntimeState() };
}

function passengerStop({ id, arr, dep, pickup = 0, drop = 0, passing = false, skipped = false, noData = false }) {
	return {
		feed_id: "feed",
		actual_stop_id: id,
		actual_parent_station_id: null,
		scheduled_stop_id: id,
		scheduled_parent_station_id: null,
		actual_parent_station: null,
		actual_stop: null,
		scheduled_parent_station: null,
		scheduled_stop: null,
		actual_departure_time: null,
		scheduled_departure_time: dep,
		actual_arrival_time: null,
		scheduled_arrival_time: arr,
		service_date: "20260101",
		passing,
		pickup_type: pickup,
		drop_off_type: drop,
		realtime_info: skipped
			? { schedule_relationship: StopTimeScheduleRelationship.SKIPPED }
			: noData
				? { schedule_relationship: StopTimeScheduleRelationship.NO_DATA }
				: null,
	};
}

function passengerInstance({ tripId, instanceId, stops, nextId = null, broken = false }) {
	return {
		feed_id: "feed",
		trip_id: tripId,
		instance_id: instanceId,
		serviceDate: "20260101",
		service_date: "20260101",
		actualTripDates: ["20260101"],
		stopTimes: stops,
		seq_diagram_next_instance_id: nextId,
		seq_diagram_next_link_broken: broken,
	};
}

function passengerCtx(instances, { transfers = new Map(), rawTrips = new Map(), gtfsTrips = [] } = {}) {
	const ctx = context();
	ctx.config.feedTimeZones.set("feed", "Australia/Brisbane");
	for (const inst of instances) {
		ctx.augmented.instancesRec.set(inst.instance_id, inst);
		const key = entityKey({ feedId: "feed", localId: inst.trip_id });
		const existing = ctx.augmented.tripsRec.get(key);
		if (existing) existing.instances.push(inst);
		else ctx.augmented.tripsRec.set(key, { instances: [inst] });
	}
	ctx.augmented.linkedTransfersFromTrip = transfers;
	ctx.augmented.rawTripsRec = rawTrips;
	ctx.gtfs = { getTrips: () => gtfsTrips };
	return ctx;
}

function passengerStopIds(result) {
	return result.map((entry) => entry.stop_id);
}

// P2-1: skipped terminal must not reject a valid X->X handoff via raw gap.
// Current ends o,h usable + s SKIPPED terminal later than next h, so raw gap (next h - s)
// is negative and rejects, while usable gap (next h - h) is positive and must win.
{
	const a = passengerInstance({
		tripId: "ska",
		instanceId: "ska-1",
		stops: [
			passengerStop({ id: "o", arr: 36000, dep: 36000 }),
			passengerStop({ id: "h", arr: 36300, dep: 36300 }),
			passengerStop({ id: "s", arr: 37000, dep: 37000, skipped: true }),
		],
	});
	const b = passengerInstance({
		tripId: "skb",
		instanceId: "skb-1",
		stops: [passengerStop({ id: "h", arr: 36900, dep: 36900 }), passengerStop({ id: "z", arr: 37200, dep: 37200 })],
	});
	const transfers = new Map([
		[entityKey({ feedId: "feed", localId: "ska" }), [{ from_stop_id: "h", to_stop_id: "h", from_trip_id: "ska", to_trip_id: "skb", transfer_type: TransferType.InSeat }]],
	]);
	const result = getOnboardReachableStops(passengerCtx([a, b], { transfers }), "ska-1", {
		stopIds: ["o"],
		departureTime: 36000,
	});
	assert.deepEqual(passengerStopIds(result), ["h", "z"], "skipped terminal must not reject valid X->X handoff (gap must use usable handoff)");
}

// P2-2: NO_DATA handoff must not form an edge.
// Current ends o usable + h NO_DATA terminal; next starts h usable. Usable handoff is o vs h,
// so no X->X edge may form.
{
	const a = passengerInstance({
		tripId: "nda",
		instanceId: "nda-1",
		stops: [passengerStop({ id: "o", arr: 36000, dep: 36000 }), passengerStop({ id: "h", arr: 36300, dep: 36300, noData: true })],
	});
	const b = passengerInstance({
		tripId: "ndb",
		instanceId: "ndb-1",
		stops: [passengerStop({ id: "h", arr: 36600, dep: 36600 }), passengerStop({ id: "z", arr: 36900, dep: 36900 })],
	});
	const transfers = new Map([
		[entityKey({ feedId: "feed", localId: "nda" }), [{ from_stop_id: "h", to_stop_id: "h", from_trip_id: "nda", to_trip_id: "ndb", transfer_type: TransferType.InSeat }]],
	]);
	const result = getOnboardReachableStops(passengerCtx([a, b], { transfers }), "nda-1", {
		stopIds: ["o"],
		departureTime: 36000,
	});
	assert.deepEqual(passengerStopIds(result), [], "NO_DATA terminal must not form a continuation edge");
}

// P2-3: NO_DATA via block fallback must not form an edge either.
{
	const a = passengerInstance({
		tripId: "nba",
		instanceId: "nba-1",
		stops: [passengerStop({ id: "o", arr: 36000, dep: 36000 }), passengerStop({ id: "h", arr: 36300, dep: 36300, noData: true })],
	});
	const b = passengerInstance({
		tripId: "nbb",
		instanceId: "nbb-1",
		stops: [passengerStop({ id: "h", arr: 36600, dep: 36600 }), passengerStop({ id: "z", arr: 36900, dep: 36900 })],
	});
	const rawTrips = new Map([
		[entityKey({ feedId: "feed", localId: "nba" }), { block_id: "blk" }],
		[entityKey({ feedId: "feed", localId: "nbb" }), { block_id: "blk" }],
	]);
	const gtfsTrips = [
		{ feed_id: "feed", trip_id: "nba" },
		{ feed_id: "feed", trip_id: "nbb" },
	];
	const result = getOnboardReachableStops(passengerCtx([a, b], { rawTrips, gtfsTrips }), "nba-1", {
		stopIds: ["o"],
		departureTime: 36000,
	});
	assert.deepEqual(passengerStopIds(result), [], "NO_DATA handoff must not form a block edge");
}

console.log("Continuation handoff gap tests passed.");
