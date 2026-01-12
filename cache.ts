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
	GTFS,
} from "qdf-gtfs";
import { isConsideredTrip } from "./utils/considered.js";
import { AugmentedStop, augmentStop } from "./utils/augmentedStop.js";
import {
	AugmentedTrip,
	AugmentedTripInstance,
	augmentTrip,
	calculateRunSeries,
	RunSeries,
} from "./utils/augmentedTrip.js";
import { AugmentedStopTime } from "./utils/augmentedStopTime.js";
import { QRTPlace, QRTTravelTrip } from "./index.js";
import { getPlaces, getCurrentQRTravelTrains } from "./region-specific/SEQ/qr-travel/qr-travel-tracker.js";
import { Timer, globalTimer } from "./utils/timer.js";
import { getRailwayStationFacilities } from "./region-specific/SEQ/facilities.js";
import { RailwayStationFacility } from "./region-specific/SEQ/facilities-types.js";
import { updateGTHAPlatforms } from "./region-specific/GTHA/realtime.js";
import logger from "./utils/logger.js";
import { getGtfs } from "./gtfsInterfaceLayer.js";
import * as qdf from "qdf-gtfs";
import { addSC, addSCI, ensureServiceCapacityData } from "./utils/serviceCapacity.js";
import { addVehicleModel, addVehicleModelTrip } from "./utils/vehicleModel.js";
import { TraxConfig } from "./config.js";
import ensureQRTEnabled from "./region-specific/SEQ/qr-travel/enabled.js";
import { getServiceDayStart } from "./utils/time.js";

class LRUCache<K, V> {
	private cache = new Map<K, V>();
	private maxSize: number;

	constructor(maxSize: number) {
		this.maxSize = maxSize;
	}

