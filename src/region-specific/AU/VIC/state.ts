import type { CacheContext } from "../../../cache/types.js";
import { getPluginState } from "../../../plugins/types.js";
import { loadVLineBookingSnapshots } from "./booking-snapshots.js";
import type { VLineDiagnostics, VLinePluginState } from "./types.js";

export const VLINE_PLUGIN_ID = "au-vic-vline";

export function getVLineState(ctx: CacheContext): VLinePluginState {
	return getPluginState(ctx, VLINE_PLUGIN_ID, () => ({
		detailsByInstanceId: new Map(),
		detailsByServiceKey: new Map(),
		canonicalTripIdByRealtimeKey: new Map(),
		canonicalTripIdByServiceKey: new Map(),
		journeyCache: new Map(),
		journeyInFlight: new Map(),
		bookingCache: new Map(),
		bookingInFlight: new Map(),
		bookingSnapshots: loadVLineBookingSnapshots(ctx.config.cacheDir),
		bookingPrefetchAttempted: new Set(),
		platformLocationsCache: null,
		platformPollByLocation: new Map(),
		anyTripClient: null,
		sources: {
			"journey-planner": { enabled: false, lastAttemptAt: null, lastSuccessAt: null, error: null },
			anytrip: { enabled: false, lastAttemptAt: null, lastSuccessAt: null, error: null },
			"scs-board": { enabled: true, lastAttemptAt: null, lastSuccessAt: null, error: null },
		},
		lastRefreshAt: null,
	}));
}

/** Serializable operational snapshot for admin/status surfaces. */
export function getVLineDiagnostics(ctx: CacheContext): VLineDiagnostics {
	const state = getVLineState(ctx);
	const details = [...state.detailsByInstanceId.values()];
	return {
		lastRefreshAt: state.lastRefreshAt,
		trackedTrips: state.detailsByInstanceId.size,
		linkedServiceKeys: state.detailsByServiceKey.size,
		canonicalRealtimeTrips: state.canonicalTripIdByRealtimeKey.size,
		canonicalServiceTrips: state.canonicalTripIdByServiceKey.size,
		sources: structuredClone(state.sources),
		journeyPlanner: {
			serviceCacheEntries: state.journeyCache.size,
			requestsInFlight: state.journeyInFlight.size,
			bookingCacheEntries: state.bookingCache.size,
			bookingRequestsInFlight: state.bookingInFlight.size,
			persistedBookingSnapshots: state.bookingSnapshots.size,
			bookingPrefetchAttempts: state.bookingPrefetchAttempted.size,
			platformLocationsCached: state.platformLocationsCache?.locations.length ?? 0,
			platformStationsPolled: state.platformPollByLocation.size,
			platformStationErrors: [...state.platformPollByLocation.values()].filter((value) => value.error !== null)
				.length,
		},
		anyTrip: {
			stationCacheEntries: state.anyTripClient?.diagnostics.stationCacheEntries ?? 0,
			tripCacheEntries: state.anyTripClient?.diagnostics.tripCacheEntries ?? 0,
			requestsInFlight: state.anyTripClient?.diagnostics.requestsInFlight ?? 0,
			enrichedTrips: details.filter((value) => value.platforms.some((platform) => platform.source === "anytrip-v3")).length,
			platformObservations: details.reduce(
				(count, value) => count + value.platforms.filter((platform) => platform.source === "anytrip-v3").length,
				0,
			),
		},
		scsBoard: {
			enrichedServices: details.filter((value) => value.scsService !== null).length,
		},
	};
}
