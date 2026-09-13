import { StopTimeScheduleRelationship, TripScheduleRelationship } from "qdf-gtfs";
import type { AugmentedStopTime, BoardingLocation } from "../../../utils/augmentedStopTime.js";
import type { AugmentedTripInstance } from "../../../utils/augmentedTrip.js";
import { getEpochDayFromServiceDate } from "../../../utils/time.js";

type PlatformEvidence = { location: BoardingLocation; direct: boolean };

function isCanceledTripInstance(instance: { schedule_relationship?: unknown } | null | undefined): boolean {
	return (
		(instance as { schedule_relationship?: unknown } | null)?.schedule_relationship ===
		TripScheduleRelationship.CANCELED
	);
}

function isSkippedStopTime(
	stopTime: { passing?: boolean; realtime?: boolean; realtime_info?: { schedule_relationship?: unknown } | null } | null | undefined,
): boolean {
	if (!stopTime || stopTime.passing) return Boolean(stopTime?.passing);
	if (!stopTime.realtime || !stopTime.realtime_info) return false;
	const relationship = (stopTime.realtime_info as { schedule_relationship?: unknown }).schedule_relationship;
	return (
		relationship === StopTimeScheduleRelationship.SKIPPED ||
		relationship === StopTimeScheduleRelationship.NO_DATA
	);
}

/** Absolute service instant for block ordering without requiring cache context. */
function blockAbsoluteTime(
	serviceDate: string | null | undefined,
	secs: number | null | undefined,
	dateOffset?: number | null,
): number | null {
	if (secs == null || !Number.isFinite(secs)) return null;
	const offset = Number.isFinite(dateOffset as number) ? (dateOffset as number) : 0;
	if (serviceDate != null && /^\d{8}$/.test(serviceDate)) {
		try {
			const day = getEpochDayFromServiceDate(serviceDate);
			if (Number.isFinite(day)) {
				// Raw already encodes overflow (>=86400); trust it to avoid
				// double-counting a relative offset. Normalized wall times use the
				// explicit offset for their calendar day.
				const raw = secs >= 86400 ? secs : secs + (offset || 0) * 86400;
				return day * 86400 + raw;
			}
		} catch {
			// Fall through to raw below.
		}
	}
	if (offset) return secs + offset * 86400;
	return secs;
}

function tripDepartureAbsolute(trip: AugmentedTripInstance): number | null {
	const first = trip.stopTimes[0];
	if (!first) return null;
	const secs = first.scheduled_departure_time ?? first.actual_departure_time;
	const offset =
		first.scheduled_departure_date_offset ?? first.actual_departure_date_offset ?? 0;
	const abs = blockAbsoluteTime((trip as { serviceDate?: string }).serviceDate, secs, offset);
	if (abs != null) return abs;
	return secs ?? null;
}

function stopPlaceId(stopTime: AugmentedStopTime): string | null {
	return (
		stopTime.actual_parent_station_id ??
		stopTime.actual_stop_id ??
		stopTime.scheduled_parent_station_id ??
		stopTime.scheduled_stop_id
	);
}

function platformEvidence(
	stopTime: AugmentedStopTime,
	event: "arrival" | "departure",
	observedAt: string,
): PlatformEvidence | null {
	const locations =
		event === "arrival" ? stopTime.actual_arrival_boarding_locations : stopTime.actual_departure_boarding_locations;
	const directLocation = locations.find(
		(location) => (location.kind === "track" || location.kind === "platform") && location.confidence !== "inferred",
	);
	if (directLocation) return { location: directLocation, direct: true };
	if (stopTime.rt_platform_code_updated && stopTime.actual_platform_code) {
		return {
			location: {
				kind: "platform",
				value: stopTime.actual_platform_code,
				source: "GTHA realtime",
				observed_at: observedAt,
				confidence: "reported",
			},
			direct: true,
		};
	}
	if (!stopTime.scheduled_platform_code) return null;
	return {
		location: {
			kind: "platform",
			value: stopTime.scheduled_platform_code,
			source: "GTFS schedule",
			observed_at: observedAt,
			confidence: "inferred",
		},
		direct: false,
	};
}

