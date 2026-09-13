import assert from "node:assert/strict";
import { RouteType, TripScheduleRelationship } from "qdf-gtfs";
import { qualifiedKey } from "../dist/utils/corridor/keys.js";
import { createEmptyAugmentedCache, createEmptyRawCache, createRuntimeState } from "../dist/cache/factories.js";
import { resolveConfig } from "../dist/config.js";
import { createEmptyCorridorIndex } from "../dist/utils/corridor/shapeIndex.js";
import { augmentTrip } from "../dist/utils/augmentedTrip.js";
import { entityKey } from "../dist/identity.js";

const q = (feedId, localId) => qualifiedKey(feedId, localId);

function context() {
	const network = {
		id: "null-seq-dedupe-test",
		name: "Null-seq dedupe test",
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

function stopRow(id) {
	return { feed_id: "feed", stop_id: id, stop_name: id.toUpperCase(), stop_lat: -27, stop_lon: 153, parent_station: null };
}

function seedTrip(ctx, stopIds, times) {
	for (const id of stopIds) ctx.raw.stopsByKey.set(q("feed", id), stopRow(id));
	ctx.raw.routesByKey.set(q("feed", "r"), {
		feed_id: "feed",
		route_id: "r",
		route_type: RouteType.Rail,
		route_short_name: "R",
		route_long_name: "Rail",
	});
	ctx.gtfs = {
		getStops: (filter = {}) =>
			stopIds
				.map((stop_id) => stopRow(stop_id))
				.filter((s) => (!filter.feed_id || filter.feed_id === s.feed_id) && (!filter.stop_id || filter.stop_id === s.stop_id)),
		getStaticOccupancies: () => [],
	};
	const stopTimes = stopIds.map((stop_id, i) => ({
		feed_id: "feed",
		trip_id: "trip",
		stop_id,
		stop_sequence: i + 1,
		arrival_time: times[i],
		departure_time: times[i],
	}));
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

function tripUpdate(stopTimeUpdates) {
	return {
		feed_id: "feed",
		source_id: "test",
		trip: {
			trip_id: "trip",
			route_id: "r",
			direction_id: 0,
			start_date: "20260827",
			start_time: "10:00:00",
			schedule_relationship: TripScheduleRelationship.SCHEDULED,
		},
		stop_time_updates: stopTimeUpdates,
	};
}

// P1-1: duplicate identical null-sequence updates for a single-visit stop must deduplicate,
// not mark ambiguous and delete the update.
{
	const ctx = context();
	const trip = seedTrip(ctx, ["a", "b", "c"], [3600, 4200, 4800]);
	const identical = { stop_id: "b", stop_sequence: null, arrival_delay: 600, departure_delay: 600 };
	const result = augmentTrip(
		trip,
		ctx,
		new Map([[entityKey({ feedId: "feed", localId: "trip" }), [tripUpdate([{ ...identical }, { ...identical }])]]]),
		undefined,
		{ serviceDates: ["20260827"], realtimeDates: ["20260827"] },
	);
	const times = result.instances[0].stopTimes.map((st) => st.actual_arrival_time);
	assert.deepEqual(times, [3600, 4800, 5400], "identical null-sequence duplicates must deduplicate and apply, not vanish");
}

// P1-2: genuinely conflicting null-sequence updates for the same single-visit stop must stay rejected.
{
	const ctx = context();
	const trip = seedTrip(ctx, ["a", "b", "c"], [3600, 4200, 4800]);
	const result = augmentTrip(
		trip,
		ctx,
		new Map([
			[
				entityKey({ feedId: "feed", localId: "trip" }),
				[
					tripUpdate([
						{ stop_id: "b", stop_sequence: null, arrival_delay: 600, departure_delay: 600 },
						{ stop_id: "b", stop_sequence: null, arrival_delay: 1200, departure_delay: 1200 },
					]),
				],
			],
		]),
		undefined,
		{ serviceDates: ["20260827"], realtimeDates: ["20260827"] },
	);
	const times = result.instances[0].stopTimes.map((st) => st.actual_arrival_time);
	assert.deepEqual(times, [3600, 4200, 4800], "conflicting null-sequence updates must stay rejected");
}

// P1-3: loop-ambiguous null-sequence updates must stay rejected (repeated station).
{
	const ctx = context();
	const trip = seedTrip(ctx, ["a", "b", "a"], [60, 120, 180]);
	// Need distinct stop rows for a,b (seedTrip dedupes by id, so manually ensure raw stops exist).
	const result = augmentTrip(
		trip,
		ctx,
		new Map([
			[
				entityKey({ feedId: "feed", localId: "trip" }),
				[tripUpdate([{ stop_id: "a", stop_sequence: null, arrival_delay: 600, departure_delay: 600 }])],
			],
		]),
		undefined,
		{ serviceDates: ["20260827"], realtimeDates: ["20260827"] },
	);
	const times = result.instances[0].stopTimes.map((st) => st.actual_arrival_time);
	assert.deepEqual(times, [60, 120, 180], "loop-ambiguous null-sequence update must stay rejected");
}

console.log("Realtime null-seq dedupe tests passed.");
