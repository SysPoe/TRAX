import type { RealtimeTripUpdate, RealtimeUpdateTripInfo, RealtimeVehiclePosition } from "qdf-gtfs";
import { getRawStopTimes } from "../../../cache/gtfsReads.js";
import type { CacheContext } from "../../../cache/types.js";
import { addDaysToServiceDate } from "../../../utils/time.js";

const SECONDS_PER_DAY = 24 * 60 * 60;

function parseGtfsTime(value: string): number | null {
	const match = /^(\d+):(\d{2})(?::(\d{2}))?$/.exec(value);
	if (!match) return null;
	const hours = Number(match[1]);
	const minutes = Number(match[2]);
	const seconds = Number(match[3] ?? 0);
	if (minutes > 59 || seconds > 59) return null;
	return hours * 60 * 60 + minutes * 60 + seconds;
}

type GthaRealtimeTripIdentity = {
	feedId: string;
	tripId: string;
	startDate: string;
	startTime: string;
};

/**
 * Metrolinx dates after-midnight realtime descriptors by the wall-clock day,
 * while its static trip remains on the prior service day with a 24+ hour time.
 */
export function normalizeGthaRealtimeServiceDate(identity: GthaRealtimeTripIdentity, ctx: CacheContext): string {
	const scheduledStart = getRawStopTimes(ctx, { feedId: identity.feedId, localId: identity.tripId }).reduce(
		(earliest, stopTime) =>
			Math.min(
				earliest,
				stopTime.departure_time ?? Number.POSITIVE_INFINITY,
				stopTime.arrival_time ?? Number.POSITIVE_INFINITY,
			),
		Number.POSITIVE_INFINITY,
	);
	if (!Number.isFinite(scheduledStart)) return identity.startDate;

	const scheduledDayOffset = Math.floor(scheduledStart / SECONDS_PER_DAY);
	if (scheduledDayOffset <= 0) return identity.startDate;
	const realtimeStart = parseGtfsTime(identity.startTime);
	if (realtimeStart === null || realtimeStart >= SECONDS_PER_DAY) return identity.startDate;
	if (realtimeStart !== scheduledStart % SECONDS_PER_DAY) return identity.startDate;

	return addDaysToServiceDate(identity.startDate, -scheduledDayOffset);
}

export function normalizeGthaRealtimeTripInfo(trip: RealtimeUpdateTripInfo, ctx: CacheContext): RealtimeUpdateTripInfo {
	if (!trip.trip_id || !trip.start_date || !trip.start_time) return trip;
	const startDate = normalizeGthaRealtimeServiceDate(
		{
			feedId: trip.feed_id,
			tripId: trip.trip_id,
			startDate: trip.start_date,
			startTime: trip.start_time,
		},
		ctx,
	);
	if (startDate === trip.start_date) return trip;

	return {
		...trip,
		start_date: startDate,
	};
}

export function normalizeGthaRealtimeTripUpdate(update: RealtimeTripUpdate, ctx: CacheContext): RealtimeTripUpdate {
	const trip = normalizeGthaRealtimeTripInfo(update.trip, ctx);
	if (trip === update.trip) return update;
	return {
		...update,
		trip,
		stop_time_updates: update.stop_time_updates.map((stopTime) =>
			stopTime.start_date === update.trip.start_date ? { ...stopTime, start_date: trip.start_date } : stopTime,
		),
	};
}

export function normalizeGthaRealtimeVehiclePosition(
	position: RealtimeVehiclePosition,
	ctx: CacheContext,
): RealtimeVehiclePosition {
	const trip = normalizeGthaRealtimeTripInfo(position.trip, ctx);
	return trip === position.trip ? position : { ...position, trip };
}
