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
import { AugmentedTrip, AugmentedTripInstance, augmentTrip, calculateRunSeries, RunSeries } from "./utils/augmentedTrip.js";
import { AugmentedStopTime } from "./utils/augmentedStopTime.js";
import { QRTPlace, TravelTrip } from "./index.js";
import { getCurrentQRTravelTrains, getPlaces } from "./qr-travel/qr-travel-tracker.js";
import logger from "./utils/logger.js";
import { getGtfs } from "./gtfsInterfaceLayer.js";
import * as qdf from "qdf-gtfs";
import { addSC, addSCI, ensureServiceCapacityData } from "./utils/serviceCapacity.js";

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
	passingTrips: Map<string, string[]>; // Maps stopId to list of trip IDs that pass through it

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
		passingTrips: new Map(),
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
			const k = key as keyof typeof c;
			if (c[k] !== filter[k]) return false;
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
			const k = key as keyof typeof c;
			if (c[k] !== filter[k]) return false;
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
	if (trip_id) return raw.tripUpdates.filter((v) => v.trip.trip_id == trip_id);
	return raw.tripUpdates;
}

export function getVehiclePositions(trip_id?: string, ctx?: CacheContext): RealtimeVehiclePosition[] {
	const { raw } = getContext(ctx);
	const gtfs = getGtfs();
	if (raw.vehiclePositions.length === 0) raw.vehiclePositions = gtfs.getRealtimeVehiclePositions();
	if (trip_id) return raw.vehiclePositions.filter((v) => v.trip.trip_id == trip_id);
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
		if (trip) return [addSC(trip)];
		const rawTrip = raw.tripsRec.get(trip_id);
		if (rawTrip) {
			const augmentedTrip = augmentTrip(rawTrip, context);
			augmented.tripsRec.set(trip_id, augmentedTrip);
			return [addSC(augmentedTrip)];
		}
		return [];
	}
	// Build from tripsRec to ensure we have current data
	return Array.from(augmented.tripsRec.values()).map(v => addSC(v));
}