function applyInferredPlatform(
	stopTime: AugmentedStopTime,
	event: "arrival" | "departure",
	platform: BoardingLocation,
	sourceInstanceId: string,
): void {
	const locations =
		event === "arrival" ? stopTime.actual_arrival_boarding_locations : stopTime.actual_departure_boarding_locations;
	if (
		stopTime.rt_platform_code_updated ||
		locations.some((location) => location.kind === "track" || location.kind === "platform")
	)
		return;

	const inferred: BoardingLocation = {
		kind: platform.kind,
		value: platform.value,
		source: `Block handoff from ${sourceInstanceId}`,
		observed_at: platform.observed_at,
		confidence: "inferred",
	};
	if (event === "arrival") stopTime.actual_arrival_boarding_locations = [inferred, ...locations];
	else stopTime.actual_departure_boarding_locations = [inferred, ...locations];
}

function inferredRealtimeInfo(stopTime: AugmentedStopTime, delaySecs: number) {
	const roundedMinutes = Math.round(Math.abs(delaySecs) / 60);
	const onTime = Math.abs(delaySecs) <= 60;
	return {
		delay_secs: delaySecs,
		delay_string: onTime ? "on time" : `${roundedMinutes}m ${delaySecs < 0 ? "early" : "late"}`,
		delay_class: onTime
			? ("on-time" as const)
			: delaySecs < 0
				? ("early" as const)
				: delaySecs <= 300
					? ("late" as const)
					: ("very-late" as const),
		schedule_relationship: stopTime.realtime_info?.schedule_relationship ?? StopTimeScheduleRelationship.SCHEDULED,
		propagated: true,
		rt_start_date: stopTime.realtime_info?.rt_start_date ?? null,
	};
}

/** Apply a physical minimum delay to calls without direct realtime observations. */
function applyMinimumTripDelay(trip: AugmentedTripInstance, minimumDelaySecs: number): void {
	let carriedDelay = minimumDelaySecs;
	for (const stopTime of trip.stopTimes) {
		const relationship = stopTime.realtime_info?.schedule_relationship;
		if (
			relationship === StopTimeScheduleRelationship.SKIPPED ||
			relationship === StopTimeScheduleRelationship.NO_DATA
		)
			continue;

		if (
			stopTime.rt_arrival_updated &&
			stopTime.scheduled_arrival_time != null &&
			stopTime.actual_arrival_time != null
		) {
			const directDelay = stopTime.actual_arrival_time - stopTime.scheduled_arrival_time;
			// Enforce the handoff minimum even when a direct observation exists:
			// a later direct call must not run before the delayed vehicle.
			carriedDelay = Math.max(carriedDelay, directDelay);
		} else if (stopTime.scheduled_arrival_time != null) {
			stopTime.actual_arrival_time = Math.max(
				stopTime.actual_arrival_time ?? Number.NEGATIVE_INFINITY,
				stopTime.scheduled_arrival_time + carriedDelay,
			);
			carriedDelay = stopTime.actual_arrival_time - stopTime.scheduled_arrival_time;
		}

		if (
			stopTime.rt_departure_updated &&
			stopTime.scheduled_departure_time != null &&
			stopTime.actual_departure_time != null
		) {
			const directDelay = stopTime.actual_departure_time - stopTime.scheduled_departure_time;
			carriedDelay = Math.max(carriedDelay, directDelay);
			continue;
		}
		if (stopTime.scheduled_departure_time != null) {
			stopTime.actual_departure_time = Math.max(
				stopTime.actual_departure_time ?? Number.NEGATIVE_INFINITY,
				stopTime.scheduled_departure_time + carriedDelay,
			);
			carriedDelay = stopTime.actual_departure_time - stopTime.scheduled_departure_time;
		}

		const scheduled = stopTime.scheduled_departure_time ?? stopTime.scheduled_arrival_time;
		const actual = stopTime.actual_departure_time ?? stopTime.actual_arrival_time;
		if (scheduled != null && actual != null && (!stopTime.realtime || stopTime.realtime_info?.propagated)) {
			stopTime.realtime = true;
			stopTime.realtime_info = inferredRealtimeInfo(stopTime, actual - scheduled);
		}
	}
}

