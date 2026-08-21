import type {
	RealtimeStopTimeUpdate,
	RealtimeTripUpdate,
	RealtimeUpdateTripInfo,
	RealtimeVehiclePosition,
} from "qdf-gtfs";
import { TripScheduleRelationship } from "qdf-gtfs";
import type { CacheContext } from "./types.js";

function tripServiceKey(update: RealtimeTripUpdate): string {
	return [update.feed_id, update.trip.trip_id, update.trip.start_date ?? "", update.trip.start_time ?? ""].join("\0");
}

/** Replace one supplemental producer's snapshot without disturbing other plugins. */
export function replaceInjectedTripUpdates(
	ctx: CacheContext,
	sourceId: string,
	updates: readonly RealtimeTripUpdate[],
): void {
	if (updates.some((update) => update.source_id !== sourceId)) {
		throw new Error(`Injected trip updates for '${sourceId}' contain a different source_id`);
	}
	ctx.raw.injectedTripUpdates = [
		...(ctx.raw.injectedTripUpdates ?? []).filter((update) => update.source_id !== sourceId),
		...updates,
	];
}

/** Replace one supplemental producer's vehicle snapshot without disturbing other plugins. */
export function replaceInjectedVehiclePositions(
	ctx: CacheContext,
	sourceId: string,
	positions: readonly RealtimeVehiclePosition[],
): void {
	if (positions.some((position) => position.source_id !== sourceId)) {
		throw new Error(`Injected vehicle positions for '${sourceId}' contain a different source_id`);
	}
	ctx.raw.injectedVehiclePositions = [
		...(ctx.raw.injectedVehiclePositions ?? []).filter((position) => position.source_id !== sourceId),
		...positions,
	];
}

/** A GTFS-RT REPLACEMENT owns the trip instance for its service key. */
export function applyRealtimeReplacementPrecedence(updates: readonly RealtimeTripUpdate[]): RealtimeTripUpdate[] {
	const replacementKeys = new Set(
		updates
			.filter((update) => update.trip.schedule_relationship === TripScheduleRelationship.REPLACEMENT)
			.map(tripServiceKey),
	);
	return updates.filter(
		(update) =>
			update.trip.schedule_relationship === TripScheduleRelationship.REPLACEMENT ||
			!replacementKeys.has(tripServiceKey(update)),
	);
}

function canonicalTripInfo(trip: RealtimeUpdateTripInfo, ctx: CacheContext): RealtimeUpdateTripInfo {
	let tripId = trip.trip_id;
	for (const plugin of ctx.config.network.plugins) {
		if (!plugin.feedIds.includes(trip.feed_id) || !plugin.canonicalRealtimeTripId) continue;
		tripId = plugin.canonicalRealtimeTripId({ ...trip, trip_id: tripId }, ctx) ?? tripId;
	}
	return tripId === trip.trip_id ? trip : { ...trip, trip_id: tripId };
}

export function canonicalizeRealtimeTripUpdate(update: RealtimeTripUpdate, ctx: CacheContext): RealtimeTripUpdate {
	let enriched = update;
	for (const plugin of ctx.config.network.plugins) {
		if (!plugin.feedIds.includes(enriched.feed_id) || !plugin.enrichRealtimeTripUpdate) continue;
		enriched = plugin.enrichRealtimeTripUpdate(enriched, ctx) ?? enriched;
	}
	const trip = canonicalTripInfo(enriched.trip, ctx);
	if (trip === enriched.trip) return enriched;
	const stopTimeUpdates = enriched.stop_time_updates.map((stopTime): RealtimeStopTimeUpdate => ({
		...stopTime,
		trip_id: trip.trip_id,
	}));
	return { ...enriched, trip, stop_time_updates: stopTimeUpdates };
}

export function canonicalizeRealtimeVehiclePosition(
	position: RealtimeVehiclePosition,
	ctx: CacheContext,
): RealtimeVehiclePosition {
	const trip = canonicalTripInfo(position.trip, ctx);
	return trip === position.trip ? position : { ...position, trip };
}

export function canonicalizeRealtimeTripUpdates(
	updates: readonly RealtimeTripUpdate[],
	ctx: CacheContext,
): RealtimeTripUpdate[] {
	return updates.map((update) => canonicalizeRealtimeTripUpdate(update, ctx));
}

export function canonicalizeRealtimeVehiclePositions(
	positions: readonly RealtimeVehiclePosition[],
	ctx: CacheContext,
): RealtimeVehiclePosition[] {
	return positions.map((position) => canonicalizeRealtimeVehiclePosition(position, ctx));
}
