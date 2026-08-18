import type { CacheContext } from "../../../cache/types.js";
import { getPluginState } from "../../../plugins/types.js";
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
		platformLocationsCache: null,
		platformPollByLocation: new Map(),
		sources: {
			"journey-planner": { enabled: false, lastAttemptAt: null, lastSuccessAt: null, error: null },
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
			platformLocationsCached: state.platformLocationsCache?.locations.length ?? 0,
			platformStationsPolled: state.platformPollByLocation.size,
			platformStationErrors: [...state.platformPollByLocation.values()].filter((value) => value.error !== null)
				.length,
		},
		scsBoard: {
			enrichedServices: details.filter((value) => value.scsService !== null).length,
		},
	};
}
