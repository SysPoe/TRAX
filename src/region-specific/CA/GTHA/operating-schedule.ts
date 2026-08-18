import * as qdf from "qdf-gtfs";
import type { GthaOperatingScheduleResponse, GthaOperatingScheduleTrip } from "./types.js";

export const GTHA_OPERATING_SCHEDULE_SOURCE_ID = "gtha-operating-schedule";

type OperatingScheduleResolvers = {
	serviceDayStartEpochSeconds: number;
	resolveTrip: (tripNumber: string, scheduleTrip: GthaOperatingScheduleTrip) => qdf.Trip | null;
	resolveStopId: (stopName: string) => string | null;
};

export type GthaOperatingScheduleBuildResult = {
	updates: qdf.RealtimeTripUpdate[];
	unresolvedTrips: string[];
	unresolvedStops: { tripNumber: string; stopName: string }[];
};

export function isGthaOperatingScheduleForServiceDate(
	value: unknown,
	serviceDate: string,
): value is GthaOperatingScheduleResponse {
	if (!value || typeof value !== "object") return false;
	const response = value as Partial<GthaOperatingScheduleResponse>;
	return (
		typeof response.date === "string" &&
		response.date.slice(0, 10).replaceAll("-", "") === serviceDate &&
		Array.isArray(response.commitmentTrip)
	);
}

function timeSeconds(value: string | null): number | null {
	if (!value) return null;
	const match = /^(\d+):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
	if (!match) return null;
	const hours = Number(match[1]);
	const minutes = Number(match[2]);
	const seconds = Number(match[3] ?? 0);
	if (minutes > 59 || seconds > 59) return null;
	return hours * 3600 + minutes * 60 + seconds;
}

function epochSeconds(serviceDayStart: number, value: string | null): number | null {
	const seconds = timeSeconds(value);
	return seconds == null ? null : serviceDayStart + seconds;
}

/** Convert complete provider override patterns into GTFS-RT replacement trips. */
export function buildGthaOperatingScheduleUpdates(
	response: GthaOperatingScheduleResponse,
	resolvers: OperatingScheduleResolvers,
): GthaOperatingScheduleBuildResult {
	const updates: qdf.RealtimeTripUpdate[] = [];
	const unresolvedTrips: string[] = [];
	const unresolvedStops: { tripNumber: string; stopName: string }[] = [];
	const serviceDate = response.date.slice(0, 10).replaceAll("-", "");
	const timestamp = Math.floor(Date.parse(response.date) / 1000);

	for (const scheduleTrip of response.commitmentTrip) {
		if (!scheduleTrip.stop.some((stop) => stop.isOverride === "1")) continue;
		const trip = resolvers.resolveTrip(scheduleTrip.tripNumber, scheduleTrip);
		if (!trip) {
			unresolvedTrips.push(scheduleTrip.tripNumber);
			continue;
		}

		const providerStops = scheduleTrip.stop
			.filter((stop) => stop.isStopping === "1" || stop.isOverride === "1")
			.sort((a, b) => a.order - b.order);
		const resolvedStops = providerStops.map((stop) => ({ stop, stopId: resolvers.resolveStopId(stop.name) }));
		const missing = resolvedStops.filter((entry) => !entry.stopId);
		if (missing.length > 0) {
			for (const entry of missing) {
				unresolvedStops.push({ tripNumber: scheduleTrip.tripNumber, stopName: entry.stop.name });
			}
			continue;
		}

		const firstTime = providerStops[0]?.schDeparture ?? providerStops[0]?.schArrival ?? "";
		const allCancelled = providerStops.length > 0 && providerStops.every((stop) => stop.isCancelled === "1");
		const tripInfo: qdf.RealtimeUpdateTripInfo = {
			trip_id: trip.trip_id,
			route_id: trip.route_id,
			direction_id: trip.direction_id,
			start_time: firstTime ? `${firstTime}:00`.replace(/:00:00$/, ":00") : "",
			start_date: serviceDate,
			schedule_relationship: allCancelled
				? qdf.TripScheduleRelationship.CANCELED
				: qdf.TripScheduleRelationship.REPLACEMENT,
			feed_id: trip.feed_id,
		};
		const stopTimeUpdates = resolvedStops.map(({ stop, stopId }, index): qdf.RealtimeStopTimeUpdate => ({
			stop_sequence: index + 1,
			stop_id: stopId!,
			trip_id: trip.trip_id,
			start_date: serviceDate,
			start_time: tripInfo.start_time,
			arrival_delay: 0,
			arrival_time: epochSeconds(resolvers.serviceDayStartEpochSeconds, stop.schArrival),
			arrival_uncertainty: null,
			departure_delay: 0,
			departure_time: epochSeconds(resolvers.serviceDayStartEpochSeconds, stop.schDeparture),
			departure_uncertainty: null,
			schedule_relationship:
				stop.isCancelled === "1"
					? qdf.StopTimeScheduleRelationship.SKIPPED
					: qdf.StopTimeScheduleRelationship.SCHEDULED,
			feed_id: trip.feed_id,
			source_id: GTHA_OPERATING_SCHEDULE_SOURCE_ID,
		}));

		updates.push({
			update_id: `GTHA_SCHEDULE_${serviceDate}_${scheduleTrip.tripNumber}`,
			is_deleted: false,
			trip: tripInfo,
			vehicle: { id: "", label: "", license_plate: "" },
			stop_time_updates: stopTimeUpdates,
			timestamp: Number.isFinite(timestamp) ? timestamp : null,
			delay: null,
			feed_id: trip.feed_id,
			source_id: GTHA_OPERATING_SCHEDULE_SOURCE_ID,
		});
	}

	return { updates, unresolvedTrips, unresolvedStops };
}
