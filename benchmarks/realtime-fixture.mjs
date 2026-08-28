import { refreshStaticCache } from "../dist/cache/refreshCaches.js";
import { resolveConfig } from "../dist/config.js";

const FEED_ID = "benchmark-feed";
const ROUTE_ID = "benchmark-route";
const STOP_COUNT = 6;
const TRIP_COUNT = 100;
const SERVICE_DATES = ["20260826", "20260827", "20260828", "20260829", "20260830"];

function createFixtureRows() {
	const dates = SERVICE_DATES;
	const stops = Array.from({ length: STOP_COUNT }, (_, index) => ({
		stop_id: `stop-${index}`,
		stop_code: null,
		stop_name: `Benchmark Stop ${index}`,
		stop_desc: null,
		stop_lat: -27.4,
		stop_lon: 153 + index / 1000,
		zone_id: null,
		stop_url: null,
		location_type: null,
		parent_station: null,
		stop_timezone: "Australia/Brisbane",
		wheelchair_boarding: null,
		level_id: null,
		platform_code: null,
		feed_id: FEED_ID,
	}));
	const route = {
		route_id: ROUTE_ID,
		agency_id: null,
		route_short_name: "B",
		route_long_name: "Benchmark Rail",
		route_desc: null,
		route_type: 2,
		route_url: null,
		route_color: null,
		route_text_color: null,
		continuous_pickup: null,
		continuous_drop_off: null,
		route_sort_order: null,
		network_id: null,
		feed_id: FEED_ID,
	};
	const trips = Array.from({ length: TRIP_COUNT }, (_, index) => ({
		trip_id: `trip-${String(index).padStart(3, "0")}`,
		route_id: ROUTE_ID,
		service_id: "benchmark-service",
		trip_headsign: "Benchmark Terminal",
		trip_short_name: String(index),
		direction_id: index % 2,
		block_id: null,
		shape_id: null,
		wheelchair_accessible: null,
		bikes_allowed: null,
		feed_id: FEED_ID,
	}));
	const stopTimes = trips.flatMap((trip, tripIndex) =>
		stops.map((stop, stopIndex) => {
			const seconds = 6 * 3600 + tripIndex * 60 + stopIndex * 300;
			return {
				trip_id: trip.trip_id,
				arrival_time: seconds,
				departure_time: seconds + 30,
				stop_id: stop.stop_id,
				stop_sequence: stopIndex + 1,
				stop_headsign: null,
				pickup_type: 0,
				drop_off_type: 0,
				timepoint: 1,
				shape_dist_traveled: null,
				feed_id: FEED_ID,
			};
		}),
	);
	return { dates, stops, route, trips, stopTimes };
}

function createGtfs(rows, updates) {
	return {
		getAgencies: () => [],
		getStops: (filter = {}) =>
			rows.stops.filter(
				(stop) =>
					(!filter.feed_id || filter.feed_id === stop.feed_id) &&
					(!filter.stop_id || filter.stop_id === stop.stop_id),
			),
		getRoutes: (filter = {}) =>
			(filter.feed_id && filter.feed_id !== FEED_ID) || (filter.route_id && filter.route_id !== ROUTE_ID)
				? []
				: [rows.route],
		getTrips: (filter = {}) =>
			rows.trips.filter(
				(trip) =>
					(!filter.feed_id || filter.feed_id === trip.feed_id) &&
					(!filter.trip_id || filter.trip_id === trip.trip_id),
			),
		getStopTimes: (filter = {}) => {
			const tripIds = filter.trip_ids ? new Set(filter.trip_ids) : null;
			return rows.stopTimes.filter(
				(stopTime) =>
					(!filter.feed_id || filter.feed_id === stopTime.feed_id) &&
					(!filter.trip_id || filter.trip_id === stopTime.trip_id) &&
					(!tripIds || tripIds.has(stopTime.trip_id)) &&
					(!filter.stop_id || filter.stop_id === stopTime.stop_id),
			);
		},
		getTripStopTimeBounds: () => [],
		getStaticOccupancies: () => [],
		getTransfers: () => [],
		getShapes: () => [],
		getCalendars: () => [],
		getCalendarDates: () => [],
		getServiceDates: () => rows.dates,
		getRealtimeTripUpdates: () => updates,
	};
}

function createNetwork() {
	return {
		id: "benchmark-realtime-cache",
		name: "TRAX realtime cache benchmark",
		feeds: [
			{
				id: FEED_ID,
				staticSource: { url: "https://benchmark.invalid/static.zip" },
				realtimeSources: [],
			},
		],
		modes: ["rail"],
		plugins: [],
	};
}

function makeUpdate(trip, date, index) {
	return {
		update_id: `update-${index}`,
		is_deleted: false,
		trip: {
			trip_id: trip.trip_id,
			route_id: trip.route_id,
			direction_id: trip.direction_id,
			start_time: "06:00:00",
			start_date: date,
			schedule_relationship: 0,
			feed_id: FEED_ID,
		},
		vehicle: { id: "", label: "", license_plate: "" },
		stop_time_updates: Array.from({ length: STOP_COUNT }, (_, stopIndex) => ({
			stop_sequence: stopIndex + 1,
			stop_id: `stop-${stopIndex}`,
			trip_id: trip.trip_id,
			start_date: date,
			start_time: "06:00:00",
			arrival_delay: 30,
			arrival_time: null,
			arrival_uncertainty: null,
			departure_delay: 30,
			departure_time: null,
			departure_uncertainty: null,
			schedule_relationship: 0,
			feed_id: FEED_ID,
			source_id: "benchmark-realtime",
		})),
		timestamp: 0,
		delay: 30,
		feed_id: FEED_ID,
		source_id: "benchmark-realtime",
	};
}

export async function createRealtimeFixture(changedTripCount) {
	const rows = createFixtureRows();
	const config = resolveConfig(createNetwork(), {
		disableTimers: true,
		logFunction: () => {},
		progressLog: () => {},
	});
	config.feedTimeZones.set(FEED_ID, "Australia/Brisbane");
	const updates = rows.trips.slice(0, changedTripCount).map((trip, index) => makeUpdate(trip, rows.dates[2], index));
	const gtfs = createGtfs(rows, updates);
	const ctx = await refreshStaticCache(gtfs, config);
	return { ctx, config, gtfs, rows, updates };
}

export { FEED_ID, TRIP_COUNT };
