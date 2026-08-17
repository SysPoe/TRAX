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
		chronosRunByInstanceId: new Map(),
		chronosStopByGtfsStopId: new Map(),
		chronosRouteByStopAndGtfs: new Map(),
		chronosDirectionsByRouteId: new Map(),
		chronosDirectionByStopAndRoute: new Map(),
		chronosDiscoveryRetryAt: new Map(),
		chronosPatternCache: new Map(),
		journeyCache: new Map(),
		journeyInFlight: new Map(),
		bookingCache: new Map(),
		bookingInFlight: new Map(),
		platformLocationsCache: null,
		platformPollByLocation: new Map(),
		sources: {
			"journey-planner": { enabled: false, lastAttemptAt: null, lastSuccessAt: null, error: null },
			chronos: { enabled: false, lastAttemptAt: null, lastSuccessAt: null, error: null },
			"scs-board": { enabled: true, lastAttemptAt: null, lastSuccessAt: null, error: null },
		},
		lastRefreshAt: null,
	}));
}

/** Serializable operational snapshot for admin/status surfaces. */
export function getVLineDiagnostics(ctx: CacheContext): VLineDiagnostics {
	const state = getVLineState(ctx);
	const details = [...state.detailsByInstanceId.values()];
	const now = Date.now();
	return {
		lastRefreshAt: state.lastRefreshAt,
		trackedTrips: state.detailsByInstanceId.size,
		linkedServiceKeys: state.detailsByServiceKey.size,
		canonicalRealtimeTrips: state.canonicalTripIdByRealtimeKey.size,
		canonicalServiceTrips: state.canonicalTripIdByServiceKey.size,
		sources: structuredClone(state.sources),
		chronos: {
			matchedRuns: state.chronosRunByInstanceId.size,
			resolvedStops: state.chronosStopByGtfsStopId.size,
			mappedRoutes: state.chronosRouteByStopAndGtfs.size,
			cachedRouteDirections: [...state.chronosDirectionsByRouteId.values()].reduce(
				(total, directions) => total + directions.length,
				0,
			),
			mappedDirections: state.chronosDirectionByStopAndRoute.size,
			discoveryBackoffs: [...state.chronosDiscoveryRetryAt.values()].filter((retryAt) => retryAt > now).length,
			patternCacheEntries: state.chronosPatternCache.size,
			freshPatternCacheEntries: [...state.chronosPatternCache.values()].filter((entry) => entry.expiresAt > now)
				.length,
			enrichedServices: details.filter((value) => value.chronosService !== null).length,
			enrichedCalls: details.reduce((total, value) => total + value.chronosCalls.length, 0),
			platformObservations: details.reduce(
				(total, value) =>
					total + value.platforms.filter((platform) => platform.source === "ptv-chronos").length,
				0,
			),
		},
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
