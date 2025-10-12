import * as gtfs from "gtfs";
import { AugmentedStop, augmentStop } from "./utils/augmentedStop.js";
import { AugmentedTrip, augmentTrip, calculateRunSeries, RunSeries } from "./utils/augmentedTrip.js";
import { AugmentedStopTime } from "./utils/augmentedStopTime.js";
import { QRTPlace, TravelTrip } from "./index.js";
import { getCurrentQRTravelTrains, getPlaces } from "./qr-travel/qr-travel-tracker.js";
import logger from "./utils/logger.js";

class LRUCache<K, V> {
	private cache = new Map<K, V>();
	private maxSize: number;

	constructor(maxSize: number) {
		this.maxSize = maxSize;
	}

	get(key: K): V | undefined {
		const value = this.cache.get(key);
		if (value !== undefined) {
			// Move to end (most recently used)
			this.cache.delete(key);
			this.cache.set(key, value);
		}
		return value;
	}

	set(key: K, value: V): void {
		if (this.cache.has(key)) {
			this.cache.delete(key);
		}
		this.cache.set(key, value);

		// Evict oldest entries if over max size
		while (this.cache.size > this.maxSize) {
			const firstKey = this.cache.keys().next().value;
			if (firstKey !== undefined) {
				this.cache.delete(firstKey);
			}
		}
	}

	clear(): void {
		this.cache.clear();
	}

	get size(): number {
		return this.cache.size;
	}
}

type RawCache = {
	stopTimeUpdates: gtfs.StopTimeUpdate[];
	tripUpdates: gtfs.TripUpdate[];
	vehiclePositions: gtfs.VehiclePosition[];
	stopTimes: gtfs.StopTime[];

	calendars: gtfs.Calendar[];
	calendarDates: gtfs.CalendarDate[];

	trips: gtfs.Trip[];
	stops: gtfs.Stop[];
	routes: gtfs.Route[];

	tripsRec: Map<string, gtfs.Trip>;
	stopsRec: Map<string, gtfs.Stop>;
	routesRec: Map<string, gtfs.Route>;

	qrtPlaces: QRTPlace[];
	qrtTrains: TravelTrip[];
};

type AugmentedCache = {
	trips: AugmentedTrip[];
	stops: AugmentedStop[];

	stopTimes: { [trip_id: string]: AugmentedStopTime[] };
	baseStopTimes: { [trip_id: string]: AugmentedStopTime[] }; // Cached base stop times without realtime
	tripsRec: Map<string, AugmentedTrip>;
	stopsRec: Map<string, AugmentedStop>;

	serviceDateTrips: Map<number, string[]>; // Maps serviceDate to trip IDs

	// Performance caches with LRU eviction
	expressInfoCache: LRUCache<string, any[]>;
	passingStopsCache: LRUCache<string, any[]>;
	runSeriesCache: Map<number, Map<string, RunSeries>>;
};

let rawCache: RawCache = {
	stopTimeUpdates: [],
	tripUpdates: [],
	vehiclePositions: [],
	stopTimes: [],

	calendars: [],
	calendarDates: [],

	trips: [],
	stops: [],
	routes: [],

	tripsRec: new Map(),
	stopsRec: new Map(),
	routesRec: new Map(),

	qrtPlaces: [],
	qrtTrains: [],
};

let augmentedCache: AugmentedCache = {
	trips: [],
	stops: [],
	stopTimes: {},
	baseStopTimes: {},
	tripsRec: new Map(),
	stopsRec: new Map(),
	serviceDateTrips: new Map(),
	expressInfoCache: new LRUCache<string, any[]>(1000), // Max 1000 express info entries
	passingStopsCache: new LRUCache<string, any[]>(5000), // Max 5000 passing stops entries
	runSeriesCache: new Map(),
};

export function getCalendars(filter?: Partial<gtfs.Calendar>): gtfs.Calendar[] {
	if (!rawCache.calendars || rawCache.calendars.length === 0) rawCache.calendars = gtfs.getCalendars();
	if (!filter) return rawCache.calendars;
	// simple filter implementation
	return rawCache.calendars.filter((c) => {
		for (const key of Object.keys(filter)) {
			// @ts-ignore
			if (c[key] !== filter[key]) return false;
		}
		return true;
	});
}

export function getCalendarDates(filter?: Partial<gtfs.CalendarDate>): gtfs.CalendarDate[] {
	if (!rawCache.calendarDates || rawCache.calendarDates.length === 0)
		rawCache.calendarDates = gtfs.getCalendarDates();
	if (!filter) return rawCache.calendarDates;
	return rawCache.calendarDates.filter((c) => {
		for (const key of Object.keys(filter)) {
			// @ts-ignore
			if (c[key] !== filter[key]) return false;
		}
		return true;
	});
}

