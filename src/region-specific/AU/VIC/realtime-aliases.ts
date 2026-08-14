import { TripScheduleRelationship, type RealtimeUpdateTripInfo } from "qdf-gtfs";
import type { CacheContext } from "../../../cache/types.js";
import { getVLineState } from "./state.js";
import { vlineTdn } from "./identifiers.js";

function serviceKey(tdn: string, serviceDate: string): string {
	return `${tdn}\0${serviceDate}`;
}

function realtimeKey(tdn: string, serviceDate: string, startTime: string): string {
	return `${serviceKey(tdn, serviceDate)}\0${startTime}`;
}

function formatServiceTime(seconds: number): string {
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	const secs = seconds % 60;
	return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
}

function addCandidate(candidates: Map<string, Set<string>>, key: string, tripId: string): void {
	let values = candidates.get(key);
	if (!values) candidates.set(key, (values = new Set()));
	values.add(tripId);
}

/** Index each active V/Line train/date/start time to its durable static trip ID. */
export function buildVLineRealtimeTripAliases(ctx: CacheContext): void {
	const exactCandidates = new Map<string, Set<string>>();
	const serviceCandidates = new Map<string, Set<string>>();

	for (const trip of ctx.augmented.tripsRec.values()) {
		if (trip.feed_id !== "vic-vline") continue;
		const tdn = vlineTdn(trip.trip_id);
		if (!tdn) continue;
		for (const instance of trip.instances) {
			if (!trip.scheduledStartServiceDates.includes(instance.serviceDate)) continue;
			const firstCall = instance.stopTimes.find(
				(stop) => !stop.passing && (stop.scheduled_departure_time != null || stop.scheduled_arrival_time != null),
			);
			const scheduled = firstCall?.scheduled_departure_time ?? firstCall?.scheduled_arrival_time;
			if (scheduled == null) continue;
			addCandidate(serviceCandidates, serviceKey(tdn, instance.serviceDate), trip.trip_id);
			addCandidate(
				exactCandidates,
				realtimeKey(tdn, instance.serviceDate, formatServiceTime(scheduled)),
				trip.trip_id,
			);
		}
	}

	const state = getVLineState(ctx);
	state.canonicalTripIdByRealtimeKey.clear();
	state.canonicalTripIdByServiceKey.clear();
	for (const [key, tripIds] of exactCandidates) {
		if (tripIds.size === 1) state.canonicalTripIdByRealtimeKey.set(key, tripIds.values().next().value!);
	}
	for (const [key, tripIds] of serviceCandidates) {
		if (tripIds.size === 1) state.canonicalTripIdByServiceKey.set(key, tripIds.values().next().value!);
	}
}

/** Map a provider variant to the one active static V/Line trip for this service. */
export function canonicalVLineRealtimeTripId(trip: RealtimeUpdateTripInfo, ctx: CacheContext): string {
	if (
		trip.feed_id !== "vic-vline" ||
		!trip.start_date ||
		(trip.schedule_relationship !== TripScheduleRelationship.SCHEDULED &&
			trip.schedule_relationship !== TripScheduleRelationship.CANCELED)
	) {
		return trip.trip_id;
	}
	const tdn = vlineTdn(trip.trip_id);
	if (!tdn) return trip.trip_id;
	const state = getVLineState(ctx);
	return (
		(trip.start_time
			? state.canonicalTripIdByRealtimeKey.get(realtimeKey(tdn, trip.start_date, trip.start_time))
			: undefined) ??
		state.canonicalTripIdByServiceKey.get(serviceKey(tdn, trip.start_date)) ??
		trip.trip_id
	);
}