export function getAugmentedTripInstance(instance_id: string, ctx?: CacheContext): AugmentedTripInstance | null {
	try {
		let res = getAugmentedTrips(JSON.parse(atob(instance_id))[0], ctx)[0].instances.find(v => v.instance_id === instance_id);
		return res ? addSCI(res) : null;
	} catch {
		return null;
	}
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
			// Search across all instances
			for (const instance of augmentedTrip.instances) {
				const augmentedStopTime = instance.stopTimes.find(
					(ast) =>
						ast._stopTime?.stop_sequence === st.stop_sequence && ast.scheduled_stop?.stop_id === st.stop_id,
				);
				if (augmentedStopTime) {
					results.push(augmentedStopTime);
				}
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

export function getPassingTrips(stopId: string, ctx?: CacheContext): string[] {
	const { augmented } = getContext(ctx);
	return augmented.passingTrips.get(stopId) ?? [];
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
		const tripId = augmented.serviceDateTrips.get(date)?.find((v) => v.endsWith(runSeries));
		if (tripId) {
			const trip = getAugmentedTrips(tripId, context)[0];
			// Find relevant instance for date
			const instance = trip.instances.find(i => i.serviceDate === date);
			if (instance) {
				calculateRunSeries(instance, context);
			}
		}
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

	// Remove affected trips from passingTrips
	for (const [stopId, tripIds] of augmentedCache.passingTrips) {
		const filteredTripIds = tripIds.filter((id) => !updatedTripIds.has(id));
		if (filteredTripIds.length === 0) {
			augmentedCache.passingTrips.delete(stopId);
		} else {
			augmentedCache.passingTrips.set(stopId, filteredTripIds);
		}
	}
}

export async function refreshStaticCache(): Promise<void> {
	const gtfs = getGtfs();
	logger.debug("Refreshing static GTFS cache...", {
		module: "cache",
		function: "refreshStaticCache",
	});

	// Create new local caches (Double Buffering)
	const newRawCache = createEmptyRawCache();
	const newAugmentedCache = createEmptyAugmentedCache();
	const ctx: CacheContext = { raw: newRawCache, augmented: newAugmentedCache };

	newRawCache.qrtPlaces = await getPlaces();
	logger.debug(`Loaded ${newRawCache.qrtPlaces.length} QRT places.`, {
		module: "cache",
		function: "refreshStaticCache",
	});

	newRawCache.stops = gtfs.getStops();
	logger.debug(`Loaded ${newRawCache.stops.length} stops.`, {
		module: "cache",
		function: "refreshStaticCache",
	});

	newRawCache.calendars = gtfs.getCalendars();
	logger.debug(`Loaded ${newRawCache.calendars.length} calendars.`, {
		module: "cache",
		function: "refreshStaticCache",
	});

	newRawCache.calendarDates = gtfs.getCalendarDates();
	logger.debug(`Loaded ${newRawCache.calendarDates.length} calendar dates.`, {
		module: "cache",
		function: "refreshStaticCache",
	});

	newRawCache.routes = gtfs.getRoutes();
	logger.debug(`Loaded ${newRawCache.routes.length} routes.`, {
		module: "cache",
		function: "refreshStaticCache",
	});

	newRawCache.trips = gtfs.getTrips().filter((v) => v.trip_id.includes("-QR "));
	logger.debug(`Loaded ${newRawCache.trips.length} trips.`, {
		module: "cache",
		function: "refreshStaticCache",
	});

	await ensureServiceCapacityData();

	for (const trip of newRawCache.trips) newRawCache.tripsRec.set(trip.trip_id, trip);
	for (const stop of newRawCache.stops) newRawCache.stopsRec.set(stop.stop_id, stop);
	for (const route of newRawCache.routes) newRawCache.routesRec.set(route.route_id, route);

	newAugmentedCache.stops = await processWithProgress(newRawCache.stops, "Augmenting stops", (s) =>
		augmentStop(s, ctx),
	);
	logger.debug(`Augmented ${newAugmentedCache.stops.length} stops.`, {
		module: "cache",
		function: "refreshStaticCache",
	});

	newAugmentedCache.trips = await processWithProgress(newRawCache.trips, "Augmenting trips", (trip) =>
		augmentTrip(trip, ctx),
	);
	for (const trip of newAugmentedCache.trips) {
		newAugmentedCache.tripsRec.set(trip.trip_id, trip);
	}

	logger.debug(`Augmented ${newAugmentedCache.tripsRec.size} trips.`, {
		module: "cache",
		function: "refreshStaticCache",
	});

	for (const trip of newAugmentedCache.trips) {
		newAugmentedCache.tripsRec.set(trip.trip_id, trip);

		// Store both current stop times and base stop times (without realtime)
		const allStopTimes = trip.instances.flatMap(i => i.stopTimes);

		newAugmentedCache.stopTimes[trip.trip_id] = allStopTimes;
		// Deep copy for base
		newAugmentedCache.baseStopTimes[trip.trip_id] = [...allStopTimes];

		// Update serviceDateTrips
		for (const instance of trip.instances) {
			// Each instance has dates
			for (const date of instance.actualTripDates) {
				let tripIds = newAugmentedCache.serviceDateTrips.get(date);
				if (!tripIds) {
					tripIds = [];
					newAugmentedCache.serviceDateTrips.set(date, tripIds);
				}
				if (!tripIds.includes(trip.trip_id)) tripIds.push(trip.trip_id);
			}

			// Populate passingTrips
			for (const st of instance.stopTimes) {
				if (st.passing && st.actual_stop) {
					const stopId = st.actual_stop.stop_id;
					let tripIds = newAugmentedCache.passingTrips.get(stopId);
					if (!tripIds) {
						tripIds = [];
						newAugmentedCache.passingTrips.set(stopId, tripIds);
					}
					if (!tripIds.includes(trip.trip_id)) tripIds.push(trip.trip_id);
				}
			}
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
	const tripsToUpdate: Trip[] = [];
	for (const id of updatedTripIds) {
		const t = rawCache.tripsRec.get(id);
		if (t) tripsToUpdate.push(t);
	}

	const updatedAugmented = await processWithProgress(tripsToUpdate, "Re-augmenting updated trips", (t) =>
		augmentTrip(t),
	);

	for (const at of updatedAugmented) {
		augmentedCache.tripsRec.set(at.trip_id, at);
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

		const allStopTimes = trip.instances.flatMap(i => i.stopTimes);

		augmentedCache.stopTimes[trip.trip_id] = allStopTimes;
		augmentedCache.baseStopTimes[trip.trip_id] = [...allStopTimes];

		for (const instance of trip.instances) {
			for (const serviceDate of instance.actualTripDates) {
				let tripIds = augmentedCache.serviceDateTrips.get(serviceDate);
				if (!tripIds) {
					tripIds = [];
					augmentedCache.serviceDateTrips.set(serviceDate, tripIds);
				}
				if (!tripIds.includes(trip.trip_id)) tripIds.push(trip.trip_id);
			}

			// Populate passingTrips for updated trips
			for (const st of instance.stopTimes) {
				if (st.passing && st.actual_stop) {
					const stopId = st.actual_stop.stop_id;
					let tripIds = augmentedCache.passingTrips.get(stopId);
					if (!tripIds) {
						tripIds = [];
						augmentedCache.passingTrips.set(stopId, tripIds);
					}
					if (!tripIds.includes(trip.trip_id)) tripIds.push(trip.trip_id);
				}
			}
		}
	}

	await qrt_promise;

	logger.info("Realtime GTFS cache refreshed incrementally.", {
		module: "cache",
		function: "refreshRealtimeCache",
	});
}

async function processWithProgress<T, U>(
	items: T[],
	taskName: string,
	processFn: (item: T) => U,
	chunkSize = 1000,
): Promise<U[]> {
	const results: U[] = [];
	let current = 0;
	const total = items.length;
	const startTime = Date.now();

	if (total === 0) return results;

	// Initial progress update
	logger.progress({
		task: taskName,
		current: 0,
		total,
		speed: 0,
		eta: 0,
		percent: 0,
		unit: "items",
	});

	for (let i = 0; i < total; i += chunkSize) {
		const chunk = items.slice(i, i + chunkSize);
		for (const item of chunk) {
			results.push(processFn(item));
		}
		current += chunk.length;

		// Yield to event loop
		await new Promise((resolve) => setImmediate(resolve));

		const elapsed = (Date.now() - startTime) / 1000;
		const speed = elapsed > 0 ? current / elapsed : 0;

		logger.progress({
			task: taskName,
			current,
			total,
			speed,
			eta: speed > 0 ? (total - current) / speed : 0,
			percent: (current / total) * 100,
			unit: "items",
		});
	}

	return results;
}
