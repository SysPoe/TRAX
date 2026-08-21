import * as qdf from "qdf-gtfs";
import type { CacheContext } from "../cache/types.js";
import { canonicalStationIdentity, getFeedTimeZone } from "../config.js";
import { entityKey } from "../identity.js";
import type { AugmentedStopTime } from "./augmentedStopTime.js";
import type { AugmentedTripInstance } from "./augmentedTrip.js";
import { getServiceDayStart } from "./time.js";

const FALLBACK_MAX_GAP_SECONDS = 30 * 60;
const INFERRED_MIN_GAP_SECONDS = 90;

export type ReachabilityOrigin = {
	stopIds: readonly string[];
	/** GTFS service-day seconds for the departure event, used to disambiguate loop calls. */
	departureTime?: number | null;
};

export type PassengerContinuationSource = "gtfs-transfer" | "gtfs-block" | "seq-inferred";

export type OnboardReachableStop = {
	feed_id: string;
	instance_id: string;
	trip_id: string;
	stop_id: string | null;
	parent_station_id: string | null;
	station_name: string | null;
	continuation_count: number;
	continuation_source: PassengerContinuationSource | null;
};

type ContinuationEdge = {
	next: AugmentedTripInstance;
	source: PassengerContinuationSource;
};

function localStopIds(stopTime: AugmentedStopTime): string[] {
	return [
		stopTime.actual_stop_id,
		stopTime.actual_parent_station_id,
		stopTime.scheduled_stop_id,
		stopTime.scheduled_parent_station_id,
	].filter((id): id is string => id != null);
}

function platformStopIds(stopTime: AugmentedStopTime): string[] {
	return [stopTime.actual_stop_id, stopTime.scheduled_stop_id].filter((id): id is string => id != null);
}

function canonicalStopKey(ctx: CacheContext, stopTime: AugmentedStopTime): string | null {
	const localId =
		stopTime.actual_parent_station_id ??
		stopTime.scheduled_parent_station_id ??
		stopTime.actual_stop_id ??
		stopTime.scheduled_stop_id;
	if (!localId) return null;
	return entityKey(canonicalStationIdentity(ctx.config, { feedId: stopTime.feed_id, localId }));
}

function stationName(stopTime: AugmentedStopTime): string | null {
	return (
		stopTime.actual_parent_station?.stop_name ??
		stopTime.actual_stop?.stop_name ??
		stopTime.scheduled_parent_station?.stop_name ??
		stopTime.scheduled_stop?.stop_name ??
		null
	);
}

function departureSeconds(stopTime: AugmentedStopTime): number | null {
	return (
		stopTime.actual_departure_time ??
		stopTime.scheduled_departure_time ??
		stopTime.actual_arrival_time ??
		stopTime.scheduled_arrival_time
	);
}

function absoluteEventSeconds(
	ctx: CacheContext,
	stopTime: AugmentedStopTime,
	event: "arrival" | "departure",
): number | null {
	const actualTime = event === "arrival" ? stopTime.actual_arrival_time : stopTime.actual_departure_time;
	const scheduledTime = event === "arrival" ? stopTime.scheduled_arrival_time : stopTime.scheduled_departure_time;
	const seconds = actualTime ?? scheduledTime;
	if (seconds == null) return null;
	const offset =
		event === "arrival"
			? actualTime != null
				? stopTime.actual_arrival_date_offset
				: stopTime.scheduled_arrival_date_offset
			: actualTime != null
				? stopTime.actual_departure_date_offset
				: stopTime.scheduled_departure_date_offset;
	return (
		getServiceDayStart(stopTime.service_date, getFeedTimeZone(ctx.config, stopTime.feed_id)) +
		offset * 86400 +
		seconds
	);
}

