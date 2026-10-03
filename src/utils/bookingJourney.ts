import type { AugmentedTripInstance } from "./augmentedTrip.js";
import { serviceTimeToInstant } from "./time.js";

/** Check the next boardable call through the last drop-off, including trains already running. */
export function remainingBookingJourney(trip: AugmentedTripInstance, timeZone: string, now = Date.now()) {
	const calls = trip.stopTimes;
	const end = calls.findLastIndex((call) => !call.passing && call.drop_off_type !== 1
		&& (call.scheduled_arrival_time ?? call.scheduled_departure_time) != null);
	const start = calls.findIndex((call, index) => {
		// Booking search uses the published departure, even when realtime reports a delay.
		const seconds = call.scheduled_departure_time ?? call.scheduled_arrival_time;
		return index < end && !call.passing && call.pickup_type !== 1 && seconds != null
			&& Date.parse(serviceTimeToInstant(trip.serviceDate, seconds, timeZone)) > now;
	});
	return start < 0 ? null : { ...trip, stopTimes: calls.slice(start, end + 1) };
}
