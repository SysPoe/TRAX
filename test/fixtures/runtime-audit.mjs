import { createEmptyRawCache, createEmptyAugmentedCache, createRuntimeState } from "../../dist/cache/factories.js";
import { resolveConfig } from "../../dist/config.js";
import { entityKey } from "../../dist/identity.js";
import { getServiceDayStart } from "../../dist/utils/time.js";
import { StopTimeScheduleRelationship as S, TripScheduleRelationship as T } from "qdf-gtfs";
export { S, T, entityKey, getServiceDayStart };
export const date = "20261003",
	feedId = "rail",
	tripId = "trip",
	routeId = "R";
export const key = entityKey({ feedId, localId: tripId });
export function context(plugins = []) {
	const config = resolveConfig(
		{
			id: "audit",
			name: "Audit",
			feeds: [
				{
					id: feedId,
					staticSource: { url: "https://example.test/feed" },
					realtimeSources: [
						{
							id: "agency",
							targetFeedId: feedId,
							kind: "trip-updates",
							source: { url: "https://example.test/rt" },
						},
					],
				},
			],
			modes: ["rail"],
			plugins,
		},
		{ logFunction() {}, progressLog() {} },
	);
	config.feedTimeZones.set(feedId, "UTC");
	const raw = createEmptyRawCache(),
		augmented = createEmptyAugmentedCache();
	const rows = ["A", "B", "C"].map((stop_id, i) => ({
		feed_id: feedId,
		trip_id: tripId,
		stop_id,
		stop_sequence: i + 1,
		arrival_time: 36000 + i * 600,
		departure_time: 36000 + i * 600,
		pickup_type: 0,
		drop_off_type: 0,
		continuous_pickup: 0,
		continuous_drop_off: 0,
		shape_dist_traveled: null,
		timepoint: 1,
	}));
	const stops = rows.map(({ stop_id }, i) => ({
		feed_id: feedId,
		stop_id,
		stop_name: stop_id,
		stop_lat: 43,
		stop_lon: -79 + i * 0.01,
		parent_station: null,
		platform_code: null,
	}));
	const route = { feed_id: feedId, route_id: routeId, route_type: 2, route_short_name: "R", route_long_name: "Rail" };
	const trip = {
		feed_id: feedId,
		trip_id: tripId,
		route_id: routeId,
		service_id: "daily",
		direction_id: 0,
		shape_id: null,
		trip_headsign: null,
		trip_short_name: null,
		block_id: null,
		wheelchair_accessible: null,
		bikes_allowed: null,
	};
	raw.routesByKey.set(entityKey({ feedId, localId: routeId }), route);
	raw.tripsByKey.set(key, trip);
	raw.stopsByFeed.set(feedId, stops);
	raw.tripStopTimeBoundsByKey.set(key, { feed_id: feedId, trip_id: tripId, start_time: 36000, end_time: 37200 });
	for (const stop of stops) raw.stopsByKey.set(entityKey({ feedId, localId: stop.stop_id }), stop);
	augmented.rawTripsRec.set(key, trip);
	augmented.rawStopTimesCache.set(key, rows);
	const gtfs = {
		getStaticOccupancies: () => [],
		getServiceDatesByTrip: () => [date],
		getServiceDates: () => [date],
		getStops: (filter = {}) => stops.filter((s) => !filter.stop_id || s.stop_id === filter.stop_id),
		getStopTimes: (filter = {}) => rows.filter((s) => !filter.stop_id || s.stop_id === filter.stop_id),
		getStopTimesPacked: () => ({
			strings: [feedId, tripId, "A", "B", "C"],
			tripIds: new Uint32Array([1, 1, 1]),
			feedIds: new Uint32Array([0, 0, 0]),
			stopIds: new Uint32Array([2, 3, 4]),
			arrivalTimes: new Int32Array(rows.map((r) => r.arrival_time)),
			departureTimes: new Int32Array(rows.map((r) => r.departure_time)),
			stopSequences: new Int32Array([1, 2, 3]),
			stopHeadsigns: new Uint32Array([0xffffffff, 0xffffffff, 0xffffffff]),
			pickupTypes: new Uint8Array(3),
			dropOffTypes: new Uint8Array(3),
			shapeDistances: new Float64Array([NaN, NaN, NaN]),
			timepoints: new Int8Array([1, 1, 1]),
			continuousPickups: new Int8Array(3),
			continuousDropOffs: new Int8Array(3),
		}),
		getRealtimeTripUpdates: () => [],
		getRealtimeVehiclePositions: () => [],
		getTrips: () => [],
		getTransfers: () => [],
	};
	const ctx = { config, raw, augmented, runtimeState: createRuntimeState(), pluginState: new Map(), gtfs };
	ctx.runtimeState.srtNetworkData = { matrix: {}, adjacency: {}, lastUpdated: Date.now() };
	return { ctx, trip, route, rows, stops, gtfs };
}
export function update(calls, opts = {}) {
	return {
		update_id: opts.id ?? "agency",
		is_deleted: false,
		feed_id: feedId,
		source_id: opts.source ?? "agency",
		timestamp: opts.timestamp ?? Date.now() / 1000,
		delay: opts.delay ?? null,
		trip: {
			feed_id: feedId,
			trip_id: tripId,
			route_id: routeId,
			direction_id: 0,
			start_time: opts.startTime ?? "",
			start_date: date,
			schedule_relationship: T.SCHEDULED,
		},
		vehicle: { id: "", label: "", license_plate: "" },
		stop_time_updates: calls.map((call) => ({
			stop_sequence: null,
			stop_id: "",
			trip_id: tripId,
			start_date: date,
			start_time: null,
			arrival_delay: null,
			arrival_time: null,
			arrival_uncertainty: null,
			departure_delay: null,
			departure_time: null,
			departure_uncertainty: null,
			schedule_relationship: S.SCHEDULED,
			feed_id: feedId,
			source_id: opts.source ?? "agency",
			...call,
		})),
	};
}
