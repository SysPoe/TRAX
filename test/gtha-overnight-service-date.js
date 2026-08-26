import assert from "node:assert/strict";
import { createCaGthaNetwork } from "../dist/index.js";
import {
	canonicalizeRealtimeTripUpdate,
	canonicalizeRealtimeVehiclePosition,
} from "../dist/cache/realtime.js";
import { TripScheduleRelationship } from "qdf-gtfs";

const tripId = "20260825-LE-9140";
const network = createCaGthaNetwork();
const context = {
	config: { network },
	raw: {},
	augmented: {
		rawStopTimesCache: new Map([
			[
				`2:go${tripId}`,
				[
					{
						feed_id: "go",
						trip_id: tripId,
						stop_id: "UN",
						stop_sequence: 1,
						arrival_time: 24 * 60 * 60 + 20 * 60,
						departure_time: 24 * 60 * 60 + 20 * 60,
					},
				],
			],
		]),
	},
	pluginState: new Map(),
};
const descriptor = {
	feed_id: "go",
	trip_id: tripId,
	route_id: "LE",
	direction_id: 0,
	start_time: "00:20:00",
	start_date: "20260826",
	schedule_relationship: TripScheduleRelationship.SCHEDULED,
};
const update = canonicalizeRealtimeTripUpdate(
	{
		update_id: "overnight-go",
		is_deleted: false,
		trip: descriptor,
		vehicle: { id: "677", label: "677", license_plate: "" },
		stop_time_updates: [
			{
				trip_id: tripId,
				start_date: "20260826",
				start_time: "00:20:00",
				feed_id: "go",
				stop_sequence: 1,
				stop_id: "UN",
			},
		],
		timestamp: null,
		delay: null,
		feed_id: "go",
		source_id: "go-trip-updates",
	},
	context,
);

assert.equal(
	update.trip.start_date,
	"20260825",
	"GO realtime must map a calendar-date 00:20 descriptor back to its static 24:20 service date",
);
assert.equal(update.stop_time_updates[0].start_date, "20260825");
assert.equal(
	canonicalizeRealtimeTripUpdate(
		{ ...update, trip: { ...descriptor, start_date: "20260825", start_time: "24:20:00" } },
		context,
	).trip.start_date,
	"20260825",
	"a standards-compliant 24:20 descriptor must keep its supplied service date",
);
assert.equal(
	canonicalizeRealtimeTripUpdate(
		{ ...update, trip: { ...descriptor, start_time: "00:21:00" } },
		context,
	).trip.start_date,
	"20260826",
	"a realtime clock that does not match the static trip start must not be shifted",
);

const plugin = network.plugins.find((candidate) => candidate.id === "ca-gtha");
assert.ok(plugin?.enrichVehiclePosition);
const vehicle = plugin.enrichVehiclePosition(
	canonicalizeRealtimeVehiclePosition(
		{
			feed_id: "go",
			trip: { ...descriptor, start_time: "00:20" },
			vehicle: { id: "677", label: "677", license_plate: "" },
			position: { latitude: 43.64, longitude: -79.38, bearing: 42, odometer: null, speed: 0 },
			timestamp: null,
			stop_id: "EG",
			current_stop_sequence: 4,
			current_status: 2,
			congestion_level: 0,
			occupancy_status: 0,
			occupancy_percentage: null,
			source_id: "go-vehicles",
		},
		context,
	),
	context,
);
assert.equal(vehicle.trip.start_date, "20260825");
