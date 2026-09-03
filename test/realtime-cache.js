import assert from "node:assert/strict";
import { RouteType, StopTimeScheduleRelationship, TripScheduleRelationship } from "qdf-gtfs";
import { refreshRealtimeCache } from "../dist/cache/refreshCaches.js";
import { createEmptyAugmentedCache, createEmptyRawCache, createRuntimeState } from "../dist/cache/factories.js";
import {
	getStopDeparturesCached,
	getTripIdsByServiceDate,
	registerAugmentedTrip,
	unregisterAugmentedTrip,
} from "../dist/cache/augmentedEntities.js";
import { resolveConfig } from "../dist/config.js";
import { entityKey } from "../dist/identity.js";

const feedId = "feed";
const routeId = "rail";
const tripId = "realtime-trip";
const serviceDate = "20260827";
const nextServiceDate = "20260828";
const tripKey = entityKey({ feedId, localId: tripId });

const stops = ["a", "b", "c", "d"].map((stop_id, index) => ({
	stop_id,
	stop_code: null,
	stop_name: stop_id.toUpperCase(),
	stop_desc: null,
	stop_lat: -27,
	stop_lon: 153 + index * 0.001,
	zone_id: null,
	stop_url: null,
	location_type: null,
	parent_station: null,
	stop_timezone: null,
	wheelchair_boarding: null,
	level_id: null,
	platform_code: null,
	feed_id: feedId,
}));

const route = {
	route_id: routeId,
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
	feed_id: feedId,
};

const config = resolveConfig(
	{
		id: "realtime-cache-test",
		name: "Realtime cache test",
		feeds: [
			{
				id: feedId,
				staticSource: { url: "https://example.test/static.zip" },
				realtimeSources: [
					{
						id: "realtime",
						targetFeedId: feedId,
						kind: "trip-updates",
						source: { url: "https://example.test/realtime" },
					},
				],
			},
		],
		modes: ["rail"],
		plugins: [],
	},
	{ progressLog: () => {}, logFunction: () => {} },
);
config.feedTimeZones.set(feedId, "Australia/Brisbane");

let updates = [];
let singleStopTimeQueries = 0;
let packedStopTimeQueries = 0;
const gtfs = {
	getRealtimeTripUpdates: () => updates,
	getStaticOccupancies: () => [],
	getServiceDates: () => [],
	getStops: (filter = {}) =>
		stops.filter(
			(stop) =>
				(!filter.feed_id || filter.feed_id === stop.feed_id) &&
				(!filter.stop_id || filter.stop_id === stop.stop_id),
		),
	getStopTimes: () => {
		singleStopTimeQueries += 1;
		return [];
	},
	getStopTimesPacked: () => {
		packedStopTimeQueries += 1;
		return { tripIds: [] };
	},
};

const raw = createEmptyRawCache();
const augmented = createEmptyAugmentedCache();
const ctx = {
	raw,
	augmented,
	config,
	gtfs,
	pluginState: new Map(),
	runtimeState: createRuntimeState(),
};
raw.routesByKey.set(entityKey({ feedId, localId: routeId }), route);
for (const stop of stops) raw.stopsByKey.set(entityKey({ feedId, localId: stop.stop_id }), stop);

function realtimeUpdate({
	id = tripId,
	timestamp = 0,
	stopIds = ["a", "b", "d"],
	relationship = TripScheduleRelationship.ADDED,
	startTime = "10:00:00",
	startDate = serviceDate,
	delay = null,
} = {}) {
	return {
		update_id: `update-${id}`,
		is_deleted: false,
		trip: {
			trip_id: id,
			route_id: routeId,
			direction_id: 0,
			start_time: startTime,
			start_date: startDate,
			schedule_relationship: relationship,
			feed_id: feedId,
		},
		vehicle: { id: "", label: "", license_plate: "" },
		stop_time_updates: stopIds.map((stop_id, index) => ({
			stop_sequence: index + 1,
			stop_id,
			start_date: startDate,
			start_time: startTime,
			arrival_delay: null,
			arrival_time: null,
			arrival_uncertainty: null,
			departure_delay: null,
			departure_time: null,
			departure_uncertainty: null,
			schedule_relationship: StopTimeScheduleRelationship.SCHEDULED,
			feed_id: feedId,
			source_id: "realtime",
		})),
		timestamp,
		delay,
		feed_id: feedId,
		source_id: "realtime",
	};
}