/** Share defensible platform and timing facts between consecutive services on the same vehicle block. */
export function propagateBlockHandoffs(
	blockMap: Map<string, AugmentedTripInstance[]>,
	observedAt = new Date().toISOString(),
): void {
	for (const trips of blockMap.values()) {
		const ordered = [...trips].sort((a, b) => {
			const aAbs = tripDepartureAbsolute(a);
			const bAbs = tripDepartureAbsolute(b);
			if (aAbs != null && bAbs != null && aAbs !== bAbs) return aAbs - bAbs;
			return (
				(a.stopTimes[0]?.scheduled_departure_time ?? Number.POSITIVE_INFINITY) -
				(b.stopTimes[0]?.scheduled_departure_time ?? Number.POSITIVE_INFINITY)
			);
		});
		for (let index = 0; index < ordered.length - 1; index++) {
			const incoming = ordered[index];
			const outgoing = ordered[index + 1];
			// Canceled trips break the handoff chain without resurrecting predictions.
			if (isCanceledTripInstance(incoming) || isCanceledTripInstance(outgoing)) continue;
			const arrival = incoming.stopTimes.at(-1);
			const departure = outgoing.stopTimes[0];
			if (!arrival || !departure || !stopPlaceId(arrival) || stopPlaceId(arrival) !== stopPlaceId(departure))
				continue;
			// Skipped or non-data calls carry no platform or timing to share.
			if (isSkippedStopTime(arrival) || isSkippedStopTime(departure)) continue;

			const arrivalPlatform = platformEvidence(arrival, "arrival", observedAt);
			const departurePlatform = platformEvidence(departure, "departure", observedAt);
			if (arrivalPlatform?.direct && !departurePlatform?.direct) {
				applyInferredPlatform(departure, "departure", arrivalPlatform.location, incoming.instance_id);
			} else if (departurePlatform?.direct && !arrivalPlatform?.direct) {
				applyInferredPlatform(arrival, "arrival", departurePlatform.location, outgoing.instance_id);
			} else if (arrivalPlatform && !departurePlatform) {
				applyInferredPlatform(departure, "departure", arrivalPlatform.location, incoming.instance_id);
			} else if (departurePlatform && !arrivalPlatform) {
				applyInferredPlatform(arrival, "arrival", departurePlatform.location, outgoing.instance_id);
			}

			const scheduledDeparture = departure.scheduled_departure_time;
			const actualArrival = arrival.actual_arrival_time;
			// A propagated arrival is a valid chained source; a direct departure
			// must never be overwritten. Check propagated separately so inferred
			// realtime is not conflated with authoritative observations.
			const arrivalHasRealtime = arrival.realtime || arrival.rt_arrival_updated;
			const departureHasDirect =
				departure.rt_arrival_updated ||
				departure.rt_departure_updated ||
				(departure.realtime && !departure.realtime_info?.propagated);
			if (
				!arrivalHasRealtime ||
				departureHasDirect ||
				scheduledDeparture == null ||
				actualArrival == null
			)
				continue;
			const incomingServiceDate = (incoming as { serviceDate?: string }).serviceDate;
			const outgoingServiceDate = (outgoing as { serviceDate?: string }).serviceDate;
			const arrivalOffset =
				arrival.actual_arrival_date_offset ?? arrival.scheduled_arrival_date_offset ?? 0;
			const departureOffset =
				departure.scheduled_departure_date_offset ?? departure.actual_departure_date_offset ?? 0;
			const arrivalAbs = blockAbsoluteTime(incomingServiceDate, actualArrival, arrivalOffset);
			const scheduledDepAbs = blockAbsoluteTime(outgoingServiceDate, scheduledDeparture, departureOffset);
			if (arrivalAbs == null || scheduledDepAbs == null) continue;
			const minimumDelay = arrivalAbs - scheduledDepAbs;
			if (minimumDelay > 0) applyMinimumTripDelay(outgoing, minimumDelay);
		}
	}
}
