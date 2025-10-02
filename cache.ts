import * as gtfs from "gtfs";
import { AugmentedStop, augmentStop } from "./utils/augmentedStop.js";
import { AugmentedTrip, augmentTrip, calculateRunSeries, RunSeries } from "./utils/augmentedTrip.js";
import { AugmentedStopTime } from "./utils/augmentedStopTime.js";
import { DEBUG, QRTPlace, TravelTrip } from "./index.js";
import { getCurrentQRTravelTrains, getPlaces } from "./qr-travel/qr-travel-tracker.js";
import logger from "./utils/logger.js";

type RawCache = {
	stopTimeUpdates: gtfs.StopTimeUpdate[];
	tripUpdates: gtfs.TripUpdate[];
	vehiclePositions: gtfs.VehiclePosition[];
	stopTimes: gtfs.StopTime[];

	trips: gtfs.Trip[];
	stops: gtfs.Stop[];
	routes: gtfs.Route[];

	tripsRec: { [trip_id: string]: gtfs.Trip };
	stopsRec: { [stop_id: string]: gtfs.Stop };
	routesRec: { [route_id: string]: gtfs.Route };

	qrtPlaces: QRTPlace[];
	qrtTrains: TravelTrip[];
};

type AugmentedCache = {
	trips: AugmentedTrip[];
	stops: AugmentedStop[];

	stopTimes: { [trip_id: string]: AugmentedStopTime[] };
	baseStopTimes: { [trip_id: string]: AugmentedStopTime[] }; // Cached base stop times without realtime
	tripsRec: { [trip_id: string]: AugmentedTrip };
	stopsRec: { [stop_id: string]: AugmentedStop };

	serviceDateTrips: { [service_date: number]: string[] }; // Maps serviceDate to trip IDs

	// Performance caches
	expressInfoCache: { [stopListHash: string]: any[] };
	passingStopsCache: { [stopListHash: string]: any[] };
	runSeriesCache: { [date: number]: { [runSeries: string]: RunSeries } };
};

let rawCache: RawCache = {
	stopTimeUpdates: [],
	tripUpdates: [],
	vehiclePositions: [],
	stopTimes: [],

	trips: [],
	stops: [],
	routes: [],

	tripsRec: {},
	stopsRec: {},
	routesRec: {},

	qrtPlaces: [],
	qrtTrains: [],
};

let augmentedCache: AugmentedCache = {
	trips: [],
	stops: [],
	stopTimes: {},
	baseStopTimes: {},
	tripsRec: {},
	stopsRec: {},
	serviceDateTrips: {},
	expressInfoCache: {},
	passingStopsCache: {},
	runSeriesCache: {},
};

export function getRawTrips(trip_id?: string): gtfs.Trip[] {
	if (trip_id) return rawCache.tripsRec[trip_id] ? [rawCache.tripsRec[trip_id]] : [];
	return rawCache.trips;
}

export function getRawStops(stop_id?: string): gtfs.Stop[] {
	if (stop_id) return rawCache.stopsRec[stop_id] ? [rawCache.stopsRec[stop_id]] : [];
	return rawCache.stops;
}

export function getRawRoutes(route_id?: string): gtfs.Route[] {
	if (route_id) return rawCache.routesRec[route_id] ? [rawCache.routesRec[route_id]] : [];
	return rawCache.routes;
}

export function getStopTimeUpdates(): gtfs.StopTimeUpdate[] {
	if (rawCache.stopTimeUpdates.length === 0) rawCache.stopTimeUpdates = gtfs.getStopTimeUpdates();
	return rawCache.stopTimeUpdates;
}

export function getTripUpdates(): gtfs.TripUpdate[] {
	if (rawCache.tripUpdates.length === 0) rawCache.tripUpdates = gtfs.getTripUpdates();
	return rawCache.tripUpdates;
}

export function getVehiclePositions(): gtfs.VehiclePosition[] {
	if (rawCache.vehiclePositions.length === 0) rawCache.vehiclePositions = gtfs.getVehiclePositions();
	return rawCache.vehiclePositions;
}

