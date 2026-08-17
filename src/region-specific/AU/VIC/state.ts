import type { CacheContext } from "../../../cache/types.js";
import { getPluginState } from "../../../plugins/types.js";
import type { VLinePluginState } from "./types.js";

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
