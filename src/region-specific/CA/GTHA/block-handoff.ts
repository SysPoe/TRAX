import { StopTimeScheduleRelationship } from "qdf-gtfs";
import type { AugmentedStopTime, BoardingLocation } from "../../../utils/augmentedStopTime.js";
import type { AugmentedTripInstance } from "../../../utils/augmentedTrip.js";

type PlatformEvidence = { location: BoardingLocation; direct: boolean };

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
	stopTime.actual_platform_code = inferred.value;
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
		if (stopTime.realtime_info?.schedule_relationship === StopTimeScheduleRelationship.SKIPPED) continue;

		if (
			stopTime.rt_arrival_updated &&
			stopTime.scheduled_arrival_time != null &&
			stopTime.actual_arrival_time != null
		) {
			carriedDelay = stopTime.actual_arrival_time - stopTime.scheduled_arrival_time;
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
			carriedDelay = stopTime.actual_departure_time - stopTime.scheduled_departure_time;
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
		const ordered = [...trips].sort(
			(a, b) =>
				(a.stopTimes[0]?.scheduled_departure_time ?? Number.POSITIVE_INFINITY) -
				(b.stopTimes[0]?.scheduled_departure_time ?? Number.POSITIVE_INFINITY),
		);
		for (let index = 0; index < ordered.length - 1; index++) {
			const incoming = ordered[index];
			const outgoing = ordered[index + 1];
			const arrival = incoming.stopTimes.at(-1);
			const departure = outgoing.stopTimes[0];
			if (!arrival || !departure || !stopPlaceId(arrival) || stopPlaceId(arrival) !== stopPlaceId(departure))
				continue;

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
			if (
				(!arrival.realtime && !arrival.rt_arrival_updated) ||
				departure.rt_arrival_updated ||
				departure.rt_departure_updated ||
				scheduledDeparture == null ||
				actualArrival == null
			)
				continue;
			const minimumDelay = actualArrival - scheduledDeparture;
			if (minimumDelay > 0) applyMinimumTripDelay(outgoing, minimumDelay);
		}
	}
}
