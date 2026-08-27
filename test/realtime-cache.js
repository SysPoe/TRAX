import assert from "node:assert/strict";
import { RouteType, StopTimeScheduleRelationship, TripScheduleRelationship } from "qdf-gtfs";
import { refreshRealtimeCache } from "../dist/cache/refreshCaches.js";
import { createEmptyAugmentedCache, createEmptyRawCache, createRuntimeState } from "../dist/cache/factories.js";
import { resolveConfig } from "../dist/config.js";
import { entityKey } from "../dist/identity.js";

const feedId = "feed";
const routeId = "rail";
const tripId = "realtime-trip";
const serviceDate = "20260827";
const tripKey = entityKey({ feedId, localId: tripId });

const stops = ["a", "b", "d"].map((stop_id, index) => ({
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
	getStopTimes: () => [],
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

function realtimeUpdate() {
	return {
		update_id: "update-1",
		is_deleted: false,
		trip: {
			trip_id: tripId,
			route_id: routeId,
			direction_id: 0,
			start_time: "10:00:00",
			start_date: serviceDate,
			schedule_relationship: TripScheduleRelationship.ADDED,
			feed_id: feedId,
		},
		vehicle: { id: "", label: "", license_plate: "" },
		stop_time_updates: stops.map((stop) => ({
			stop_sequence: null,
			stop_id: stop.stop_id,
			start_date: serviceDate,
			start_time: "10:00:00",
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
		timestamp: 0,
		delay: null,
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
assert.deepEqual(
	augmented.tripsRec.get(tripKey)?.instances[0].stopTimes.map((stopTime) => stopTime.actual_stop_id),
	["a", "b", "d"],
);
assert.equal(augmented.serviceDateTrips.get(serviceDate)?.includes(tripKey), true);

updates = [];
await refreshRealtimeCache(gtfs, config, ctx);

assert.equal(raw.realtimeOnlyTripKeys.has(tripKey), false);
assert.equal(raw.tripsByKey.has(tripKey), false);
assert.equal(augmented.rawTripsRec.has(tripKey), false);
assert.equal(augmented.tripsRec.has(tripKey), false);
assert.equal(
	augmented.trips.some((trip) => trip.trip_id === tripId),
	false,
);
assert.equal(augmented.tripNumberTrips.get("trip")?.has(tripKey) ?? false, false);
assert.equal(augmented.serviceDateTrips.get(serviceDate)?.includes(tripKey) ?? false, false);

console.log("Realtime cache tests passed.");
