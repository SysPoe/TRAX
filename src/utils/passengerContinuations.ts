import * as qdf from "qdf-gtfs";
import type { CacheContext } from "../cache/types.js";
import { canonicalStationIdentity, getFeedTimeZone, getPlaceForStation } from "../config.js";
import { entityKey } from "../identity.js";
import type { AugmentedStopTime } from "./augmentedStopTime.js";
import type { AugmentedTripInstance } from "./augmentedTrip.js";
import { getServiceDayStart } from "./time.js";

const FALLBACK_MAX_GAP_SECONDS = 30 * 60;
const INFERRED_MIN_GAP_SECONDS = 90;

export type ReachabilityOrigin = {
	stopIds: readonly string[];
	/**
	 * GTFS service-day seconds for the departure event, used to disambiguate loop calls.
	 * When omitted for a loop station with several visits, the first occurrence in
	 * stop-sequence order is used deterministically (earliest boarding opportunity,
	 * maximal reachable set) so public callers never see a silent empty. Pass an
	 * explicit time to select a later loop visit.
	 */
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

function stationName(ctx: CacheContext, stopTime: AugmentedStopTime): string | null {
	const localId =
		stopTime.actual_parent_station_id ??
		stopTime.scheduled_parent_station_id ??
		stopTime.actual_stop_id ??
		stopTime.scheduled_stop_id;
	const place = localId ? getPlaceForStation(ctx.config, { feedId: stopTime.feed_id, localId }) : null;
	return (
		place?.name ??
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
	// The augmented value retains raw GTFS service-day seconds. Values above
	// 24:00 already contain their day offset.
	return getServiceDayStart(stopTime.service_date, getFeedTimeZone(ctx.config, stopTime.feed_id)) + seconds;
}

/** Passenger-usable calls can form a handoff: not passing and neither SKIPPED nor NO_DATA. */
function isPassengerUsable(stopTime: AugmentedStopTime): boolean {
	const relationship = stopTime.realtime_info?.schedule_relationship;
	return (
		!stopTime.passing &&
		relationship !== qdf.StopTimeScheduleRelationship.SKIPPED &&
		relationship !== qdf.StopTimeScheduleRelationship.NO_DATA
	);
}

function handoffGapSeconds(
	ctx: CacheContext,
	current: AugmentedTripInstance,
	next: AugmentedTripInstance,
): number | null {
	const currentLast = handoffStop(current, "last");
	const nextFirst = handoffStop(next, "first");
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
	const currentLast = handoffStop(current, "last");
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
	const currentLast = handoffStop(current, "last");
	const nextFirst = handoffStop(next, "first");
	if (!currentLast || !nextFirst) return false;
	if (transfer.from_stop_id && !localStopIds(currentLast).includes(transfer.from_stop_id)) return false;
	if (transfer.to_stop_id && !localStopIds(nextFirst).includes(transfer.to_stop_id)) return false;
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
	let matchedRule = false;
	for (const [nextTripId, candidates] of byNextTrip) {
		const next = findNextInstance(ctx, instance, nextTripId);
		if (!next) continue;
		const matching = candidates.filter((transfer) => transferMatchesHandoff(transfer, instance, next));
		if (matching.length) matchedRule = true;
		if (matching.some((transfer) => transfer.transfer_type === qdf.TransferType.NoInSeat)) continue;
		const allowed = matching.find((transfer) => transfer.transfer_type === qdf.TransferType.InSeat);
		if (!allowed) continue;
		const gap = handoffGapSeconds(ctx, instance, next);
		if (gap != null && (gap < 0 || (allowed.min_transfer_time != null && gap < allowed.min_transfer_time))) continue;
		edges.push({ next, source: "gtfs-transfer" });
	}
	return { authoritative: matchedRule, edges };
}

function handoffStop(instance: AugmentedTripInstance, which: "first" | "last"): AugmentedStopTime | undefined {
	const usable = instance.stopTimes.filter((stopTime) => isPassengerUsable(stopTime));
	return which === "first" ? usable[0] : usable.at(-1);
}

function sameCanonicalHandoff(ctx: CacheContext, current: AugmentedTripInstance, next: AugmentedTripInstance): boolean {
	const currentLast = handoffStop(current, "last");
	const nextFirst = handoffStop(next, "first");
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
		.filter((candidate): candidate is AugmentedTripInstance => candidate != null);
	const next = blockTrips
		.filter((candidate) => candidate.instance_id !== instance.instance_id && sameCanonicalHandoff(ctx, instance, candidate))
		.map((candidate) => ({ candidate, gap: handoffGapSeconds(ctx, instance, candidate) }))
		.filter(
			(entry): entry is { candidate: AugmentedTripInstance; gap: number } =>
				entry.gap != null && entry.gap >= 0 && entry.gap <= FALLBACK_MAX_GAP_SECONDS,
		)
		.sort((left, right) => left.gap - right.gap)[0]?.candidate;
	return next ? { next, source: "gtfs-block" } : null;
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
	const currentLast = handoffStop(instance, "last");
	const nextFirst = handoffStop(next, "first");
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
	return isPassengerUsable(stopTime) && stopTime.drop_off_type !== qdf.DropOffType.None;
}

function canBoard(stopTime: AugmentedStopTime): boolean {
	return isPassengerUsable(stopTime) && stopTime.pickup_type !== qdf.PickupType.None;
}

function isSkippedOrPassing(stopTime: AugmentedStopTime): boolean {
	return !isPassengerUsable(stopTime);
}

function findOriginIndex(instance: AugmentedTripInstance, origin: ReachabilityOrigin): number {
	const ids = new Set(origin.stopIds);
	const matches = instance.stopTimes
		.map((stopTime, index) => ({ stopTime, index }))
		.filter(({ stopTime }) => localStopIds(stopTime).some((id) => ids.has(id)));
	if (matches.length === 0) return -1;
	// Deterministic safe occurrence for loops without a time: the first visit in
	// sequence order. It is the earliest boarding opportunity and yields the
	// maximal reachable set, so omitting departureTime never produces a silent
	// empty for public raw callers (e.g. TRAX.getOnboardReachableStops). Callers
	// that need a later loop visit must pass departureTime explicitly.
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
	const originStopTime = initial.stopTimes[originIndex]!;
	if (!canBoard(originStopTime)) return [];
	const originKey = canonicalStopKey(ctx, originStopTime);
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
		for (let index = state.startIndex; index < state.instance.stopTimes.length; index++) {
			const stopTime = state.instance.stopTimes[index]!;
			// Passing, SKIPPED, and NO_DATA calls never had an alighting opportunity,
			// so they must not claim station identity or truncate later reachable stops.
			if (isSkippedOrPassing(stopTime)) continue;
			const key = canonicalStopKey(ctx, stopTime);
			if (!key) continue;
			if (key === state.lastStation) continue;
			if (state.visitedStations.has(key)) {
				state.lastStation = key;
				continue;
			}
			state.lastStation = key;
			// Only alightable calls occupy loop identity. A pickup-only (or other
			// non-alightable) visit must not block a later alightable visit of the
			// same station via a continuation.
			if (!canAlight(stopTime)) continue;
			state.visitedStations.add(key);
			if (destinations.has(key)) continue;
			destinations.set(key, {
				feed_id: stopTime.feed_id,
				instance_id: state.instance.instance_id,
				trip_id: state.instance.trip_id,
				stop_id: stopTime.actual_stop_id ?? stopTime.scheduled_stop_id,
				parent_station_id: stopTime.actual_parent_station_id ?? stopTime.scheduled_parent_station_id,
				station_name: stationName(ctx, stopTime),
				continuation_count: state.continuationCount,
				continuation_source: state.continuationSource,
			});
		}
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