export function getQRTPlaces(): QRTPlace[] {
	return rawCache.qrtPlaces;
}

export function getQRTTrains(): TravelTrip[] {
	return rawCache.qrtTrains;
}

/**
 * Retrieve stopTimes, optionally filtered by trip id, lazily loading from GTFS.
 */
export function getRawStopTimes(trip_id: string | undefined): gtfs.StopTime[] {
	if (trip_id) return gtfs.getStoptimes({ trip_id });
	return gtfs.getStoptimes();
}

export function getAugmentedTrips(trip_id?: string): AugmentedTrip[] {
	if (trip_id) {
		if (augmentedCache.tripsRec && augmentedCache.tripsRec[trip_id]) return [augmentedCache.tripsRec[trip_id]!];
		if (rawCache.tripsRec[trip_id]) {
			const trip = rawCache.tripsRec[trip_id];
			const augmentedTrip = augmentTrip(trip);
			if (!augmentedCache.tripsRec) augmentedCache.tripsRec = {};
			augmentedCache.tripsRec[trip_id] = augmentedTrip;
			return [augmentedTrip];
		}
		return [];
	}
	return augmentedCache.trips ?? [];
}

export function getAugmentedStops(stop_id?: string): AugmentedStop[] {
	if (stop_id) {
		if (augmentedCache.stopsRec && augmentedCache.stopsRec[stop_id]) return [augmentedCache.stopsRec[stop_id]!];
		if (rawCache.stopsRec[stop_id]) {
			const stop = rawCache.stopsRec[stop_id];
			const augmentedStop = augmentStop(stop);
			if (!augmentedCache.stopsRec) augmentedCache.stopsRec = {};
			augmentedCache.stopsRec[stop_id] = augmentedStop;
			return [augmentedStop];
		}
		return [];
	}
	return augmentedCache.stops ?? [];
}

export function getAugmentedStopTimes(trip_id?: string): AugmentedStopTime[] {
	if (trip_id) return augmentedCache.stopTimes?.[trip_id] ?? [];
	return Object.values(augmentedCache.stopTimes ?? {}).flat();
}

export function getBaseStopTimes(trip_id: string): AugmentedStopTime[] {
	return augmentedCache.baseStopTimes?.[trip_id] ?? [];
}

export function cacheExpressInfo(stopListHash: string, expressInfo: any[]) {
	if (!augmentedCache.expressInfoCache) augmentedCache.expressInfoCache = {};
	augmentedCache.expressInfoCache[stopListHash] = expressInfo;
}

export function getCachedExpressInfo(stopListHash: string): any[] | undefined {
	return augmentedCache.expressInfoCache?.[stopListHash];
}

export function cachePassingStops(stopListHash: string, passingStops: any[]) {
	if (!augmentedCache.passingStopsCache) augmentedCache.passingStopsCache = {};
	augmentedCache.passingStopsCache[stopListHash] = passingStops;
}

export function getCachedPassingStops(stopListHash: string): any[] | undefined {
	return augmentedCache.passingStopsCache?.[stopListHash];
}

export function getRunSeries(date: number, runSeries: string, calcIfNotFound: boolean = true): RunSeries {
	if (!augmentedCache.runSeriesCache) augmentedCache.runSeriesCache = {};
	if (!augmentedCache.runSeriesCache[date]) augmentedCache.runSeriesCache[date] = {};
	if (
		!augmentedCache.runSeriesCache[date][runSeries] &&
		calcIfNotFound &&
		Object.keys(augmentedCache.serviceDateTrips[date]).find((v) => v.endsWith(runSeries))
	) {
		calculateRunSeries(
			getAugmentedTrips(Object.keys(augmentedCache.serviceDateTrips[date]).find((v) => v.endsWith(runSeries)))[0],
		);
	} else if (!augmentedCache.runSeriesCache[date][runSeries])
		augmentedCache.runSeriesCache[date][runSeries] = {
			trips: [],
			vehicle_sightings: [],
			series: runSeries.toUpperCase(),
			date,
		};
	return augmentedCache.runSeriesCache?.[date]?.[runSeries];
}

