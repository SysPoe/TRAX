import assert from "node:assert/strict";
import { RouteType, TripScheduleRelationship } from "qdf-gtfs";
import { entityKey, parseEntityKey } from "../dist/identity.js";
import { qualifiedKey } from "../dist/utils/corridor/keys.js";
import { createEmptyAugmentedCache, createEmptyRawCache, createRuntimeState } from "../dist/cache/factories.js";
import { resolveConfig } from "../dist/config.js";
import { createEmptyCorridorIndex } from "../dist/utils/corridor/shapeIndex.js";
import { createRealtimeJourneyContext } from "../dist/utils/corridor/resolver.js";
import { augmentTrip } from "../dist/utils/augmentedTrip.js";

const q = (feedId, localId) => qualifiedKey(feedId, localId);

function context() {
	const network = {
		id: "audit-test",
		name: "Audit test",
		feeds: [{ id: "feed", staticSource: { url: "https://example.test/feed" }, realtimeSources: [] }],
		modes: ["rail"],
		plugins: [],
	};
	const config = resolveConfig(network, { corridor: { geometrySources: [], manualNetworks: [], version: "test" } });
	config.feedTimeZones.set("feed", "Australia/Brisbane");
	const augmented = createEmptyAugmentedCache();
	augmented.corridorIndex = createEmptyCorridorIndex(config.corridor.version);
	return { raw: createEmptyRawCache(), augmented, config, pluginState: new Map(), runtimeState: createRuntimeState() };
}

