import { Timer } from "../utils/timer.js";
import type { TraxConfig } from "../config.js";
import type { AugmentedCache, CacheContext, RawCache } from "./types.js";
import { LRUCache } from "./lruCache.js";
import type { ExpressInfo, PassingStop } from "../utils/SRT.js";

export function createEmptyRawCache(): RawCache {
	return {
		tripServiceIds: new Map(),
		injectedTripUpdates: [],
		injectedVehiclePositions: [],
	};
}

export function createEmptyAugmentedCache(): AugmentedCache {
	return {
		trips: [],
		stops: [],
		railStations: [],
		stopTimes: {},
		baseStopTimes: {},
		rawStopTimesCache: new Map(),
		rawTripsRec: new Map(),
		tripsRec: new Map(),
		stopsRec: new Map(),
		serviceDateTrips: new Map(),
		serviceDateTripsSet: new Map(),
		passingTrips: new Map(),
		shapes: [],
		expressInfoCache: new LRUCache<string, ExpressInfo[]>(1000),
		passingStopsCache: new LRUCache<string, PassingStop[]>(5000),
		runSeriesCache: new Map(),
		carTrips: new Map(),
		tripNumberTrips: new Map(),
		tripsStoppingAt: new Map(),
		stopDeparturesCached: new Map(),
		instancesRec: new Map(),
		tripUpdatesCache: new Map(),
		tripUpdateSignatures: new Map(),
		timer: new Timer(),
		seqDiagram: undefined,
		qrtRefreshInFlight: undefined,
	};
}

export function createAugmentedCacheWithConfig(config: TraxConfig): AugmentedCache {
	const cache = createEmptyAugmentedCache();
	cache.timer.disabled = config.disableTimers;
	return cache;
}

export function createRuntimeState(): CacheContext["runtimeState"] {
	return {
		consideredRoutes: new Map(),
		consideredStops: new Map(),
		consideredTrips: new Map(),
		serviceDates: new Map(),
		serviceDayStarts: new Map(),
		availableServiceDates: null,
		operationalServiceDates: new Set(),
		lazyServiceDates: new Map(),
		dateOffsets: new Map(),
		serviceDateArrays: new Map(),
		previousVehicleInfo: new Map(),
		srtNetworkData: null,
		srtExpectedStaticFingerprint: null,
		srtBfs: new Map(),
		loggedMissingSrt: new Set(),
	};
}
