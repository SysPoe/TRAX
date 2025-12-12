import type {
	Calendar,
	CalendarDate,
	RealtimeTripUpdate,
	RealtimeVehiclePosition,
	RealtimeStopTimeUpdate,
	Route,
	Stop,
	StopTime,
	Trip,
} from "qdf-gtfs";
import { AugmentedStop, augmentStop } from "./utils/augmentedStop.js";
import { AugmentedTrip, augmentTrip, calculateRunSeries, RunSeries } from "./utils/augmentedTrip.js";
import { AugmentedStopTime } from "./utils/augmentedStopTime.js";
import { QRTPlace, TravelTrip } from "./index.js";
import { getCurrentQRTravelTrains, getPlaces } from "./qr-travel/qr-travel-tracker.js";
import logger from "./utils/logger.js";
import { getGtfs } from "./gtfsInterfaceLayer.js";
import * as qdf from "qdf-gtfs";

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

export type RawCache = {
	tripUpdates: RealtimeTripUpdate[];
	vehiclePositions: RealtimeVehiclePosition[];

	stopTimes: StopTime[];

	calendars: Calendar[];
	calendarDates: CalendarDate[];

	trips: Trip[];
	stops: Stop[];
	routes: Route[];

	tripsRec: Map<string, Trip>;
	stopsRec: Map<string, Stop>;
	routesRec: Map<string, Route>;

	qrtPlaces: QRTPlace[];
	qrtTrains: TravelTrip[];
};

export type AugmentedCache = {
	trips: AugmentedTrip[];
	stops: AugmentedStop[];

	stopTimes: { [trip_id: string]: AugmentedStopTime[] };
	baseStopTimes: { [trip_id: string]: AugmentedStopTime[] }; // Cached base stop times without realtime
	tripsRec: Map<string, AugmentedTrip>;
	stopsRec: Map<string, AugmentedStop>;

	serviceDateTrips: Map<string, string[]>; // Maps serviceDate to trip IDs

	// Performance caches with LRU eviction
	expressInfoCache: LRUCache<string, any[]>;
	passingStopsCache: LRUCache<string, any[]>;
	runSeriesCache: Map<string, Map<string, RunSeries>>;
};

export type CacheContext = {
	raw: RawCache;
	augmented: AugmentedCache;
};