updates = [realtimeUpdate()];
await refreshRealtimeCache(gtfs, config, ctx);

assert.equal(raw.realtimeOnlyTripKeys.has(tripKey), true);
assert.equal(augmented.rawTripsRec.has(tripKey), true);
assert.equal(augmented.tripsRec.has(tripKey), true);
assert.equal(augmented.tripNumberTrips.get("trip")?.has(tripKey), true);
assert.equal(augmented.rawStopTimesCache.has(tripKey), true, "realtime trips should retain their primed stop times");
assert.deepEqual(
	augmented.tripsRec.get(tripKey)?.instances[0].stopTimes.map((stopTime) => stopTime.actual_stop_id),
	["a", "b", "d"],
);
assert.equal(getTripIdsByServiceDate(ctx, serviceDate).includes(tripKey), true);

const metadataOnlyTrip = augmented.tripsRec.get(tripKey);
let metadataOnlyReaugmentation = false;
gtfs.getLastChangedTripIds = () => [{ feed_id: feedId, trip_id: tripId }];
updates = [realtimeUpdate({ timestamp: 1 })];
config.progressLog = (progress) => {
	if (progress.task === "Re-augmenting updated trips") metadataOnlyReaugmentation = true;
};
await refreshRealtimeCache(gtfs, config, ctx);
assert.equal(metadataOnlyReaugmentation, false, "coarse native candidates and timestamp-only updates must not rebuild trips");
assert.strictEqual(augmented.tripsRec.get(tripKey), metadataOnlyTrip, "metadata-only updates should reuse the trip");
assert.equal(
	augmented.tripsRec.get(tripKey)?.instances[0].realtime_update?.timestamp,
	1,
	"metadata-only updates must still publish the latest realtime record",
);
delete gtfs.getLastChangedTripIds;
config.progressLog = () => {};

const oldInstanceId = augmented.tripsRec.get(tripKey).instances[0].instance_id;
for (const stopId of ["a", "b", "d"]) {
	assert.equal(
		getStopDeparturesCached(ctx, { feedId, localId: stopId }, serviceDate).length,
		1,
		`expected a cached departure for ${stopId}`,
	);
}

updates = [realtimeUpdate({ timestamp: 2, stopIds: ["b", "c"], startTime: "11:00:00", startDate: nextServiceDate })];
await refreshRealtimeCache(gtfs, config, ctx);

const updatedTrip = augmented.tripsRec.get(tripKey);
assert.ok(updatedTrip);
const newInstanceId = updatedTrip.instances[0].instance_id;
assert.notEqual(newInstanceId, oldInstanceId, "a changed realtime start time must replace the trip instance");
assert.equal(augmented.instancesRec.has(oldInstanceId), false, "the old trip instance must be unregistered");
assert.equal(augmented.instancesRec.has(newInstanceId), true, "the new trip instance must be registered");
assert.deepEqual([...augmented.serviceDatesByTrip.get(tripKey)].sort(), [nextServiceDate]);
assert.equal(augmented.tripsStoppingAt.get(entityKey({ feedId, localId: "a" }))?.has(tripKey) ?? false, false);
assert.equal(augmented.tripsStoppingAt.get(entityKey({ feedId, localId: "c" }))?.has(tripKey) ?? false, true);
assert.equal(
	augmented.stopDeparturesCached.has(entityKey({ feedId, localId: "a" })),
	false,
	"changing a trip must invalidate departures for its old stops",
);
assert.equal(getTripIdsByServiceDate(ctx, serviceDate).includes(tripKey), false);
assert.equal(getTripIdsByServiceDate(ctx, nextServiceDate).includes(tripKey), true);