	get(key: K): V | undefined {
		const value = this.cache.get(key);
		if (value !== undefined) {
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
	regionSpecific: {
		SEQ: {
			qrtPlaces: QRTPlace[];
			qrtTrains: QRTTravelTrip[];
			platformData?: any;
			railwayStationFacilities: RailwayStationFacility[];
		};
	};
};

export type AugmentedCache = {
	trips: AugmentedTrip[];
	stops: AugmentedStop[];
	railStations: Stop[];

	stopTimes: { [trip_id: string]: AugmentedStopTime[] };
	baseStopTimes: { [trip_id: string]: AugmentedStopTime[] };
	tripsRec: Map<string, AugmentedTrip>;
	stopsRec: Map<string, AugmentedStop>;

	serviceDateTrips: Map<string, string[]>;
	passingTrips: Map<string, string[]>;

	shapes: { shape_id: string; route_id: string }[];

	expressInfoCache: LRUCache<string, any[]>;
	passingStopsCache: LRUCache<string, any[]>;
	runSeriesCache: Map<string, Map<string, RunSeries>>;

	tripsStoppingAt: Map<string, Set<string>>;
	stopDeparturesCached: Map<string, AugmentedStopTime[]>;
	instancesRec: Map<string, AugmentedTripInstance>;
	timer: Timer;
};

export type CacheContext = {
	raw: RawCache;
	augmented: AugmentedCache;
	config: TraxConfig;
	gtfs?: GTFS;
};

export function createEmptyRawCache(): RawCache {
	return {
		regionSpecific: {
			SEQ: {
				qrtPlaces: [],
				qrtTrains: [],
				platformData: undefined,
				railwayStationFacilities: [],
			},
		},
	};
}

export function createEmptyAugmentedCache(): AugmentedCache {
	return {
		trips: [],
		stops: [],
		railStations: [],
		stopTimes: {},
		baseStopTimes: {},
		tripsRec: new Map(),
		stopsRec: new Map(),
		serviceDateTrips: new Map(),
		passingTrips: new Map(),
		shapes: [],
		expressInfoCache: new LRUCache<string, any[]>(1000),
		passingStopsCache: new LRUCache<string, any[]>(5000),
		runSeriesCache: new Map(),
		tripsStoppingAt: new Map(),
		stopDeparturesCached: new Map(),
		instancesRec: new Map(),
		timer: globalTimer,
	};
}

let rawCache: RawCache = createEmptyRawCache();
let augmentedCache: AugmentedCache = createEmptyAugmentedCache();

export function getCalendars(ctx: CacheContext, filter?: Partial<Calendar>): Calendar[] {
	return (ctx.gtfs ?? getGtfs()).getCalendars(filter);
}

export function getCalendarDates(ctx: CacheContext, filter?: Partial<CalendarDate>): CalendarDate[] {
	return (ctx.gtfs ?? getGtfs()).getCalendarDates(filter);
}

export function getTrips(ctx: CacheContext, filter?: Partial<Trip> | string): Trip[] {
	const gtfs = ctx.gtfs ?? getGtfs();
	const query = typeof filter === "string" ? { trip_id: filter } : filter;
	return gtfs.getTrips(query).filter((v) => isConsideredTrip(v, gtfs));
}

export function getStops(ctx: CacheContext, filter?: Partial<Stop> | string): Stop[] {
	const query = typeof filter === "string" ? { stop_id: filter } : filter;
	return (ctx.gtfs ?? getGtfs()).getStops(query);
}

export function getRoutes(ctx: CacheContext, filter?: Partial<Route> | string): Route[] {
	const query = typeof filter === "string" ? { route_id: filter } : filter;
	return (ctx.gtfs ?? getGtfs()).getRoutes(query);
}

export function getTripUpdates(ctx: CacheContext, trip_id?: string): RealtimeTripUpdate[] {
	const gtfs = ctx.gtfs ?? getGtfs();
	const updates = gtfs.getRealtimeTripUpdates();
	if (trip_id) return updates.filter((v) => v.trip.trip_id == trip_id);
	return updates;
}

export function getVehiclePositions(ctx: CacheContext, trip_id?: string): RealtimeVehiclePosition[] {
	const gtfs = ctx.gtfs ?? getGtfs();
	const positions = gtfs.getRealtimeVehiclePositions();
	if (trip_id) return positions.filter((v) => v.trip.trip_id == trip_id);
	return positions;
}

export function getStopTimeUpdates(ctx: CacheContext, trip_id: string): RealtimeStopTimeUpdate[] {
	return getTripUpdates(ctx, trip_id)[0]?.stop_time_updates ?? [];
}

export function getStopTimes(ctx: CacheContext, query: qdf.StopTimeQuery): StopTime[] {
	return (ctx.gtfs ?? getGtfs()).getStopTimes(query);
}

// Aliases for backward compatibility
export const getRawTrips = getTrips;
export const getRawStops = getStops;
export const getRawRoutes = getRoutes;
export const getRawCalendars = getCalendars;
export const getRawCalendarDates = getCalendarDates;
export const getRawStopTimes = (ctx: CacheContext, trip_id: string) => getStopTimes(ctx, { trip_id });

export function unregisterAugmentedTrip(ctx: CacheContext, tripId: string): void {
	const { augmented } = ctx;
	const trip = augmented.tripsRec.get(tripId);
	if (!trip) return;

	for (const instance of trip.instances) {
		for (const st of instance.stopTimes) {
			const stopsToCleanup = new Set<string>();
			if (st.actual_stop_id) stopsToCleanup.add(st.actual_stop_id);
			if (st.actual_parent_station_id) stopsToCleanup.add(st.actual_parent_station_id);
			if (st.scheduled_stop_id) stopsToCleanup.add(st.scheduled_stop_id);
			if (st.scheduled_parent_station_id) stopsToCleanup.add(st.scheduled_parent_station_id);

			for (const stopId of stopsToCleanup) {
				const tripSet = augmented.tripsStoppingAt.get(stopId);
				if (tripSet) {
					tripSet.delete(tripId);
					// Clear all date-based caches for this stop
					for (const key of augmented.stopDeparturesCached.keys()) {
						if (key.startsWith(`${stopId}|`)) augmented.stopDeparturesCached.delete(key);
					}
				}
			}
		}
		augmented.instancesRec.delete(instance.instance_id);
	}
}

export function registerAugmentedTrip(ctx: CacheContext, trip: AugmentedTrip): void {
	const { augmented } = ctx;
	const tripId = trip.trip_id;

	// Populate tripsStoppingAt once per trip (from the first instance's stop times)
	// This identifies which stops this trip potentially visits.
	const firstInstance = trip.instances[0];
	if (firstInstance) {
		for (const st of firstInstance.stopTimes) {
			const stopsToIndex = new Set<string>();
			if (st.actual_stop_id) stopsToIndex.add(st.actual_stop_id);
			if (st.actual_parent_station_id) stopsToIndex.add(st.actual_parent_station_id);
			if (st.scheduled_stop_id) stopsToIndex.add(st.scheduled_stop_id);
			if (st.scheduled_parent_station_id) stopsToIndex.add(st.scheduled_parent_station_id);

			for (const stopId of stopsToIndex) {
				let tripSet = augmented.tripsStoppingAt.get(stopId);
				if (!tripSet) {
					tripSet = new Set();
					augmented.tripsStoppingAt.set(stopId, tripSet);
				}
				tripSet.add(tripId);
				// Invalidate cache for this stop across all dates (since a trip changed)
				for (const key of augmented.stopDeparturesCached.keys()) {
					if (key.startsWith(`${stopId}|`)) augmented.stopDeparturesCached.delete(key);
				}
			}
		}
	}

	for (const instance of trip.instances) {
		augmented.instancesRec.set(instance.instance_id, instance);
	}
}

export function getStopDeparturesCached(ctx: CacheContext, stopId: string, serviceDate: string): AugmentedStopTime[] {
	const timer = ctx.augmented.timer;
	timer.start("getStopDeparturesCached");
	const { augmented } = ctx;
	const cacheKey = `${stopId}|${serviceDate}`;
	let cached = augmented.stopDeparturesCached.get(cacheKey);
	if (cached) {
		timer.stop("getStopDeparturesCached");
		return cached;
	}

	timer.start("getStopDeparturesCached:idIntersection");
	const tripIdsForStop = augmented.tripsStoppingAt.get(stopId);
	const tripIdsForDate = augmented.serviceDateTrips.get(serviceDate);

	if (!tripIdsForStop || !tripIdsForDate) {
		timer.stop("getStopDeparturesCached:idIntersection");
		timer.stop("getStopDeparturesCached");
		return [];
	}

	// Intersect trips for stop and trips for date
	const relevantTripIds =
		tripIdsForStop.size < tripIdsForDate.length
			? Array.from(tripIdsForStop).filter((id) => tripIdsForDate.includes(id))
			: tripIdsForDate.filter((id) => tripIdsForStop.has(id));
	timer.stop("getStopDeparturesCached:idIntersection");

	timer.start("getStopDeparturesCached:processInstances");
	const results: AugmentedStopTime[] = [];
	for (const tripId of relevantTripIds) {
		const trip = augmented.tripsRec.get(tripId);
		if (!trip) continue;
		const instance = trip.instances.find((i) => i.serviceDate === serviceDate);
		if (!instance) continue;

		for (const st of instance.stopTimes) {
			if (
				st.actual_stop_id === stopId ||
				st.actual_parent_station_id === stopId ||
				st.scheduled_stop_id === stopId ||
				st.scheduled_parent_station_id === stopId
			) {
				results.push(st);
			}
		}
	}
	timer.stop("getStopDeparturesCached:processInstances");

	// Sort by absolute time for fast window queries
	const serviceDayStartCache = new Map<string, number>();
	const getAbsTime = (st: AugmentedStopTime) => {
		let dayStart = serviceDayStartCache.get(st.service_date);
		if (dayStart === undefined) {
			dayStart = getServiceDayStart(st.service_date, ctx.config.timezone);
			serviceDayStartCache.set(st.service_date, dayStart);
		}
		return (st.actual_departure_time ?? st.scheduled_departure_time ?? st.actual_arrival_time ?? 0) + dayStart;
	};

	timer.start("getStopDeparturesCached:sort");
	results.sort((a, b) => getAbsTime(a) - getAbsTime(b));
	timer.stop("getStopDeparturesCached:sort");

	augmented.stopDeparturesCached.set(cacheKey, results);
	timer.stop("getStopDeparturesCached");
	return results;
}

export function getAugmentedTrips(ctx: CacheContext, trip_id?: string): AugmentedTrip[] {
	const context = ctx;
	const { raw, augmented } = context;
	if (trip_id) {
		const trip = augmented.tripsRec.get(trip_id);
		if (trip) return [addVehicleModelTrip(addSC(trip, ctx, context.config), ctx, context.config)];
		const rawTrip = getTrips(ctx, trip_id)[0];
		if (rawTrip) {
			const augmentedTrip = augmentTrip(rawTrip, context);
			registerAugmentedTrip(ctx, augmentedTrip);
			augmented.tripsRec.set(trip_id, augmentedTrip);
			return [addVehicleModelTrip(addSC(augmentedTrip, ctx, context.config), ctx, context.config)];
		}
		return [];
	}
	return Array.from(augmented.tripsRec.values()).map((v) =>
		addVehicleModelTrip(addSC(v, ctx, context.config), ctx, context.config),
	);
}

export function getAugmentedTripInstance(ctx: CacheContext, instance_id: string): AugmentedTripInstance | null {
	const context = ctx;
	const cached = ctx.augmented.instancesRec.get(instance_id);
	if (cached) return cached;

	try {
		const tripId = JSON.parse(atob(instance_id))[0];
		const trip = ctx.augmented.tripsRec.get(tripId);
		if (trip) {
			const inst = trip.instances.find((v) => v.instance_id === instance_id);
			if (inst) {
				ctx.augmented.instancesRec.set(instance_id, inst);
				return inst;
			}
		}

		// Fallback to slow way if not in record
		let res = getAugmentedTrips(ctx, tripId)[0]?.instances.find((v) => v.instance_id === instance_id);
		return res ? addVehicleModel(addSCI(res, ctx, context.config), ctx, context.config) : null;
	} catch {
		return null;
	}
}

export function getVehicleTripInstance(
	ctx: CacheContext,
	vehicle: RealtimeVehiclePosition,
): AugmentedTripInstance | null {
	const tripId = vehicle.trip.trip_id;
	if (!tripId) return null;

	const augmentedTrips = getAugmentedTrips(ctx, tripId);
	if (augmentedTrips.length === 0) return null;
	const augmentedTrip = augmentedTrips[0];

	const startDate = vehicle.trip.start_date;
	if (startDate) {
		return augmentedTrip.instances.find((i) => i.serviceDate === startDate) || null;
	}

	const now = Date.now() / 1000;
	let bestInstance: AugmentedTripInstance | null = null;
	let minDiff = Infinity;

	for (const instance of augmentedTrip.instances) {
		if (instance.stopTimes.length === 0) continue;

		const serviceDayStart = getServiceDayStart(instance.serviceDate, ctx.config.timezone);

		const startTime =
			serviceDayStart +
			(instance.stopTimes[0].actual_departure_time ?? instance.stopTimes[0].actual_arrival_time ?? 0);
		const endTime =
			serviceDayStart +
			(instance.stopTimes.at(-1)!.actual_arrival_time ?? instance.stopTimes.at(-1)!.actual_departure_time ?? 0);

		if (now >= startTime && now <= endTime) {
			return instance;
		}

		const diff = Math.min(Math.abs(now - startTime), Math.abs(now - endTime));
		if (diff < minDiff) {
			minDiff = diff;
			bestInstance = instance;
		}
	}

	return bestInstance;
}

export function getAugmentedStops(ctx: CacheContext, stop_id?: string): AugmentedStop[] {
	const context = ctx;
	const { raw, augmented } = context;
	if (stop_id) {
		const stop = augmented.stopsRec.get(stop_id);
		if (stop) return [stop];
		const rawStop = getStops(ctx, stop_id)[0];
		if (rawStop) {
			const augmentedStop = augmentStop(rawStop, context);
			augmented.stopsRec.set(stop_id, augmentedStop);
			return [augmentedStop];
		}
		return [];
	}
	return augmented.stops ?? [];
}

export function getAugmentedStopTimes(ctx: CacheContext, trip_id?: string): AugmentedStopTime[] {
	const { augmented } = ctx;
	if (trip_id) return augmented.stopTimes?.[trip_id] ?? [];
	return Object.values(augmented.stopTimes ?? {}).flat();
}

export function queryAugmentedStopTimes(ctx: CacheContext, query: qdf.StopTimeQuery): AugmentedStopTime[] {
	const context = ctx;
	const { gtfs: ctxGtfs } = context;
	const results: AugmentedStopTime[] = [];
	const gtfs = ctxGtfs ?? getGtfs();
	gtfs.getStopTimes(query).forEach((st: qdf.StopTime) => {
		const augmentedTrip = getAugmentedTrips(context, st.trip_id)[0];
		if (augmentedTrip) {
			for (const instance of augmentedTrip.instances) {
				const augmentedStopTime = instance.stopTimes.find(
					(ast) => ast._stopTime?.stop_sequence === st.stop_sequence && ast.scheduled_stop_id === st.stop_id,
				);
				if (augmentedStopTime) {
					results.push(augmentedStopTime);
				}
			}
		}
	});
	return results;
}

export function getBaseStopTimes(ctx: CacheContext, trip_id: string): AugmentedStopTime[] {
	const { augmented } = ctx;
	return augmented.baseStopTimes?.[trip_id] ?? [];
}

export function cacheExpressInfo(ctx: CacheContext, stopListHash: string, expressInfo: any[]) {
	const { augmented } = ctx;
	augmented.expressInfoCache.set(stopListHash, expressInfo);
}

export function getCachedExpressInfo(ctx: CacheContext, stopListHash: string): any[] | undefined {
	const { augmented } = ctx;
	return augmented.expressInfoCache.get(stopListHash);
}

export function cachePassingStops(ctx: CacheContext, stopListHash: string, passingStops: any[]) {
	const { augmented } = ctx;
	augmented.passingStopsCache.set(stopListHash, passingStops);
}

export function getCachedPassingStops(ctx: CacheContext, stopListHash: string): any[] | undefined {
	const { augmented } = ctx;
	return augmented.passingStopsCache.get(stopListHash);
}

export function getPassingTrips(ctx: CacheContext, stopId: string): string[] {
	const { augmented } = ctx;
	return augmented.passingTrips.get(stopId) ?? [];
}

export function getShapes(ctx: CacheContext): { shape_id: string; route_id: string }[] {
	return ctx.augmented.shapes;
}

export function getRunSeries(
	ctx: CacheContext,
	date: string,
	runSeries: string,
	calcIfNotFound: boolean = true,
): RunSeries {
	const context = ctx;
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
			const trip = getAugmentedTrips(context, tripId)[0];
			const instance = trip.instances.find((i) => i.serviceDate === date);
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

export function setRunSeries(date: string, runSeries: string, data: RunSeries, ctx: CacheContext): void {
	const { augmented } = ctx;
	let dateMap = augmented.runSeriesCache.get(date);
	if (!dateMap) {
		dateMap = new Map();
		augmented.runSeriesCache.set(date, dateMap);
	}
	dateMap.set(runSeries, data);
}

export function SEQgetQRTPlaces(ctx: CacheContext): QRTPlace[] {
	ensureQRTEnabled(ctx.config);
	const { raw } = ctx;
	return raw.regionSpecific.SEQ.qrtPlaces;
}

export function SEQgetQRTTrains(ctx: CacheContext): QRTTravelTrip[] {
	ensureQRTEnabled(ctx.config);
	const { raw } = ctx;
	return raw.regionSpecific.SEQ.qrtTrains;
}

export function SEQgetRailwayStationFacilities(ctx: CacheContext): RailwayStationFacility[] {
	const { raw } = ctx;
	return raw.regionSpecific.SEQ.railwayStationFacilities;
}

function resetRealtimeCacheIncremental(updatedTripIds: Set<string>, ctx: CacheContext): void {
	const { augmented: augmentedCache } = ctx;

	for (const tripId of updatedTripIds) {
		unregisterAugmentedTrip(ctx, tripId);
		augmentedCache.tripsRec.delete(tripId);
		delete augmentedCache.stopTimes[tripId];
		delete augmentedCache.baseStopTimes[tripId];
	}

	for (const [serviceDate, tripIds] of augmentedCache.serviceDateTrips) {
		const filteredTripIds = tripIds.filter((id) => !updatedTripIds.has(id));
		if (filteredTripIds.length === 0) {
			augmentedCache.serviceDateTrips.delete(serviceDate);
		} else {
			augmentedCache.serviceDateTrips.set(serviceDate, filteredTripIds);
		}
	}

	for (const [stopId, tripIds] of augmentedCache.passingTrips) {
		const filteredTripIds = tripIds.filter((id) => !updatedTripIds.has(id));
		if (filteredTripIds.length === 0) {
			augmentedCache.passingTrips.delete(stopId);
		} else {
			augmentedCache.passingTrips.set(stopId, filteredTripIds);
		}
	}
}

export async function refreshStaticCache(gtfs: GTFS, config: TraxConfig): Promise<CacheContext> {
	logger.debug("Refreshing static GTFS cache...", {
		module: "cache",
		function: "refreshStaticCache",
	});

	const newRawCache = createEmptyRawCache();
	const newAugmentedCache = createEmptyAugmentedCache();
	const ctx: CacheContext = { raw: newRawCache, augmented: newAugmentedCache, config, gtfs };
	const startTotal = Date.now();
	ctx.augmented.timer.clear();
	ctx.augmented.timer.start("refreshStaticCache");

	const serviceDateTripsMap = new Map<string, Set<string>>();
	const passingTripsMap = new Map<string, Set<string>>();

	if (config.region === "SEQ") {
		ctx.augmented.timer.start("refreshStaticCache:loadQRTPlaces");
		newRawCache.regionSpecific.SEQ.qrtPlaces = await getPlaces(config);
		ctx.augmented.timer.stop("refreshStaticCache:loadQRTPlaces");
		logger.debug(`Loaded ${newRawCache.regionSpecific.SEQ.qrtPlaces.length} QRT places.`, {
			module: "cache",
			function: "refreshStaticCache",
		});
		ctx.augmented.timer.start("refreshStaticCache:loadRailwayFacilities");
		newRawCache.regionSpecific.SEQ.railwayStationFacilities = await getRailwayStationFacilities(config);
		ctx.augmented.timer.stop("refreshStaticCache:loadRailwayFacilities");
		logger.debug(
			`Loaded ${newRawCache.regionSpecific.SEQ.railwayStationFacilities.length} railway station facilities.`,
			{
				module: "cache",
				function: "refreshStaticCache",
			},
		);
	}

	ctx.augmented.timer.start("refreshStaticCache:loadStops");
	const stops = gtfs.getStops();
	ctx.augmented.timer.stop("refreshStaticCache:loadStops");
	logger.debug(`Loaded ${stops.length} stops.`, {
		module: "cache",
		function: "refreshStaticCache",
	});

	ctx.augmented.timer.start("refreshStaticCache:loadCalendars");
	const calendars = gtfs.getCalendars();
	ctx.augmented.timer.stop("refreshStaticCache:loadCalendars");
	logger.debug(`Loaded ${calendars.length} calendars.`, {
		module: "cache",
		function: "refreshStaticCache",
	});

	ctx.augmented.timer.start("refreshStaticCache:loadCalendarDates");
	const calendarDates = gtfs.getCalendarDates();
	ctx.augmented.timer.stop("refreshStaticCache:loadCalendarDates");
	logger.debug(`Loaded ${calendarDates.length} calendar dates.`, {
		module: "cache",
		function: "refreshStaticCache",
	});

	ctx.augmented.timer.start("refreshStaticCache:loadRoutes");
	const routes = gtfs.getRoutes();
	ctx.augmented.timer.stop("refreshStaticCache:loadRoutes");
	logger.debug(`Loaded ${routes.length} routes.`, {
		module: "cache",
		function: "refreshStaticCache",
	});

	ctx.augmented.timer.start("refreshStaticCache:loadTrips");
	const trips = gtfs.getTrips().filter((v) => isConsideredTrip(v, gtfs));
	ctx.augmented.timer.stop("refreshStaticCache:loadTrips");
	logger.debug(`Loaded ${trips.length} trips.`, {
		module: "cache",
		function: "refreshStaticCache",
	});

	ctx.augmented.timer.start("refreshStaticCache:processShapes");
	const shapeSet = new Set<string>();
	for (const trip of trips) {
		if (trip.shape_id && !shapeSet.has(trip.shape_id)) {
			shapeSet.add(trip.shape_id);
			newAugmentedCache.shapes.push({ shape_id: trip.shape_id, route_id: trip.route_id });
		}
	}
	ctx.augmented.timer.stop("refreshStaticCache:processShapes");

	ctx.augmented.timer.start("refreshStaticCache:ensureServiceCapacity");
	await ensureServiceCapacityData(config);
	ctx.augmented.timer.stop("refreshStaticCache:ensureServiceCapacity");

	ctx.augmented.timer.start("refreshStaticCache:augmentStops");
	newAugmentedCache.stops = await processWithProgress(stops, "Augmenting stops", (s) => augmentStop(s, ctx));
	ctx.augmented.timer.stop("refreshStaticCache:augmentStops");
	logger.debug(`Augmented ${newAugmentedCache.stops.length} stops.`, {
		module: "cache",
		function: "refreshStaticCache",
	});

	// Prime stop lookup map before trip augmentation to avoid repeated per-stop augmentation work
	ctx.augmented.timer.start("refreshStaticCache:primeStopMap");
	for (const stop of newAugmentedCache.stops) newAugmentedCache.stopsRec.set(stop.stop_id, stop);
	ctx.augmented.timer.stop("refreshStaticCache:primeStopMap");

	ctx.augmented.timer.start("refreshStaticCache:augmentTrips");
	newAugmentedCache.trips = await processWithProgress(trips, "Augmenting trips", (trip) => {
		const augmentedTrip = augmentTrip(trip, ctx);

		newAugmentedCache.tripsRec.set(augmentedTrip.trip_id, augmentedTrip);
		registerAugmentedTrip(ctx, augmentedTrip);

		const allStopTimes = augmentedTrip.instances.flatMap((i) => i.stopTimes);
		newAugmentedCache.stopTimes[augmentedTrip.trip_id] = allStopTimes;
		newAugmentedCache.baseStopTimes[augmentedTrip.trip_id] = [...allStopTimes];

		for (const instance of augmentedTrip.instances) {
			for (const date of instance.actualTripDates) {
				let tripIdSet = serviceDateTripsMap.get(date);
				if (!tripIdSet) {
					tripIdSet = new Set();
					serviceDateTripsMap.set(date, tripIdSet);
				}
				tripIdSet.add(augmentedTrip.trip_id);
			}

			for (const st of instance.stopTimes) {
				if (st.passing && st.actual_stop_id) {
					const stopId = st.actual_stop_id;
					let tripIdSet = passingTripsMap.get(stopId);
					if (!tripIdSet) {
						tripIdSet = new Set();
						passingTripsMap.set(stopId, tripIdSet);
					}
					tripIdSet.add(augmentedTrip.trip_id);
				}
			}
		}

		return augmentedTrip;
	});
	ctx.augmented.timer.stop("refreshStaticCache:augmentTrips");

	ctx.augmented.timer.start("refreshStaticCache:buildServiceDateTrips");
	for (const [date, set] of serviceDateTripsMap) {
		newAugmentedCache.serviceDateTrips.set(date, Array.from(set));
	}
	ctx.augmented.timer.stop("refreshStaticCache:buildServiceDateTrips");

	ctx.augmented.timer.start("refreshStaticCache:buildPassingTrips");
	for (const [stopId, set] of passingTripsMap) {
		newAugmentedCache.passingTrips.set(stopId, Array.from(set));
	}
	ctx.augmented.timer.stop("refreshStaticCache:buildPassingTrips");

	rawCache = newRawCache;
	augmentedCache = newAugmentedCache;

	ctx.augmented.timer.stop("refreshStaticCache");
	ctx.augmented.timer.log("Static Cache Refresh", true);

	logger.info(`Static GTFS cache refreshed in ${((Date.now() - (startTotal as number)) / 1000).toFixed(2)}s.`, {
		module: "cache",
		function: "refreshStaticCache",
	});

	return ctx;
}

export async function refreshRealtimeCache(gtfs: GTFS, config: TraxConfig, ctx: CacheContext): Promise<void> {
	const startTotal = Date.now();
	ctx.augmented.timer.start("refreshRealtimeCache");
	const { raw: rawCache, augmented: augmentedCache } = ctx;

	logger.debug("Refreshing realtime GTFS cache...", {
		module: "cache",
		function: "refreshRealtimeCache",
	});

	let additionalPromises: Promise<any>[] = [];

	if (config.region === "SEQ") {
		logger.debug("Refreshing qrtTrains cache...", {
			module: "cache",
			function: "refreshRealtimeCache",
		});
		additionalPromises.push(
			new Promise<void>((rs) => {
				getCurrentQRTravelTrains(ctx).then((trains: QRTTravelTrip[]) => {
					rawCache.regionSpecific.SEQ.qrtTrains = trains;
					logger.debug(`Loaded ${rawCache.regionSpecific.SEQ.qrtTrains.length} QRT trains.`, {
						module: "cache",
						function: "refreshRealtimeCache",
					});
					rs();
				});
			}),
		);
	}

	logger.debug("Loading realtime updates...", {
		module: "cache",
		function: "refreshRealtimeCache",
	});

	const tripUpdates = gtfs.getRealtimeTripUpdates();
	const vehiclePositions = gtfs.getRealtimeVehiclePositions();

	logger.debug(
		`Loaded ${tripUpdates.length} trip updates with ${tripUpdates.flatMap((v) => v.stop_time_updates).length} stop time updates.`,
		{
			module: "cache",
			function: "refreshRealtimeCache",
		},
	);
	logger.debug(`Loaded ${vehiclePositions.length} vehicle positions.`, {
		module: "cache",
		function: "refreshRealtimeCache",
	});

	const updatedTripIds = new Set([...tripUpdates.map((u) => u.trip.trip_id).filter((id) => id !== undefined)]);

	logger.debug(`Found ${updatedTripIds.size} trips with realtime updates.`, {
		module: "cache",
		function: "refreshRealtimeCache",
	});

	if (updatedTripIds.size === 0) {
		logger.debug("No trips have realtime updates, skipping re-augmentation.", {
			module: "cache",
			function: "refreshRealtimeCache",
		});
	} else {
		resetRealtimeCacheIncremental(updatedTripIds, ctx);

		logger.debug("Re-augmenting updated trips...", {
			module: "cache",
			function: "refreshRealtimeCache",
		});

		const tripsToUpdate = getTrips(ctx).filter((t) => updatedTripIds.has(t.trip_id));

		const updatedAugmented = await processWithProgress(tripsToUpdate, "Re-augmenting updated trips", (t) =>
			augmentTrip(t, ctx),
		);

		for (const at of updatedAugmented) {
			augmentedCache.tripsRec.set(at.trip_id, at);
			registerAugmentedTrip(ctx, at);
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

		for (const tripId of updatedTripIds) {
			const trip = augmentedCache.tripsRec.get(tripId);
			if (!trip) continue;

			const allStopTimes = trip.instances.flatMap((i) => i.stopTimes);

			augmentedCache.stopTimes[trip.trip_id] = allStopTimes;
			augmentedCache.baseStopTimes[trip.trip_id] = [...allStopTimes];

			for (const instance of trip.instances) {
				for (const date of instance.actualTripDates) {
					let tripIds = augmentedCache.serviceDateTrips.get(date);
					if (!tripIds) {
						tripIds = [];
						augmentedCache.serviceDateTrips.set(date, tripIds);
					}
					if (!tripIds.includes(trip.trip_id)) tripIds.push(trip.trip_id);
				}

				for (const st of instance.stopTimes) {
					if (st.passing && st.actual_stop_id) {
						const stopId = st.actual_stop_id;
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
		for (const stop of augmentedCache.stops) augmentedCache.stopsRec.set(stop.stop_id, stop);
	}

	await updateGTHAPlatforms(ctx, gtfs);

	ctx.augmented.timer.stop("refreshRealtimeCache");
	ctx.augmented.timer.log("Realtime Cache Refresh", true);

	logger.info(`Realtime GTFS cache refreshed in ${((Date.now() - startTotal) / 1000).toFixed(2)}s.`, {
		module: "cache",
		function: "refreshRealtimeCache",
	});
	await Promise.all(additionalPromises);
}

async function processWithProgress<T, U>(
	items: T[],
	taskName: string,
	processFn: (item: T) => U,
	chunkSize = 250,
): Promise<U[]> {
	const results: U[] = [];
	let current = 0;
	const total = items.length;
	const startTime = Date.now();

	if (total === 0) return results;

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