function handoffGapSeconds(
	ctx: CacheContext,
	current: AugmentedTripInstance,
	next: AugmentedTripInstance,
): number | null {
	const currentLast = current.stopTimes.at(-1);
	const nextFirst = next.stopTimes[0];
	if (!currentLast || !nextFirst) return null;
	const arrival =
		absoluteEventSeconds(ctx, currentLast, "arrival") ?? absoluteEventSeconds(ctx, currentLast, "departure");
	const departure =
		absoluteEventSeconds(ctx, nextFirst, "departure") ?? absoluteEventSeconds(ctx, nextFirst, "arrival");
	return arrival == null || departure == null ? null : departure - arrival;
}

function findInstanceForDate(
	ctx: CacheContext,
	feedId: string,
	tripId: string,
	serviceDate: string,
): AugmentedTripInstance | null {
	const trip = ctx.augmented.tripsRec.get(entityKey({ feedId, localId: tripId }));
	if (!trip) return null;
	return (
		trip.instances.find((instance) => instance.serviceDate === serviceDate) ??
		trip.instances.find((instance) => instance.actualTripDates.includes(serviceDate)) ??
		null
	);
}

function findNextInstance(
	ctx: CacheContext,
	current: AugmentedTripInstance,
	tripId: string,
): AugmentedTripInstance | null {
	const trip = ctx.augmented.tripsRec.get(entityKey({ feedId: current.feed_id, localId: tripId }));
	if (!trip) return null;
	const currentLast = current.stopTimes.at(-1);
	const currentEnd = currentLast
		? (absoluteEventSeconds(ctx, currentLast, "arrival") ?? absoluteEventSeconds(ctx, currentLast, "departure"))
		: null;
	if (currentEnd != null) {
		const ordered = trip.instances
			.map((candidate) => ({ candidate, gap: handoffGapSeconds(ctx, current, candidate) }))
			.filter(
				(entry): entry is { candidate: AugmentedTripInstance; gap: number } =>
					entry.gap != null && entry.gap >= 0,
			)
			.sort((a, b) => a.gap - b.gap);
		if (ordered[0]) return ordered[0].candidate;
	}
	return findInstanceForDate(ctx, current.feed_id, tripId, current.serviceDate);
}

function transferMatchesHandoff(
	transfer: qdf.Transfer,
	current: AugmentedTripInstance,
	next: AugmentedTripInstance,
): boolean {
	const currentLast = current.stopTimes.at(-1);
	const nextFirst = next.stopTimes[0];
	if (!currentLast || !nextFirst) return false;
	if (transfer.from_stop_id && !platformStopIds(currentLast).includes(transfer.from_stop_id)) return false;
	if (transfer.to_stop_id && !platformStopIds(nextFirst).includes(transfer.to_stop_id)) return false;
	return true;
}

function explicitContinuationEdges(
	ctx: CacheContext,
	instance: AugmentedTripInstance,
): { authoritative: boolean; edges: ContinuationEdge[] } {
	const transfers =
		ctx.augmented.linkedTransfersFromTrip.get(entityKey({ feedId: instance.feed_id, localId: instance.trip_id })) ??
		[];
	if (transfers.length === 0) return { authoritative: false, edges: [] };

	const byNextTrip = new Map<string, qdf.Transfer[]>();
	for (const transfer of transfers) {
		if (!transfer.to_trip_id) continue;
		const existing = byNextTrip.get(transfer.to_trip_id) ?? [];
		existing.push(transfer);
		byNextTrip.set(transfer.to_trip_id, existing);
	}

	const edges: ContinuationEdge[] = [];
	for (const [nextTripId, candidates] of byNextTrip) {
		if (candidates.some((transfer) => transfer.transfer_type === qdf.TransferType.NoInSeat)) continue;
		const allowed = candidates.find((transfer) => transfer.transfer_type === qdf.TransferType.InSeat);
		if (!allowed) continue;
		const next = findNextInstance(ctx, instance, nextTripId);
		if (!next || !transferMatchesHandoff(allowed, instance, next)) continue;
		const gap = handoffGapSeconds(ctx, instance, next);
		if (gap != null && gap < 0) continue;
		edges.push({ next, source: "gtfs-transfer" });
	}
	return { authoritative: true, edges };
}