export function setRunSeries(date: number, runSeries: string, data: RunSeries): void {
	if (!augmentedCache.runSeriesCache) augmentedCache.runSeriesCache = {};
	if (!augmentedCache.runSeriesCache[date]) augmentedCache.runSeriesCache[date] = {};
	augmentedCache.runSeriesCache[date][runSeries] = data;
}

function resetStaticCache(): void {
	rawCache = {
		stopTimeUpdates: [],
		tripUpdates: [],
		vehiclePositions: [],
		stopTimes: [],

		trips: [],
		stops: [],
		routes: [],

		tripsRec: {},
		stopsRec: {},
		routesRec: {},

		qrtPlaces: [],
		qrtTrains: [],
	};

	augmentedCache = {
		trips: [],
		stops: [],
		stopTimes: {},
		baseStopTimes: {},
		tripsRec: {},
		stopsRec: {},
		serviceDateTrips: {},
		expressInfoCache: {},
		passingStopsCache: {},
		runSeriesCache: {},
	};
}

function resetRealtimeCache(): void {
	rawCache.stopTimeUpdates = [];
	rawCache.tripUpdates = [];
	rawCache.vehiclePositions = [];
	rawCache.qrtTrains = [];
	augmentedCache.trips = [];
	augmentedCache.tripsRec = {};
	augmentedCache.serviceDateTrips = {};
	augmentedCache.baseStopTimes = {};
	augmentedCache.stopTimes = {};
}

export async function refreshStaticCache(skipRealtimeOverlap: boolean = false): Promise<void> {
	logger.debug("Refreshing static GTFS cache...", {
		module: "cache",
		function: "refreshStaticCache",
	});
	resetStaticCache();

	logger.debug("Loading QRT places...", {
		module: "cache",
		function: "refreshStaticCache",
	});
	rawCache.qrtPlaces = await getPlaces();
	logger.debug(`Loaded ${rawCache.qrtPlaces.length} QRT places.`, {
		module: "cache",
		function: "refreshStaticCache",
	});

	logger.debug("Loading stops...", {
		module: "cache",
		function: "refreshStaticCache",
	});
	rawCache.stops = gtfs.getStops();
	logger.debug(`Loaded ${rawCache.stops.length} stops.`, {
		module: "cache",
		function: "refreshStaticCache",
	});

	logger.debug("Loading routes...", {
		module: "cache",
		function: "refreshStaticCache",
	});
	rawCache.routes = gtfs.getRoutes();
	logger.debug(`Loaded ${rawCache.routes.length} routes.`, {
		module: "cache",
		function: "refreshStaticCache",
	});

	logger.debug("Loading trips...", {
		module: "cache",
		function: "refreshStaticCache",
	});
	rawCache.trips = gtfs.getTrips().filter((v) => v.trip_id.includes("-QR "));
	logger.debug(`Loaded ${rawCache.trips.length} trips.`, {
		module: "cache",
		function: "refreshStaticCache",
	});

	logger.debug("Building raw cache records...", {
		module: "cache",
		function: "refreshStaticCache",
	});

	for (const trip of rawCache.trips) rawCache.tripsRec[trip.trip_id] = trip;
	for (const stop of rawCache.stops) rawCache.stopsRec[stop.stop_id] = stop;
	for (const route of rawCache.routes) rawCache.routesRec[route.route_id] = route;

	if (skipRealtimeOverlap)
		logger.debug("Skipping augmenting trips.", {
			module: "cache",
			function: "refreshStaticCache",
		});
	else {
		logger.debug("Augmenting trips...", {
			module: "cache",
			function: "refreshStaticCache",
		});
		augmentedCache.trips = rawCache.trips.map(augmentTrip);
		logger.debug(`Augmented ${augmentedCache.trips.length} trips.`, {
			module: "cache",
			function: "refreshStaticCache",
		});
	}

	logger.debug("Augmenting stops...", {
		module: "cache",
		function: "refreshStaticCache",
	});
	augmentedCache.stops = rawCache.stops.map(augmentStop);
	logger.debug(`Augmented ${augmentedCache.stops.length} stops.`, {
		module: "cache",
		function: "refreshStaticCache",
	});

	logger.debug("Building augmented cache records...", {
		module: "cache",
		function: "refreshStaticCache",
	});

	if (skipRealtimeOverlap)
		logger.debug("Skipping building augmented stop times cache.", {
			module: "cache",
			function: "refreshStaticCache",
		});
	else
		for (const trip of augmentedCache.trips) {
			augmentedCache.tripsRec[trip._trip.trip_id] = trip;

			// Store both current stop times and base stop times (without realtime)
			augmentedCache.stopTimes[trip._trip.trip_id] = trip.stopTimes;
			augmentedCache.baseStopTimes[trip._trip.trip_id] = [...trip.stopTimes]; // Deep copy for base

			for (const serviceDate of trip.actualTripDates) {
				if (!augmentedCache.serviceDateTrips[serviceDate]) augmentedCache.serviceDateTrips[serviceDate] = [];
				augmentedCache.serviceDateTrips[serviceDate].push(trip._trip.trip_id);
			}
		}
	for (const stop of augmentedCache.stops) augmentedCache.stopsRec[stop.stop_id] = stop;

	logger.info("Static GTFS cache refreshed.", {
		module: "cache",
		function: "refreshStaticCache",
	});
}