export function createEmptyRawCache(): RawCache {
	return {
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
}

export function createEmptyAugmentedCache(): AugmentedCache {
	return {
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
}

let rawCache: RawCache = createEmptyRawCache();
let augmentedCache: AugmentedCache = createEmptyAugmentedCache();

function getContext(ctx?: CacheContext): CacheContext {
	if (ctx) return ctx;
	return { raw: rawCache, augmented: augmentedCache };
}

export function getCalendars(filter?: Partial<Calendar>, ctx?: CacheContext): Calendar[] {
	const { raw } = getContext(ctx);
	const gtfs = getGtfs();
	if (!raw.calendars || raw.calendars.length === 0) raw.calendars = gtfs.getCalendars();
	if (!filter) return raw.calendars;
	// simple filter implementation
	return raw.calendars.filter((c) => {
		for (const key of Object.keys(filter)) {
			// @ts-ignore
			if (c[key] !== filter[key]) return false;
		}
		return true;
	});
}

export function getCalendarDates(filter?: Partial<CalendarDate>, ctx?: CacheContext): CalendarDate[] {
	const { raw } = getContext(ctx);
	const gtfs = getGtfs();
	if (!raw.calendarDates || raw.calendarDates.length === 0) raw.calendarDates = gtfs.getCalendarDates();
	if (!filter) return raw.calendarDates;
	return raw.calendarDates.filter((c) => {
		for (const key of Object.keys(filter)) {
			// @ts-ignore
			if (c[key] !== filter[key]) return false;
		}
		return true;
	});
}

export function getRawTrips(trip_id?: string, ctx?: CacheContext): Trip[] {
	const { raw } = getContext(ctx);
	if (trip_id) {
		const trip = raw.tripsRec.get(trip_id);
		return trip ? [trip] : [];
	}
	return raw.trips;
}

export function getRawStops(stop_id?: string, ctx?: CacheContext): Stop[] {
	const { raw } = getContext(ctx);
	if (stop_id) {
		const stop = raw.stopsRec.get(stop_id);
		return stop ? [stop] : [];
	}
	return raw.stops;
}

export function getRawRoutes(route_id?: string, ctx?: CacheContext): Route[] {
	const { raw } = getContext(ctx);
	if (route_id) {
		const route = raw.routesRec.get(route_id);
		return route ? [route] : [];
	}
	return raw.routes;
}

export function getRawCalendars(ctx?: CacheContext): Calendar[] {
	const { raw } = getContext(ctx);
	return raw.calendars;
}

export function getRawCalendarDates(ctx?: CacheContext): CalendarDate[] {
	const { raw } = getContext(ctx);
	return raw.calendarDates;
}

export function getTripUpdates(trip_id?: string, ctx?: CacheContext): RealtimeTripUpdate[] {
	const { raw } = getContext(ctx);
	const gtfs = getGtfs();
	if (raw.tripUpdates.length === 0) raw.tripUpdates = gtfs.getRealtimeTripUpdates();
	if (trip_id) return raw.tripUpdates.filter((v) => v.trip.trip_id == trip_id); // TODO make better
	return raw.tripUpdates;
}

export function getVehiclePositions(trip_id?: string, ctx?: CacheContext): RealtimeVehiclePosition[] {
	const { raw } = getContext(ctx);
	const gtfs = getGtfs();
	if (raw.vehiclePositions.length === 0) raw.vehiclePositions = gtfs.getRealtimeVehiclePositions();
	if (trip_id) return raw.vehiclePositions.filter((v) => v.trip.trip_id == trip_id); // TODO make better
	return raw.vehiclePositions;
}

export function getStopTimeUpdates(trip_id: string, ctx?: CacheContext): RealtimeStopTimeUpdate[] {
	return getTripUpdates(trip_id, ctx)[0]?.stop_time_updates ?? [];
}

export function getQRTPlaces(ctx?: CacheContext): QRTPlace[] {
	const { raw } = getContext(ctx);
	return raw.qrtPlaces;
}

export function getQRTTrains(ctx?: CacheContext): TravelTrip[] {
	const { raw } = getContext(ctx);
	return raw.qrtTrains;
}

export function getRawStopTimes(trip_id: string): StopTime[] {
	return getGtfs().getStopTimesForTrip(trip_id);
}

export function getAugmentedTrips(trip_id?: string, ctx?: CacheContext): AugmentedTrip[] {
	const context = getContext(ctx);
	const { raw, augmented } = context;
	if (trip_id) {
		const trip = augmented.tripsRec.get(trip_id);
		if (trip) return [trip];
		const rawTrip = raw.tripsRec.get(trip_id);
		if (rawTrip) {
			const augmentedTrip = augmentTrip(rawTrip, context);
			augmented.tripsRec.set(trip_id, augmentedTrip);
			return [augmentedTrip];
		}
		return [];
	}
	// Build from tripsRec to ensure we have current data
	return Array.from(augmented.tripsRec.values());
}

export function getAugmentedStops(stop_id?: string, ctx?: CacheContext): AugmentedStop[] {
	const context = getContext(ctx);
	const { raw, augmented } = context;
	if (stop_id) {
		const stop = augmented.stopsRec.get(stop_id);
		if (stop) return [stop];
		const rawStop = raw.stopsRec.get(stop_id);
		if (rawStop) {
			const augmentedStop = augmentStop(rawStop, context);
			augmented.stopsRec.set(stop_id, augmentedStop);
			return [augmentedStop];
		}
		return [];
	}
	return augmented.stops ?? [];
}

export function getAugmentedStopTimes(trip_id?: string, ctx?: CacheContext): AugmentedStopTime[] {
	const { augmented } = getContext(ctx);
	if (trip_id) return augmented.stopTimes?.[trip_id] ?? [];
	return Object.values(augmented.stopTimes ?? {}).flat();
}

export function queryAugmentedStopTimes(query: qdf.StopTimeQuery, ctx?: CacheContext): AugmentedStopTime[] {
	const context = getContext(ctx);
	const results: AugmentedStopTime[] = [];
	const gtfs = getGtfs();
	gtfs.queryStopTimes(query).forEach((st) => {
		const augmentedTrip = getAugmentedTrips(st.trip_id, context)[0];
		if (augmentedTrip) {
			const augmentedStopTime = augmentedTrip.stopTimes.find(
				(ast) =>
					ast._stopTime?.stop_sequence === st.stop_sequence && ast.scheduled_stop?.stop_id === st.stop_id,
			);
			if (augmentedStopTime) {
				results.push(augmentedStopTime);
			}
		}
	});
	return results;
}

export function getBaseStopTimes(trip_id: string, ctx?: CacheContext): AugmentedStopTime[] {
	const { augmented } = getContext(ctx);
	return augmented.baseStopTimes?.[trip_id] ?? [];
}

export function cacheExpressInfo(stopListHash: string, expressInfo: any[], ctx?: CacheContext) {
	const { augmented } = getContext(ctx);
	augmented.expressInfoCache.set(stopListHash, expressInfo);
}

export function getCachedExpressInfo(stopListHash: string, ctx?: CacheContext): any[] | undefined {
	const { augmented } = getContext(ctx);
	return augmented.expressInfoCache.get(stopListHash);
}

export function cachePassingStops(stopListHash: string, passingStops: any[], ctx?: CacheContext) {
	const { augmented } = getContext(ctx);
	augmented.passingStopsCache.set(stopListHash, passingStops);
}

export function getCachedPassingStops(stopListHash: string, ctx?: CacheContext): any[] | undefined {
	const { augmented } = getContext(ctx);
	return augmented.passingStopsCache.get(stopListHash);
}

export function getRunSeries(
	date: string,
	runSeries: string,
	calcIfNotFound: boolean = true,
	ctx?: CacheContext,
): RunSeries {
	const context = getContext(ctx);
	const { augmented } = context;

	let dateMap = augmented.runSeriesCache.get(date);
	if (!dateMap) {
		dateMap = new Map();
		augmented.runSeriesCache.set(date, dateMap);
	}
	if (
		!dateMap.get(runSeries) &&
		calcIfNotFound &&
		augmented.serviceDateTrips.get(date)?.find((v) => v.endsWith(runSeries))
	) {
		calculateRunSeries(
			getAugmentedTrips(
				augmented.serviceDateTrips.get(date)?.find((v) => v.endsWith(runSeries)),
				context,
			)[0],
			context,
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

export function setRunSeries(date: string, runSeries: string, data: RunSeries, ctx?: CacheContext): void {
	const { augmented } = getContext(ctx);
	let dateMap = augmented.runSeriesCache.get(date);
	if (!dateMap) {
		dateMap = new Map();
		augmented.runSeriesCache.set(date, dateMap);
	}
	dateMap.set(runSeries, data);
}

function resetRealtimeCacheIncremental(updatedTripIds: Set<string>): void {
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
	const gtfs = getGtfs();
	logger.debug("Refreshing static GTFS cache...", {
		module: "cache",
		function: "refreshStaticCache",
	});

	// Create new local caches (Double Buffering)
	const newRawCache = createEmptyRawCache();
	const newAugmentedCache = createEmptyAugmentedCache();
	const ctx: CacheContext = { raw: newRawCache, augmented: newAugmentedCache };

	logger.debug("Loading QRT places...", {
		module: "cache",
		function: "refreshStaticCache",
	});
	newRawCache.qrtPlaces = await getPlaces();
	logger.debug(`Loaded ${newRawCache.qrtPlaces.length} QRT places.`, {
		module: "cache",
		function: "refreshStaticCache",
	});

	logger.debug("Loading stops...", {
		module: "cache",
		function: "refreshStaticCache",
	});
	newRawCache.stops = gtfs.getStops();
	logger.debug(`Loaded ${newRawCache.stops.length} stops.`, {
		module: "cache",
		function: "refreshStaticCache",
	});

	logger.debug("Loading calendars...", {
		module: "cache",
		function: "refreshStaticCache",
	});
	newRawCache.calendars = gtfs.getCalendars();
	logger.debug(`Loaded ${newRawCache.calendars.length} calendars.`, {
		module: "cache",
		function: "refreshStaticCache",
	});

	logger.debug("Loading calendar dates...", {
		module: "cache",
		function: "refreshStaticCache",
	});
	newRawCache.calendarDates = gtfs.getCalendarDates();
	logger.debug(`Loaded ${newRawCache.calendarDates.length} calendar dates.`, {
		module: "cache",
		function: "refreshStaticCache",
	});

	logger.debug("Loading routes...", {
		module: "cache",
		function: "refreshStaticCache",
	});
	newRawCache.routes = gtfs.getRoutes();
	logger.debug(`Loaded ${newRawCache.routes.length} routes.`, {
		module: "cache",
		function: "refreshStaticCache",
	});

	logger.debug("Loading trips...", {
		module: "cache",
		function: "refreshStaticCache",
	});
	newRawCache.trips = gtfs.getTrips().filter((v) => v.trip_id.includes("-QR "));
	logger.debug(`Loaded ${newRawCache.trips.length} trips.`, {
		module: "cache",
		function: "refreshStaticCache",
	});

	logger.debug("Building raw cache records...", {
		module: "cache",
		function: "refreshStaticCache",
	});

	for (const trip of newRawCache.trips) newRawCache.tripsRec.set(trip.trip_id, trip);
	for (const stop of newRawCache.stops) newRawCache.stopsRec.set(stop.stop_id, stop);
	for (const route of newRawCache.routes) newRawCache.routesRec.set(route.route_id, route);

	logger.debug("Augmenting stops...", {
		module: "cache",
		function: "refreshStaticCache",
	});
	newAugmentedCache.stops = newRawCache.stops.map((s) => augmentStop(s, ctx));
	logger.debug(`Augmented ${newAugmentedCache.stops.length} stops.`, {
		module: "cache",
		function: "refreshStaticCache",
	});

	logger.debug("Augmenting trips...", {
		module: "cache",
		function: "refreshStaticCache",
	});

	for (const tripId of newRawCache.tripsRec.keys()) {
		const rawTrip = newRawCache.tripsRec.get(tripId);
		if (rawTrip) {
			const augmentedTrip = augmentTrip(rawTrip, ctx);
			newAugmentedCache.tripsRec.set(tripId, augmentedTrip);
		}
	}
	logger.debug(`Augmented ${newAugmentedCache.tripsRec.size} trips.`, {
		module: "cache",
		function: "refreshStaticCache",
	});

	newAugmentedCache.trips = Array.from(newAugmentedCache.tripsRec.values());

	logger.debug("Building augmented cache records...", {
		module: "cache",
		function: "refreshStaticCache",
	});

	for (const trip of newAugmentedCache.trips) {
		newAugmentedCache.tripsRec.set(trip._trip.trip_id, trip);

		// Store both current stop times and base stop times (without realtime)
		newAugmentedCache.stopTimes[trip._trip.trip_id] = trip.stopTimes;
		newAugmentedCache.baseStopTimes[trip._trip.trip_id] = [...trip.stopTimes]; // Deep copy for base

		for (const serviceDate of trip.actualTripDates) {
			let tripIds = newAugmentedCache.serviceDateTrips.get(serviceDate);
			if (!tripIds) {
				tripIds = [];
				newAugmentedCache.serviceDateTrips.set(serviceDate, tripIds);
			}
			tripIds.push(trip._trip.trip_id);
		}
	}
	for (const stop of newAugmentedCache.stops) newAugmentedCache.stopsRec.set(stop.stop_id, stop);

	// SWAP CACHE
	rawCache = newRawCache;
	augmentedCache = newAugmentedCache;

	logger.info("Static GTFS cache refreshed.", {
		module: "cache",
		function: "refreshStaticCache",
	});
}

export async function refreshRealtimeCache(): Promise<void> {
	const gtfs = getGtfs();
	logger.debug("Refreshing realtime GTFS cache...", {
		module: "cache",
		function: "refreshRealtimeCache",
	});

	logger.debug("Refreshing qrtTrains cache...", {
		module: "cache",
		function: "refreshRealtimeCache",
	});

	let qrt_promise: Promise<void> = new Promise((rs) => {
		getCurrentQRTravelTrains().then((trains) => {
			rawCache.qrtTrains = trains;
			logger.debug(`Loaded ${rawCache.qrtTrains.length} QRT trains.`, {
				module: "cache",
				function: "refreshRealtimeCache",
			});
			rs();
		});
	});

	logger.debug("Loading realtime updates...", {
		module: "cache",
		function: "refreshRealtimeCache",
	});

	rawCache.tripUpdates = gtfs.getRealtimeTripUpdates();
	rawCache.vehiclePositions = gtfs.getRealtimeVehiclePositions();

	logger.debug(
		`Loaded ${rawCache.tripUpdates.length} trip updates with ${rawCache.tripUpdates.flatMap((v) => v.stop_time_updates).length} stop time updates.`,
		{
			module: "cache",
			function: "refreshRealtimeCache",
		},
	);
	logger.debug(`Loaded ${rawCache.vehiclePositions.length} vehicle positions.`, {
		module: "cache",
		function: "refreshRealtimeCache",
	});

	// Get only trips that have updates for incremental processing
	const updatedTripIds = new Set([
		...rawCache.tripUpdates.map((u) => u.trip.trip_id).filter((id) => id !== undefined),
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

	augmentedCache.trips = Array.from(augmentedCache.tripsRec.values());

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

	await qrt_promise;

	logger.info("Realtime GTFS cache refreshed incrementally.", {
		module: "cache",
		function: "refreshRealtimeCache",
	});
}
