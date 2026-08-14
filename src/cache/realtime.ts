import type {
	RealtimeStopTimeUpdate,
	RealtimeTripUpdate,
	RealtimeUpdateTripInfo,
	RealtimeVehiclePosition,
} from "qdf-gtfs";
import type { CacheContext } from "./types.js";

function canonicalTripInfo(trip: RealtimeUpdateTripInfo, ctx: CacheContext): RealtimeUpdateTripInfo {
	let tripId = trip.trip_id;
	for (const plugin of ctx.config.network.plugins) {
		if (!plugin.feedIds.includes(trip.feed_id) || !plugin.canonicalRealtimeTripId) continue;
		tripId = plugin.canonicalRealtimeTripId({ ...trip, trip_id: tripId }, ctx) ?? tripId;
	}
	return tripId === trip.trip_id ? trip : { ...trip, trip_id: tripId };
}

export function canonicalizeRealtimeTripUpdate(
	update: RealtimeTripUpdate,
	ctx: CacheContext,
): RealtimeTripUpdate {
	const trip = canonicalTripInfo(update.trip, ctx);
	if (trip === update.trip) return update;
	const stopTimeUpdates = update.stop_time_updates.map(
		(stopTime): RealtimeStopTimeUpdate => ({ ...stopTime, trip_id: trip.trip_id }),
	);
	return { ...update, trip, stop_time_updates: stopTimeUpdates };
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
