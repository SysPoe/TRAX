import { globalTimer } from "../utils/timer.js";
import type { TraxConfig } from "../config.js";
import type { AugmentedCache, RawCache } from "./types.js";
import { LRUCache } from "./lruCache.js";
import type { ExpressInfo, PassingStop } from "../utils/SRT.js";

export function createEmptyRawCache(): RawCache {
	return {
		regionSpecific: {
			SEQ: {
				qrtPlaces: [],
				qrtStations: {},
				qrtTrains: [],
				platformData: undefined,
				railwayStationFacilities: [],
			},
		},
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
		tripsStoppingAt: new Map(),
		stopDeparturesCached: new Map(),
		instancesRec: new Map(),
		tripUpdatesCache: new Map(),
		timer: globalTimer,
		seqDiagram: undefined,
	};
}

export function createAugmentedCacheWithConfig(config: TraxConfig): AugmentedCache {
	const cache = createEmptyAugmentedCache();
	cache.timer.disabled = config.disableTimers;
	return cache;
}