const indexedTripId = "indexed-trip";
const indexedTripKey = entityKey({ feedId, localId: indexedTripId });
const indexedStopTime = (stopId) => ({
	feed_id: feedId,
	passing: true,
	actual_stop_id: stopId,
	actual_parent_station_id: null,
	scheduled_stop_id: stopId,
	scheduled_parent_station_id: null,
});
const indexedTrip = {
	feed_id: feedId,
	trip_id: indexedTripId,
	instances: [
		{
			instance_id: "indexed-instance-old",
			actualTripDates: [serviceDate],
			stopTimes: [indexedStopTime("a"), indexedStopTime("b")],
		},
	],
};
augmented.tripsRec.set(indexedTripKey, indexedTrip);
registerAugmentedTrip(ctx, indexedTrip);
assert.deepEqual(
	[...augmented.passingStopsByTrip.get(indexedTripKey)].sort(),
	["a", "b"].map((stopId) => entityKey({ feedId, localId: stopId })).sort(),
);
assert.equal(augmented.passingTripsSet.get(entityKey({ feedId, localId: "a" }))?.has(indexedTripKey), true);

unregisterAugmentedTrip(ctx, indexedTripKey);
indexedTrip.instances = [
	{
		instance_id: "indexed-instance-new",
		actualTripDates: [serviceDate],
		stopTimes: [indexedStopTime("c"), indexedStopTime("d")],
	},
];
registerAugmentedTrip(ctx, indexedTrip);
assert.equal(
	augmented.passingStopsByTrip.get(indexedTripKey)?.has(entityKey({ feedId, localId: "a" })) ?? false,
	false,
);
assert.equal(augmented.passingStopsByTrip.get(indexedTripKey)?.has(entityKey({ feedId, localId: "c" })) ?? false, true);
assert.equal(augmented.passingTripsSet.get(entityKey({ feedId, localId: "a" }))?.has(indexedTripKey) ?? false, false);
assert.equal(augmented.passingTripsSet.get(entityKey({ feedId, localId: "c" }))?.has(indexedTripKey) ?? false, true);
assert.equal(augmented.instancesRec.has("indexed-instance-old"), false);
assert.equal(augmented.instancesRec.has("indexed-instance-new"), true);
unregisterAugmentedTrip(ctx, indexedTripKey);
augmented.tripsRec.delete(indexedTripKey);

updates = [];
await refreshRealtimeCache(gtfs, config, ctx);

assert.equal(raw.realtimeOnlyTripKeys.has(tripKey), false);
assert.equal(raw.tripsByKey.has(tripKey), false);
assert.equal(augmented.rawTripsRec.has(tripKey), false);
assert.equal(augmented.tripsRec.has(tripKey), false);
assert.equal(augmented.rawStopTimesCache.has(tripKey), false, "removed realtime trips must release retained stop times");
assert.equal(
	augmented.trips.some((trip) => trip.trip_id === tripId),
	false,
);
assert.equal(augmented.tripNumberTrips.get("trip")?.has(tripKey) ?? false, false);
assert.equal(getTripIdsByServiceDate(ctx, serviceDate).includes(tripKey), false);
assert.equal(getTripIdsByServiceDate(ctx, nextServiceDate).includes(tripKey), false);

updates = [realtimeUpdate()];
await refreshRealtimeCache(gtfs, config, ctx);

class TrackingMap extends Map {
	keyIterations = 0;
	valueIterations = 0;
	entryIterations = 0;
	setCalls = 0;

	keys() {
		this.keyIterations += 1;
		return super.keys();
	}

	values() {
		this.valueIterations += 1;
		return super.values();
	}

	entries() {
		this.entryIterations += 1;
		return super.entries();
	}

	[Symbol.iterator]() {
		this.entryIterations += 1;
		return super[Symbol.iterator]();
	}

	set(key, value) {
		this.setCalls += 1;
		return super.set(key, value);
	}
}

class TrackingArray extends Array {
	iterations = 0;

	[Symbol.iterator]() {
		this.iterations += 1;
		return super[Symbol.iterator]();
	}
}