function sameCanonicalHandoff(ctx: CacheContext, current: AugmentedTripInstance, next: AugmentedTripInstance): boolean {
	const currentLast = current.stopTimes.at(-1);
	const nextFirst = next.stopTimes[0];
	if (!currentLast || !nextFirst) return false;
	const currentKey = canonicalStopKey(ctx, currentLast);
	return currentKey != null && currentKey === canonicalStopKey(ctx, nextFirst);
}

function rawBlockContinuationEdge(ctx: CacheContext, instance: AugmentedTripInstance): ContinuationEdge | null {
	const rawTrip = ctx.augmented.rawTripsRec.get(entityKey({ feedId: instance.feed_id, localId: instance.trip_id }));
	if (!rawTrip?.block_id || !ctx.gtfs) return null;
	const blockTrips = ctx.gtfs
		.getTrips({ feed_id: instance.feed_id, block_id: rawTrip.block_id, date: instance.serviceDate })
		.map((trip) => findInstanceForDate(ctx, trip.feed_id, trip.trip_id, instance.serviceDate))
		.filter((candidate): candidate is AugmentedTripInstance => candidate != null)
		.sort(
			(a, b) =>
				(a.stopTimes[0]?.scheduled_departure_time ?? Number.POSITIVE_INFINITY) -
				(b.stopTimes[0]?.scheduled_departure_time ?? Number.POSITIVE_INFINITY),
		);
	const currentIndex = blockTrips.findIndex((candidate) => candidate.instance_id === instance.instance_id);
	const next = currentIndex >= 0 ? blockTrips[currentIndex + 1] : null;
	if (!next || !sameCanonicalHandoff(ctx, instance, next)) return null;
	const gap = handoffGapSeconds(ctx, instance, next);
	if (gap == null || gap < 0 || gap > FALLBACK_MAX_GAP_SECONDS) return null;
	return { next, source: "gtfs-block" };
}

function tripIdNumericPrefix(tripId: string): number | null {
	const separator = tripId.indexOf("-");
	const value = Number.parseInt(separator === -1 ? tripId : tripId.slice(0, separator), 10);
	return Number.isFinite(value) ? value : null;
}

function inferredSeqContinuationEdge(ctx: CacheContext, instance: AugmentedTripInstance): ContinuationEdge | null {
	if (!instance.seq_diagram_next_instance_id || instance.seq_diagram_next_link_broken) return null;
	const next = ctx.augmented.instancesRec.get(instance.seq_diagram_next_instance_id);
	if (!next) return null;
	const currentLast = instance.stopTimes.at(-1);
	const nextFirst = next.stopTimes[0];
	if (!currentLast || !nextFirst) return null;
	if (!platformStopIds(currentLast).some((id) => platformStopIds(nextFirst).includes(id))) return null;
	const currentNumber = tripIdNumericPrefix(instance.trip_id);
	const nextNumber = tripIdNumericPrefix(next.trip_id);
	if (currentNumber == null || nextNumber !== currentNumber + 1) return null;
	const gap = handoffGapSeconds(ctx, instance, next);
	if (gap == null || gap <= INFERRED_MIN_GAP_SECONDS || gap > FALLBACK_MAX_GAP_SECONDS) return null;
	return { next, source: "seq-inferred" };
}

function continuationEdges(ctx: CacheContext, instance: AugmentedTripInstance): ContinuationEdge[] {
	const explicit = explicitContinuationEdges(ctx, instance);
	if (explicit.authoritative) return explicit.edges;
	const block = rawBlockContinuationEdge(ctx, instance);
	if (block) return [block];
	const inferred = inferredSeqContinuationEdge(ctx, instance);
	return inferred ? [inferred] : [];
}

function canAlight(stopTime: AugmentedStopTime): boolean {
	return (
		!stopTime.passing &&
		stopTime.drop_off_type !== qdf.DropOffType.None &&
		stopTime.realtime_info?.schedule_relationship !== qdf.StopTimeScheduleRelationship.SKIPPED
	);
}