export function getRawTrips(trip_id?: string): gtfs.Trip[] {
	if (trip_id) {
		const trip = rawCache.tripsRec.get(trip_id);
		return trip ? [trip] : [];
	}
	return rawCache.trips;
}

export function getRawStops(stop_id?: string): gtfs.Stop[] {
	if (stop_id) {
		const stop = rawCache.stopsRec.get(stop_id);
		return stop ? [stop] : [];
	}
	return rawCache.stops;
}

export function getRawRoutes(route_id?: string): gtfs.Route[] {
	if (route_id) {
		const route = rawCache.routesRec.get(route_id);
		return route ? [route] : [];
	}
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
		const trip = augmentedCache.tripsRec.get(trip_id);
		if (trip) return [trip];
		const rawTrip = rawCache.tripsRec.get(trip_id);
		if (rawTrip) {
			const augmentedTrip = augmentTrip(rawTrip);
			augmentedCache.tripsRec.set(trip_id, augmentedTrip);
			return [augmentedTrip];
		}
		return [];
	}
	// Build from tripsRec to ensure we have current data
	return Array.from(augmentedCache.tripsRec.values());
}

export function getAugmentedStops(stop_id?: string): AugmentedStop[] {
	if (stop_id) {
		const stop = augmentedCache.stopsRec.get(stop_id);
		if (stop) return [stop];
		const rawStop = rawCache.stopsRec.get(stop_id);
		if (rawStop) {
			const augmentedStop = augmentStop(rawStop);
			augmentedCache.stopsRec.set(stop_id, augmentedStop);
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
	augmentedCache.expressInfoCache.set(stopListHash, expressInfo);
}

export function getCachedExpressInfo(stopListHash: string): any[] | undefined {
	return augmentedCache.expressInfoCache.get(stopListHash);
}

export function cachePassingStops(stopListHash: string, passingStops: any[]) {
	augmentedCache.passingStopsCache.set(stopListHash, passingStops);
}

export function getCachedPassingStops(stopListHash: string): any[] | undefined {
	return augmentedCache.passingStopsCache.get(stopListHash);
}

export function getRunSeries(date: number, runSeries: string, calcIfNotFound: boolean = true): RunSeries {
	let dateMap = augmentedCache.runSeriesCache.get(date);
	if (!dateMap) {
		dateMap = new Map();
		augmentedCache.runSeriesCache.set(date, dateMap);
	}
	if (
		!dateMap.get(runSeries) &&
		calcIfNotFound &&
		augmentedCache.serviceDateTrips.get(date)?.find((v) => v.endsWith(runSeries))
	) {
		calculateRunSeries(
			getAugmentedTrips(augmentedCache.serviceDateTrips.get(date)?.find((v) => v.endsWith(runSeries)))[0],
		);
	} else if (!dateMap.get(runSeries))
		dateMap.set(runSeries, {
			trips: [],
			vehicle_sightings: [],
			series: runSeries.toUpperCase(),
			date,
		});
	return dateMap.get(runSeries)!;
}

export function setRunSeries(date: number, runSeries: string, data: RunSeries): void {
	let dateMap = augmentedCache.runSeriesCache.get(date);
	if (!dateMap) {
		dateMap = new Map();
		augmentedCache.runSeriesCache.set(date, dateMap);
	}
	dateMap.set(runSeries, data);
}

function resetStaticCache(): void {
	rawCache = {
		stopTimeUpdates: [],
		tripUpdates: [],
		vehiclePositions: [],
		stopTimes: [],

		calendars: [],
		calendarDates: [],

		trips: [],
		stops: [],
		routes: [],

		tripsRec: new Map(),
		stopsRec: new Map(),
		routesRec: new Map(),

		qrtPlaces: [],
		qrtTrains: [],
	};

	augmentedCache = {
		trips: [],
		stops: [],
		stopTimes: {},
		baseStopTimes: {},
		tripsRec: new Map(),
		stopsRec: new Map(),
		serviceDateTrips: new Map(),
		expressInfoCache: new LRUCache<string, any[]>(1000),
		passingStopsCache: new LRUCache<string, any[]>(5000),
		runSeriesCache: new Map(),
	};
}

function resetRealtimeCache(): void {
	rawCache.stopTimeUpdates = [];
	rawCache.tripUpdates = [];
	rawCache.vehiclePositions = [];
	rawCache.qrtTrains = [];
	augmentedCache.trips = [];
	augmentedCache.tripsRec.clear();
	augmentedCache.serviceDateTrips.clear();
	augmentedCache.baseStopTimes = {};
	augmentedCache.stopTimes = {};
}

function resetRealtimeCacheIncremental(updatedTripIds: Set<string>): void {
	rawCache.stopTimeUpdates = [];
	rawCache.tripUpdates = [];
	rawCache.vehiclePositions = [];
	rawCache.qrtTrains = [];

	// Clear only affected augmented data
	for (const tripId of updatedTripIds) {
		augmentedCache.tripsRec.delete(tripId);
		delete augmentedCache.stopTimes[tripId];
		delete augmentedCache.baseStopTimes[tripId];
	}

	// Remove affected trips from serviceDateTrips
	for (const [serviceDate, tripIds] of augmentedCache.serviceDateTrips) {
		const filteredTripIds = tripIds.filter((id) => !updatedTripIds.has(id));
		if (filteredTripIds.length === 0) {
			augmentedCache.serviceDateTrips.delete(serviceDate);
		} else {
			augmentedCache.serviceDateTrips.set(serviceDate, filteredTripIds);
		}
	}
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

	logger.debug("Loading calendars...", {
		module: "cache",
		function: "refreshStaticCache",
	});
	rawCache.calendars = gtfs.getCalendars();
	logger.debug(`Loaded ${rawCache.calendars.length} calendars.`, {
		module: "cache",
		function: "refreshStaticCache",
	});

	logger.debug("Loading calendar dates...", {
		module: "cache",
		function: "refreshStaticCache",
	});
	rawCache.calendarDates = gtfs.getCalendarDates();
	logger.debug(`Loaded ${rawCache.calendarDates.length} calendar dates.`, {
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

	for (const trip of rawCache.trips) rawCache.tripsRec.set(trip.trip_id, trip);
	for (const stop of rawCache.stops) rawCache.stopsRec.set(stop.stop_id, stop);
	for (const route of rawCache.routes) rawCache.routesRec.set(route.route_id, route);

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

	for (const trip of augmentedCache.trips) {
		augmentedCache.tripsRec.set(trip._trip.trip_id, trip);

		// Store both current stop times and base stop times (without realtime)
		augmentedCache.stopTimes[trip._trip.trip_id] = trip.stopTimes;
		augmentedCache.baseStopTimes[trip._trip.trip_id] = [...trip.stopTimes]; // Deep copy for base

		for (const serviceDate of trip.actualTripDates) {
			let tripIds = augmentedCache.serviceDateTrips.get(serviceDate);
			if (!tripIds) {
				tripIds = [];
				augmentedCache.serviceDateTrips.set(serviceDate, tripIds);
			}
			tripIds.push(trip._trip.trip_id);
		}
	}
	for (const stop of augmentedCache.stops) augmentedCache.stopsRec.set(stop.stop_id, stop);

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

	// Get only trips that have updates for incremental processing
	const updatedTripIds = new Set([
		...rawCache.stopTimeUpdates.map((u) => u.trip_id).filter((id) => id !== undefined),
		...rawCache.tripUpdates.map((u) => u.trip_id).filter((id) => id !== undefined),
	]);

	logger.debug(`Found ${updatedTripIds.size} trips with realtime updates.`, {
		module: "cache",
		function: "refreshRealtimeCache",
	});

	if (updatedTripIds.size === 0) {
		logger.debug("No trips have realtime updates, skipping re-augmentation.", {
			module: "cache",
			function: "refreshRealtimeCache",
		});
		logger.info("Realtime GTFS cache refreshed.", {
			module: "cache",
			function: "refreshRealtimeCache",
		});
		return;
	}

	// Use incremental reset instead of full reset
	resetRealtimeCacheIncremental(updatedTripIds);

	logger.debug("Re-augmenting updated trips...", {
		module: "cache",
		function: "refreshRealtimeCache",
	});

	// Only re-augment trips that have updates
	for (const tripId of updatedTripIds) {
		const rawTrip = rawCache.tripsRec.get(tripId);
		if (rawTrip) {
			const augmentedTrip = augmentTrip(rawTrip);
			augmentedCache.tripsRec.set(tripId, augmentedTrip);
		}
	}

	logger.debug(`Re-augmented ${updatedTripIds.size} trips.`, {
		module: "cache",
		function: "refreshRealtimeCache",
	});

	logger.debug("Building augmented cache records for updated trips...", {
		module: "cache",
		function: "refreshRealtimeCache",
	});

	// Rebuild cache records only for updated trips
	for (const tripId of updatedTripIds) {
		const trip = augmentedCache.tripsRec.get(tripId);
		if (!trip) continue;

		// Store both current stop times and base stop times (without realtime)
		augmentedCache.stopTimes[trip._trip.trip_id] = trip.stopTimes;
		augmentedCache.baseStopTimes[trip._trip.trip_id] = [...trip.stopTimes]; // Deep copy for base

		for (const serviceDate of trip.actualTripDates) {
			let tripIds = augmentedCache.serviceDateTrips.get(serviceDate);
			if (!tripIds) {
				tripIds = [];
				augmentedCache.serviceDateTrips.set(serviceDate, tripIds);
			}
			tripIds.push(trip._trip.trip_id);
		}
	}

	logger.info("Realtime GTFS cache refreshed incrementally.", {
		module: "cache",
		function: "refreshRealtimeCache",
	});
}