export async function refreshRealtimeCache(): Promise<void> {
	logger.debug("Refreshing realtime GTFS cache...", {
		module: "cache",
		function: "refreshRealtimeCache",
	});
	resetRealtimeCache();

	logger.debug("Refreshing qrtTrains cache...", {
		module: "cache",
		function: "refreshRealtimeCache",
	});
	rawCache.qrtTrains = await getCurrentQRTravelTrains();
	logger.debug(`Loaded ${rawCache.qrtTrains.length} QRT trains.`, {
		module: "cache",
		function: "refreshRealtimeCache",
	});

	logger.debug("Loading realtime updates...", {
		module: "cache",
		function: "refreshRealtimeCache",
	});
	rawCache.stopTimeUpdates = gtfs.getStopTimeUpdates();
	rawCache.tripUpdates = gtfs.getTripUpdates();
	rawCache.vehiclePositions = gtfs.getVehiclePositions();
	logger.debug(`Loaded ${rawCache.stopTimeUpdates.length} stop time updates.`, {
		module: "cache",
		function: "refreshRealtimeCache",
	});
	logger.debug(`Loaded ${rawCache.tripUpdates.length} trip updates.`, {
		module: "cache",
		function: "refreshRealtimeCache",
	});
	logger.debug(`Loaded ${rawCache.vehiclePositions.length} vehicle positions.`, {
		module: "cache",
		function: "refreshRealtimeCache",
	});

	logger.warn("Re-augmenting trips as efficient realtime updates are not implemented yet.", {
		module: "cache",
		function: "refreshRealtimeCache",
	}); // TODO fix this, ensuring you build the cache if you fix it
	// Re-augment trips to apply realtime updates
	augmentedCache.trips = rawCache.trips.map(augmentTrip);
	logger.debug(`Augmented ${augmentedCache.trips.length} trips.`, {
		module: "cache",
		function: "refreshRealtimeCache",
	});

	logger.debug("Building augmented cache records...", {
		module: "cache",
		function: "refreshRealtimeCache",
	});

	for (const trip of augmentedCache.trips) {
		augmentedCache.tripsRec[trip._trip.trip_id] = trip;

		// Store both current stop times and base stop times (without realtime)
		augmentedCache.stopTimes[trip._trip.trip_id] = trip.stopTimes;
		augmentedCache.baseStopTimes[trip._trip.trip_id] = [...trip.stopTimes]; // Deep copy for base

		for (const serviceDate of trip.actualTripDates) {
			if (!augmentedCache.serviceDateTrips[serviceDate]) augmentedCache.serviceDateTrips[serviceDate] = [];
			augmentedCache.serviceDateTrips[serviceDate].push(trip._trip.trip_id);
		}
	}
	logger.info("Realtime GTFS cache refreshed.", {
		module: "cache",
		function: "refreshRealtimeCache",
	});
}