const serviceDateTrips = new TrackingMap(augmented.serviceDateTrips);
const passingTrips = new TrackingMap(augmented.passingTrips);
for (let index = 0; index < 100; index += 1) {
	serviceDateTrips.set(`unrelated-date-${index}`, [`unrelated-trip-${index}`]);
	passingTrips.set(`unrelated-stop-${index}`, [`unrelated-trip-${index}`]);
}
augmented.serviceDateTrips = serviceDateTrips;
augmented.passingTrips = passingTrips;

const rawTripsRec = new TrackingMap(augmented.rawTripsRec);
const tripsRec = new TrackingMap(augmented.tripsRec);
augmented.rawTripsRec = rawTripsRec;
augmented.tripsRec = tripsRec;

const stopsRec = new TrackingMap(augmented.stopsRec);
augmented.stopsRec = stopsRec;
augmented.stops = new TrackingArray(...stops);
const tripsArray = augmented.trips;
const timingCategories = new Set();
augmented.timer = {
	start(category) {
		timingCategories.add(category);
	},
	stop() {},
	log() {},
};

updates = [realtimeUpdate({ timestamp: 2, delay: 60 })];
await refreshRealtimeCache(gtfs, config, ctx);

assert.equal(serviceDateTrips.entryIterations, 0, "realtime refresh must not scan service-date buckets");
assert.equal(passingTrips.entryIterations, 0, "realtime refresh must not scan passing-stop buckets");
assert.equal(rawTripsRec.keyIterations, 0, "realtime refresh must not enumerate static raw trips");
assert.equal(tripsRec.keyIterations, 0, "realtime refresh must not enumerate augmented trips");
assert.equal(tripsRec.valueIterations, 0, "realtime refresh must not rebuild the trip array from all records");
assert.equal(augmented.stops.iterations, 0, "realtime refresh must not scan all stops");
assert.equal(stopsRec.setCalls, 0, "realtime refresh must not rebuild stopsRec");
assert.strictEqual(augmented.trips, tripsArray, "realtime refresh must update the trip list in place");
for (const category of [
	"refreshRealtimeCache:collectChangedIds",
	"refreshRealtimeCache:unregisterChangedTrips",
	"refreshRealtimeCache:fetchRawChangedTrips",
	"refreshRealtimeCache:reaugmentChangedTrips",
	"refreshRealtimeCache:reregisterIndexes",
]) {
	assert.equal(timingCategories.has(category), true, `missing timing category: ${category}`);
}

const streamedTripIds = Array.from({ length: 12 }, (_, index) => `streamed-trip-${index}`);
singleStopTimeQueries = 0;
packedStopTimeQueries = 0;
updates = streamedTripIds.map((id) => realtimeUpdate({ id, timestamp: 2 }));
await refreshRealtimeCache(gtfs, config, ctx);
assert.equal(singleStopTimeQueries, 0, "a cold realtime batch must not query stop times one trip at a time");
assert.equal(packedStopTimeQueries, 1, "a cold realtime batch should use one packed stop-time query per feed");
for (const id of streamedTripIds) {
	assert.equal(
		augmented.rawStopTimesCache.has(entityKey({ feedId, localId: id })),
		true,
		"active realtime trips should keep their batched stop times",
	);
}

let observedIncrementalCheckpoint = false;
config.progressLog = (progress) => {
	if (progress.task !== "Re-augmenting updated trips" || progress.current !== 10) return;
	observedIncrementalCheckpoint = true;
	for (const id of streamedTripIds.slice(0, 10)) {
		const key = entityKey({ feedId, localId: id });
		assert.equal(augmented.tripsRec.get(key)?.instances[0].realtime_update?.timestamp, 3);
	}
	for (const id of streamedTripIds.slice(10)) {
		const key = entityKey({ feedId, localId: id });
		assert.equal(augmented.tripsRec.get(key)?.instances[0].realtime_update?.timestamp, 2);
	}
};
updates = streamedTripIds.map((id) => realtimeUpdate({ id, timestamp: 3, delay: 60 }));
await refreshRealtimeCache(gtfs, config, ctx);
assert.equal(observedIncrementalCheckpoint, true, "realtime trips must be replaced incrementally");

console.log("Realtime cache tests passed.");