function findOriginIndex(instance: AugmentedTripInstance, origin: ReachabilityOrigin): number {
	const ids = new Set(origin.stopIds);
	const matches = instance.stopTimes
		.map((stopTime, index) => ({ stopTime, index }))
		.filter(({ stopTime }) => localStopIds(stopTime).some((id) => ids.has(id)));
	if (matches.length === 0) return -1;
	if (origin.departureTime == null) return matches[0]!.index;
	return matches.reduce((best, candidate) => {
		const bestTime = departureSeconds(best.stopTime);
		const candidateTime = departureSeconds(candidate.stopTime);
		if (candidateTime == null) return best;
		if (bestTime == null) return candidate;
		return Math.abs(candidateTime - origin.departureTime!) < Math.abs(bestTime - origin.departureTime!)
			? candidate
			: best;
	}).index;
}

/**
 * Flatten the stops reachable without leaving the vehicle. Explicit GTFS linked
 * trips may form a chain; block and SEQ fallbacks may cross only one unconfirmed edge.
 * A path ends when it revisits a station, which prevents another loop from becoming
 * a misleading destination.
 */
export function getOnboardReachableStops(
	ctx: CacheContext,
	instanceId: string,
	origin: ReachabilityOrigin,
): OnboardReachableStop[] {
	const initial = ctx.augmented.instancesRec.get(instanceId);
	if (!initial) return [];
	const originIndex = findOriginIndex(initial, origin);
	if (originIndex < 0) return [];
	const originKey = canonicalStopKey(ctx, initial.stopTimes[originIndex]!);
	if (!originKey) return [];

	const destinations = new Map<string, OnboardReachableStop>();
	type PathState = {
		instance: AugmentedTripInstance;
		startIndex: number;
		visitedStations: Set<string>;
		visitedInstances: Set<string>;
		lastStation: string;
		continuationCount: number;
		continuationSource: PassengerContinuationSource | null;
		usedFallback: boolean;
	};
	const pending: PathState[] = [
		{
			instance: initial,
			startIndex: originIndex + 1,
			visitedStations: new Set([originKey]),
			visitedInstances: new Set([initial.instance_id]),
			lastStation: originKey,
			continuationCount: 0,
			continuationSource: null,
			usedFallback: false,
		},
	];

	while (pending.length > 0) {
		const state = pending.pop()!;
		let repeatedStation = false;
		for (let index = state.startIndex; index < state.instance.stopTimes.length; index++) {
			const stopTime = state.instance.stopTimes[index]!;
			const key = canonicalStopKey(ctx, stopTime);
			if (!key) continue;
			if (key === state.lastStation) continue;
			if (state.visitedStations.has(key)) {
				repeatedStation = true;
				break;
			}
			state.visitedStations.add(key);
			state.lastStation = key;
			if (!canAlight(stopTime) || destinations.has(key)) continue;
			destinations.set(key, {
				feed_id: stopTime.feed_id,
				instance_id: state.instance.instance_id,
				trip_id: state.instance.trip_id,
				stop_id: stopTime.actual_stop_id ?? stopTime.scheduled_stop_id,
				parent_station_id: stopTime.actual_parent_station_id ?? stopTime.scheduled_parent_station_id,
				station_name: stationName(stopTime),
				continuation_count: state.continuationCount,
				continuation_source: state.continuationSource,
			});
		}
		if (repeatedStation) continue;

		for (const edge of continuationEdges(ctx, state.instance)) {
			const fallback = edge.source !== "gtfs-transfer";
			if ((fallback && state.usedFallback) || state.visitedInstances.has(edge.next.instance_id)) continue;
			pending.push({
				instance: edge.next,
				startIndex: 0,
				visitedStations: new Set(state.visitedStations),
				visitedInstances: new Set([...state.visitedInstances, edge.next.instance_id]),
				lastStation: state.lastStation,
				continuationCount: state.continuationCount + 1,
				continuationSource: edge.source,
				usedFallback: state.usedFallback || fallback,
			});
		}
	}

	return Array.from(destinations.values());
}