function seedTrip(ctx, stops, stopTimes) {
	for (const stop of stops) ctx.raw.stopsByKey.set(q("feed", stop.stop_id), stop);
	ctx.raw.routesByKey.set(q("feed", "r"), {
		feed_id: "feed",
		route_id: "r",
		route_type: RouteType.Rail,
		route_short_name: "R",
		route_long_name: "Rail",
	});
	ctx.gtfs = {
		getStops: (filter = {}) =>
			stops.filter(
				(s) => (!filter.feed_id || filter.feed_id === s.feed_id) && (!filter.stop_id || filter.stop_id === s.stop_id),
			),
		getStaticOccupancies: () => [],
	};
	ctx.augmented.rawStopTimesCache.set(q("feed", "trip"), stopTimes);
	ctx.runtimeState.srtNetworkData = { matrix: {}, adjacency: {}, lastUpdated: Date.now() };
	return {
		feed_id: "feed",
		trip_id: "trip",
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
}

function stopRow(id, lat = -27, lon = 153) {
	return { feed_id: "feed", stop_id: id, stop_name: id.toUpperCase(), stop_lat: lat, stop_lon: lon, parent_station: null };
}

// 1. duplicate same-key REPLACEMENT updates must not create duplicate instance_id
{
	const ctx = context();
	const trip = seedTrip(ctx, [stopRow("a"), stopRow("b"), stopRow("c")], [
		{ feed_id: "feed", trip_id: "trip", stop_id: "a", stop_sequence: 1, arrival_time: 3600, departure_time: 3600 },
		{ feed_id: "feed", trip_id: "trip", stop_id: "b", stop_sequence: 2, arrival_time: 4200, departure_time: 4200 },
		{ feed_id: "feed", trip_id: "trip", stop_id: "c", stop_sequence: 3, arrival_time: 4800, departure_time: 4800 },
	]);
	const base = {
		feed_id: "feed",
		source_id: "audit",
		trip: {
			trip_id: "trip",
			route_id: "r",
			direction_id: 0,
			start_date: "20260827",
			start_time: "10:00:00",
			schedule_relationship: TripScheduleRelationship.REPLACEMENT,
		},
	};
	const mk = (suffix, delay) => ({
		...base,
		trip: { ...base.trip },
		stop_time_updates: ["a", "b", "c"].map((stop_id, i) => ({
			stop_id,
			stop_sequence: i + 1,
			arrival_delay: delay,
			departure_delay: delay,
		})),
	});
	const result = augmentTrip(trip, ctx, new Map([[entityKey({ feedId: "feed", localId: "trip" }), [mk("1", 60), mk("2", 120)]]]), undefined, {
		serviceDates: ["20260827"],
		realtimeDates: ["20260827"],
	});
	const ids = result.instances.map((i) => i.instance_id);
	assert.equal(new Set(ids).size, ids.length, "duplicate same-key REPLACEMENT updates must not create duplicate instance_id");
	assert.equal(ids.length, 1, "duplicate same-key REPLACEMENT updates must collapse to a single instance");
}

// 2. parseEntityKey must reject empty localId and declared feed length beyond key
{
	assert.throws(() => parseEntityKey("3:foo"), /Invalid qualified entity key/, "empty localId must be rejected");
	assert.throws(() => parseEntityKey("10:ab"), /Invalid qualified entity key/, "declared feed length beyond key must be rejected");
	const valid = parseEntityKey("2:abC");
	assert.deepEqual(valid, { feedId: "ab", localId: "C" });
}

// 3. unknown realtime stop_id must yield actual_stop_id null
{
	const ctx = context();
	const trip = seedTrip(ctx, [stopRow("a"), stopRow("b")], [
		{ feed_id: "feed", trip_id: "trip", stop_id: "a", stop_sequence: 1, arrival_time: 3600, departure_time: 3600 },
		{ feed_id: "feed", trip_id: "trip", stop_id: "b", stop_sequence: 2, arrival_time: 4200, departure_time: 4200 },
	]);
	const update = {
		feed_id: "feed",
		source_id: "audit",
		trip: {
			trip_id: "trip",
			route_id: "r",
			direction_id: 0,
			start_date: "20260827",
			start_time: "10:00:00",
			schedule_relationship: TripScheduleRelationship.ADDED,
		},
		stop_time_updates: [
			{ stop_id: "a", stop_sequence: 1 },
			{ stop_id: "b", stop_sequence: 2 },
			{ stop_id: "ghost-unknown-stop", stop_sequence: 3 },
		],
	};
	const result = augmentTrip(trip, ctx, new Map([[entityKey({ feedId: "feed", localId: "trip" }), [update]]]), undefined, {
		serviceDates: ["20260827"],
		realtimeDates: ["20260827"],
	});
	const ghost = result.instances[0].stopTimes.find((st) => st.scheduled_stop_id == null);
	assert.ok(ghost, "added unknown call should still produce a row");
	assert.equal(ghost.actual_stop_id, null, "unknown realtime stop_id must yield actual_stop_id null, not a ghost ID");
}

// 4. conflicting same-sequence realtime anchors must resolve deterministically / fail ambiguous
{
	const ctx = context();
	for (const s of [stopRow("a"), stopRow("b")]) ctx.raw.stopsByKey.set(q("feed", s.stop_id), s);
	ctx.gtfs = {
		getStops: (filter = {}) =>
			[stopRow("a"), stopRow("b")].filter(
				(s) => (!filter.feed_id || filter.feed_id === s.feed_id) && (!filter.stop_id || filter.stop_id === s.stop_id),
			),
	};
	const mkUpdate = (order) => ({
		feed_id: "feed",
		source_id: "audit",
		trip: { trip_id: "trip", route_id: "r", direction_id: 0, start_date: "20260827", start_time: "10:00:00" },
		stop_time_updates: order.map((stop_id) => ({ stop_id, stop_sequence: 1 })),
	});
	const first = createRealtimeJourneyContext(mkUpdate(["a", "b"]), ctx);
	const swapped = createRealtimeJourneyContext(mkUpdate(["b", "a"]), ctx);
	const seqs = (j) => j.anchors.map((a) => a.sequence);
	const stations = (j) => j.anchors.map((a) => a.stationId);
	// No two anchors may claim the same sequence with different stations (ambiguous), and
	// feed order must not change the winner.
	assert.equal(new Set(seqs(first)).size, first.anchors.length, "conflicting same-sequence anchors must not coexist");
	assert.deepEqual(stations(first), stations(swapped), "same-sequence conflict winner must be order-independent");
}

// 5. repeated-station null-sequence VIA updates must not silently apply to the wrong visit or vanish without an explicit safe rule
{
	const ctx = context();
	const trip = seedTrip(ctx, [stopRow("a"), stopRow("b")], [
		{ feed_id: "feed", trip_id: "trip", stop_id: "a", stop_sequence: 1, arrival_time: 60, departure_time: 60 },
		{ feed_id: "feed", trip_id: "trip", stop_id: "b", stop_sequence: 2, arrival_time: 120, departure_time: 120 },
		{ feed_id: "feed", trip_id: "trip", stop_id: "a", stop_sequence: 3, arrival_time: 180, departure_time: 180 },
	]);
	// VIA-style: null sequence, stop_id-only delay for the repeated station.
	const viaUpdate = {
		feed_id: "feed",
		source_id: "via-supplemental",
		trip: {
			trip_id: "trip",
			route_id: "r",
			direction_id: 0,
			start_date: "20260827",
			start_time: "",
			schedule_relationship: TripScheduleRelationship.SCHEDULED,
		},
		stop_time_updates: [{ stop_id: "a", stop_sequence: null, arrival_delay: 600, departure_delay: 600 }],
	};
	const result = augmentTrip(trip, ctx, new Map([[entityKey({ feedId: "feed", localId: "trip" }), [viaUpdate]]]), undefined, {
		serviceDates: ["20260827"],
		realtimeDates: ["20260827"],
	});
	const times = result.instances[0].stopTimes.map((st) => st.actual_arrival_time);
	// Safe rule: a null-sequence update for a repeated station must apply to no visit
	// (never to the wrong visit), explicitly — not to one arbitrary visit and not to all.
	assert.deepEqual(times, [60, 120, 180], "repeated-station null-sequence update must not apply to the wrong visit");
	const { isAmbiguousNullSequenceStation } = await import("../dist/utils/augmentedStopTime.js");
	assert.equal(isAmbiguousNullSequenceStation("a", result.instances[0].stopTimes), true, "repeated station must be explicitly marked ambiguous");
	assert.equal(isAmbiguousNullSequenceStation("b", result.instances[0].stopTimes), false);
}

console.log("Realtime identity audit tests passed.");
