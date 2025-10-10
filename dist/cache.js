import * as gtfs from "gtfs";
import { Worker } from "worker_threads";
import { augmentStop, fromSerializableAugmentedStop } from "./utils/augmentedStop.js";
import { augmentTrip, calculateRunSeries, fromSerializableAugmentedTrip, } from "./utils/augmentedTrip.js";
import { fromSerializableAugmentedStopTime, } from "./utils/augmentedStopTime.js";
import { getCurrentQRTravelTrains, getPlaces } from "./qr-travel/qr-travel-tracker.js";
import logger from "./utils/logger.js";
let rawCache = {
    stopTimeUpdates: [],
    tripUpdates: [],
    vehiclePositions: [],
    stopTimes: [],
    calendars: [],
    calendarDates: [],
    trips: [],
    stops: [],
    routes: [],
    tripsRec: {},
    stopsRec: {},
    routesRec: {},
    qrtPlaces: [],
    qrtTrains: [],
};
let augmentedCache = {
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
let isRealtimeCachePrimed = false;
let realtimeRefreshPromise = null;
let activeRealtimeWorker = null;
const workerExecArgv = process.execArgv.some((arg) => arg.includes("tsx"))
    ? process.execArgv.slice()
    : [...process.execArgv, "--loader", "tsx"];
const clone = (value) => typeof globalThis.structuredClone === "function"
    ? globalThis.structuredClone(value)
    : JSON.parse(JSON.stringify(value));
function createCacheSnapshot() {
    const stopTimesSnapshot = {};
    for (const [tripId, stopTimes] of Object.entries(augmentedCache.stopTimes ?? {})) {
        stopTimesSnapshot[tripId] = stopTimes.map((st) => st.toSerializable());
    }
    const baseStopTimesSnapshot = {};
    for (const [tripId, stopTimes] of Object.entries(augmentedCache.baseStopTimes ?? {})) {
        baseStopTimesSnapshot[tripId] = stopTimes.map((st) => st.toSerializable());
    }
    const rawSnapshot = {
        stopTimeUpdates: clone(rawCache.stopTimeUpdates ?? []),
        tripUpdates: clone(rawCache.tripUpdates ?? []),
        vehiclePositions: clone(rawCache.vehiclePositions ?? []),
        stopTimes: clone(rawCache.stopTimes ?? []),
        calendars: clone(rawCache.calendars ?? []),
        calendarDates: clone(rawCache.calendarDates ?? []),
        trips: clone(rawCache.trips ?? []),
        stops: clone(rawCache.stops ?? []),
        routes: clone(rawCache.routes ?? []),
        qrtPlaces: clone(rawCache.qrtPlaces ?? []),
        qrtTrains: clone(rawCache.qrtTrains ?? []),
    };
    const augmentedSnapshot = {
        trips: augmentedCache.trips?.map((trip) => trip.toSerializable()) ?? [],
        stops: augmentedCache.stops?.map((stop) => stop.toSerializable()) ?? [],
        stopTimes: stopTimesSnapshot,
        baseStopTimes: baseStopTimesSnapshot,
        serviceDateTrips: clone(augmentedCache.serviceDateTrips ?? {}),
        expressInfoCache: clone(augmentedCache.expressInfoCache ?? {}),
        passingStopsCache: clone(augmentedCache.passingStopsCache ?? {}),
        runSeriesCache: clone(augmentedCache.runSeriesCache ?? {}),
    };
    return {
        raw: rawSnapshot,
        augmented: augmentedSnapshot,
    };
}
function hydrateCacheFromSnapshot(snapshot) {
    rawCache.stopTimeUpdates = snapshot.raw.stopTimeUpdates;
    rawCache.tripUpdates = snapshot.raw.tripUpdates;
    rawCache.vehiclePositions = snapshot.raw.vehiclePositions;
    rawCache.stopTimes = snapshot.raw.stopTimes;
    rawCache.calendars = snapshot.raw.calendars;
    rawCache.calendarDates = snapshot.raw.calendarDates;
    rawCache.trips = snapshot.raw.trips;
    rawCache.stops = snapshot.raw.stops;
    rawCache.routes = snapshot.raw.routes;
    rawCache.qrtPlaces = snapshot.raw.qrtPlaces;
    rawCache.qrtTrains = snapshot.raw.qrtTrains;
    rawCache.tripsRec = {};
    for (const trip of rawCache.trips)
        rawCache.tripsRec[trip.trip_id] = trip;
    rawCache.stopsRec = {};
    for (const stop of rawCache.stops)
        rawCache.stopsRec[stop.stop_id] = stop;
    rawCache.routesRec = {};
    for (const route of rawCache.routes)
        rawCache.routesRec[route.route_id] = route;
    const stopsRec = {};
    const resolveStop = (stopId) => (stopId ? stopsRec[stopId] ?? null : null);
    const hydratedStops = [];
    for (const serializedStop of snapshot.augmented.stops) {
        const stop = fromSerializableAugmentedStop(serializedStop, resolveStop);
        stopsRec[stop.stop_id] = stop;
        hydratedStops.push(stop);
    }
    const stopTimes = {};
    for (const [tripId, stopTimesList] of Object.entries(snapshot.augmented.stopTimes)) {
        stopTimes[tripId] = stopTimesList.map((st) => fromSerializableAugmentedStopTime(st, resolveStop));
    }
    const baseStopTimes = {};
    for (const [tripId, stopTimesList] of Object.entries(snapshot.augmented.baseStopTimes)) {
        baseStopTimes[tripId] = stopTimesList.map((st) => fromSerializableAugmentedStopTime(st, resolveStop));
    }
    const trips = [];
    const tripsRec = {};
    for (const serializedTrip of snapshot.augmented.trips) {
        const tripStopTimes = stopTimes[serializedTrip._trip.trip_id] ?? [];
        const trip = fromSerializableAugmentedTrip(serializedTrip, tripStopTimes);
        trips.push(trip);
        tripsRec[trip._trip.trip_id] = trip;
    }
    augmentedCache.trips = trips;
    augmentedCache.stops = hydratedStops;
    augmentedCache.stopTimes = stopTimes;
    augmentedCache.baseStopTimes = baseStopTimes;
    augmentedCache.tripsRec = tripsRec;
    augmentedCache.stopsRec = stopsRec;
    augmentedCache.serviceDateTrips = clone(snapshot.augmented.serviceDateTrips ?? {});
    augmentedCache.expressInfoCache = clone(snapshot.augmented.expressInfoCache ?? {});
    augmentedCache.passingStopsCache = clone(snapshot.augmented.passingStopsCache ?? {});
    augmentedCache.runSeriesCache = clone(snapshot.augmented.runSeriesCache ?? {});
}
async function ensureStaticDataLoaded() {
    if (!rawCache.qrtPlaces || rawCache.qrtPlaces.length === 0)
        rawCache.qrtPlaces = await getPlaces();
    if (!rawCache.stops || rawCache.stops.length === 0) {
        rawCache.stops = gtfs.getStops();
        rawCache.stopsRec = {};
        for (const stop of rawCache.stops)
            rawCache.stopsRec[stop.stop_id] = stop;
    }
    if (!rawCache.routes || rawCache.routes.length === 0) {
        rawCache.routes = gtfs.getRoutes();
        rawCache.routesRec = {};
        for (const route of rawCache.routes)
            rawCache.routesRec[route.route_id] = route;
    }
    if (!rawCache.trips || rawCache.trips.length === 0) {
        rawCache.trips = gtfs.getTrips().filter((v) => v.trip_id.includes("-QR "));
        rawCache.tripsRec = {};
        for (const trip of rawCache.trips)
            rawCache.tripsRec[trip.trip_id] = trip;
    }
    if (!rawCache.stopTimes || rawCache.stopTimes.length === 0)
        rawCache.stopTimes = gtfs.getStoptimes();
    if (!rawCache.calendars || rawCache.calendars.length === 0)
        rawCache.calendars = gtfs.getCalendars();
    if (!rawCache.calendarDates || rawCache.calendarDates.length === 0)
        rawCache.calendarDates = gtfs.getCalendarDates();
    if (!augmentedCache.stops || augmentedCache.stops.length === 0) {
        augmentedCache.stopsRec = {};
        augmentedCache.stops = rawCache.stops.map((stop) => {
            const augmentedStop = augmentStop(stop);
            augmentedCache.stopsRec[stop.stop_id] = augmentedStop;
            return augmentedStop;
        });
    }
}
export function getCalendars(filter) {
    if (!rawCache.calendars || rawCache.calendars.length === 0)
        rawCache.calendars = gtfs.getCalendars();
    if (!filter)
        return rawCache.calendars;
    // simple filter implementation
    return rawCache.calendars.filter((c) => {
        for (const key of Object.keys(filter)) {
            // @ts-ignore
            if (c[key] !== filter[key])
                return false;
        }
        return true;
    });
}
export function getCalendarDates(filter) {
    if (!rawCache.calendarDates || rawCache.calendarDates.length === 0)
        rawCache.calendarDates = gtfs.getCalendarDates();
    if (!filter)
        return rawCache.calendarDates;
    return rawCache.calendarDates.filter((c) => {
        for (const key of Object.keys(filter)) {
            // @ts-ignore
            if (c[key] !== filter[key])
                return false;
        }
        return true;
    });
}
export function getRawTrips(trip_id) {
    if (trip_id)
        return rawCache.tripsRec[trip_id] ? [rawCache.tripsRec[trip_id]] : [];
    return rawCache.trips;
}
export function getRawStops(stop_id) {
    if (stop_id)
        return rawCache.stopsRec[stop_id] ? [rawCache.stopsRec[stop_id]] : [];
    return rawCache.stops;
}
export function getRawRoutes(route_id) {
    if (route_id)
        return rawCache.routesRec[route_id] ? [rawCache.routesRec[route_id]] : [];
    return rawCache.routes;
}
export function getStopTimeUpdates() {
    if (rawCache.stopTimeUpdates.length === 0)
        rawCache.stopTimeUpdates = gtfs.getStopTimeUpdates();
    return rawCache.stopTimeUpdates;
}
export function getTripUpdates() {
    if (rawCache.tripUpdates.length === 0)
        rawCache.tripUpdates = gtfs.getTripUpdates();
    return rawCache.tripUpdates;
}
export function getVehiclePositions() {
    if (rawCache.vehiclePositions.length === 0)
        rawCache.vehiclePositions = gtfs.getVehiclePositions();
    return rawCache.vehiclePositions;
}
export function getQRTPlaces() {
    return rawCache.qrtPlaces;
}
export function getQRTTrains() {
    return rawCache.qrtTrains;
}
/**
 * Retrieve stopTimes, optionally filtered by trip id, lazily loading from GTFS.
 */
export function getRawStopTimes(trip_id) {
    if (trip_id)
        return gtfs.getStoptimes({ trip_id });
    return gtfs.getStoptimes();
}
export function getAugmentedTrips(trip_id) {
    if (trip_id) {
        if (augmentedCache.tripsRec && augmentedCache.tripsRec[trip_id])
            return [augmentedCache.tripsRec[trip_id]];
        if (rawCache.tripsRec[trip_id]) {
            const trip = rawCache.tripsRec[trip_id];
            const augmentedTrip = augmentTrip(trip);
            if (!augmentedCache.tripsRec)
                augmentedCache.tripsRec = {};
            augmentedCache.tripsRec[trip_id] = augmentedTrip;
            return [augmentedTrip];
        }
        return [];
    }
    return augmentedCache.trips ?? [];
}
export function getAugmentedStops(stop_id) {
    if (stop_id) {
        if (augmentedCache.stopsRec && augmentedCache.stopsRec[stop_id])
            return [augmentedCache.stopsRec[stop_id]];
        if (rawCache.stopsRec[stop_id]) {
            const stop = rawCache.stopsRec[stop_id];
            const augmentedStop = augmentStop(stop);
            if (!augmentedCache.stopsRec)
                augmentedCache.stopsRec = {};
            augmentedCache.stopsRec[stop_id] = augmentedStop;
            return [augmentedStop];
        }
        return [];
    }
    return augmentedCache.stops ?? [];
}
export function getAugmentedStopTimes(trip_id) {
    if (trip_id)
        return augmentedCache.stopTimes?.[trip_id] ?? [];
    return Object.values(augmentedCache.stopTimes ?? {}).flat();
}
export function getBaseStopTimes(trip_id) {
    return augmentedCache.baseStopTimes?.[trip_id] ?? [];
}
export function cacheExpressInfo(stopListHash, expressInfo) {
    if (!augmentedCache.expressInfoCache)
        augmentedCache.expressInfoCache = {};
    augmentedCache.expressInfoCache[stopListHash] = expressInfo;
}
export function getCachedExpressInfo(stopListHash) {
    return augmentedCache.expressInfoCache?.[stopListHash];
}
export function cachePassingStops(stopListHash, passingStops) {
    if (!augmentedCache.passingStopsCache)
        augmentedCache.passingStopsCache = {};
    augmentedCache.passingStopsCache[stopListHash] = passingStops;
}
export function getCachedPassingStops(stopListHash) {
    return augmentedCache.passingStopsCache?.[stopListHash];
}
export function getRunSeries(date, runSeries, calcIfNotFound = true) {
    if (!augmentedCache.runSeriesCache)
        augmentedCache.runSeriesCache = {};
    if (!augmentedCache.runSeriesCache[date])
        augmentedCache.runSeriesCache[date] = {};
    const serviceTrips = augmentedCache.serviceDateTrips?.[date] ?? [];
    if (!augmentedCache.runSeriesCache[date][runSeries] &&
        calcIfNotFound &&
        serviceTrips.find((v) => v.endsWith(runSeries))) {
        const targetTripId = serviceTrips.find((v) => v.endsWith(runSeries));
        if (targetTripId)
            calculateRunSeries(getAugmentedTrips(targetTripId)[0]);
    }
    else if (!augmentedCache.runSeriesCache[date][runSeries])
        augmentedCache.runSeriesCache[date][runSeries] = {
            trips: [],
            vehicle_sightings: [],
            series: runSeries.toUpperCase(),
            date,
        };
    return augmentedCache.runSeriesCache?.[date]?.[runSeries];
}
export function setRunSeries(date, runSeries, data) {
    if (!augmentedCache.runSeriesCache)
        augmentedCache.runSeriesCache = {};
    if (!augmentedCache.runSeriesCache[date])
        augmentedCache.runSeriesCache[date] = {};
    augmentedCache.runSeriesCache[date][runSeries] = data;
}
function resetStaticCache() {
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
function resetRealtimeCache() {
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
export async function buildRealtimeCacheSnapshot() {
    logger.debug("Refreshing realtime GTFS cache (snapshot)...", {
        module: "cache",
        function: "buildRealtimeCacheSnapshot",
    });
    resetRealtimeCache();
    await ensureStaticDataLoaded();
    logger.debug("Refreshing qrtTrains cache...", {
        module: "cache",
        function: "buildRealtimeCacheSnapshot",
    });
    rawCache.qrtTrains = await getCurrentQRTravelTrains();
    logger.debug(`Loaded ${rawCache.qrtTrains.length} QRT trains.`, {
        module: "cache",
        function: "buildRealtimeCacheSnapshot",
    });
    logger.debug("Loading realtime updates...", {
        module: "cache",
        function: "buildRealtimeCacheSnapshot",
    });
    rawCache.stopTimeUpdates = gtfs.getStopTimeUpdates();
    rawCache.tripUpdates = gtfs.getTripUpdates();
    rawCache.vehiclePositions = gtfs.getVehiclePositions();
    logger.debug(`Loaded ${rawCache.stopTimeUpdates.length} stop time updates.`, {
        module: "cache",
        function: "buildRealtimeCacheSnapshot",
    });
    logger.debug(`Loaded ${rawCache.tripUpdates.length} trip updates.`, {
        module: "cache",
        function: "buildRealtimeCacheSnapshot",
    });
    logger.debug(`Loaded ${rawCache.vehiclePositions.length} vehicle positions.`, {
        module: "cache",
        function: "buildRealtimeCacheSnapshot",
    });
    logger.warn("Re-augmenting trips as efficient realtime updates are not implemented yet.", {
        module: "cache",
        function: "buildRealtimeCacheSnapshot",
    });
    augmentedCache.trips = rawCache.trips.map(augmentTrip);
    logger.debug(`Augmented ${augmentedCache.trips.length} trips.`, {
        module: "cache",
        function: "buildRealtimeCacheSnapshot",
    });
    logger.debug("Building augmented cache records...", {
        module: "cache",
        function: "buildRealtimeCacheSnapshot",
    });
    for (const trip of augmentedCache.trips) {
        augmentedCache.tripsRec[trip._trip.trip_id] = trip;
        augmentedCache.stopTimes[trip._trip.trip_id] = trip.stopTimes;
        augmentedCache.baseStopTimes[trip._trip.trip_id] = [...trip.stopTimes];
        for (const serviceDate of trip.actualTripDates) {
            if (!augmentedCache.serviceDateTrips[serviceDate])
                augmentedCache.serviceDateTrips[serviceDate] = [];
            if (!augmentedCache.serviceDateTrips[serviceDate].includes(trip._trip.trip_id))
                augmentedCache.serviceDateTrips[serviceDate].push(trip._trip.trip_id);
        }
    }
    logger.info("Realtime GTFS cache snapshot built.", {
        module: "cache",
        function: "buildRealtimeCacheSnapshot",
    });
    return createCacheSnapshot();
}
export async function refreshStaticCache(_skipRealtimeOverlap = false) {
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
    for (const trip of rawCache.trips)
        rawCache.tripsRec[trip.trip_id] = trip;
    for (const stop of rawCache.stops)
        rawCache.stopsRec[stop.stop_id] = stop;
    for (const route of rawCache.routes)
        rawCache.routesRec[route.route_id] = route;
    logger.debug("Augmenting trips...", {
        module: "cache",
        function: "refreshStaticCache",
    });
    augmentedCache.trips = rawCache.trips.map(augmentTrip);
    logger.debug(`Augmented ${augmentedCache.trips.length} trips.`, {
        module: "cache",
        function: "refreshStaticCache",
    });
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
        augmentedCache.tripsRec[trip._trip.trip_id] = trip;
        // Store both current stop times and base stop times (without realtime)
        augmentedCache.stopTimes[trip._trip.trip_id] = trip.stopTimes;
        augmentedCache.baseStopTimes[trip._trip.trip_id] = [...trip.stopTimes]; // Deep copy for base
        for (const serviceDate of trip.actualTripDates) {
            if (!augmentedCache.serviceDateTrips[serviceDate])
                augmentedCache.serviceDateTrips[serviceDate] = [];
            if (!augmentedCache.serviceDateTrips[serviceDate].includes(trip._trip.trip_id))
                augmentedCache.serviceDateTrips[serviceDate].push(trip._trip.trip_id);
        }
    }
    for (const stop of augmentedCache.stops)
        augmentedCache.stopsRec[stop.stop_id] = stop;
    logger.info("Static GTFS cache refreshed.", {
        module: "cache",
        function: "refreshStaticCache",
    });
}
export async function refreshRealtimeCache() {
    if (!isRealtimeCachePrimed) {
        const snapshot = await buildRealtimeCacheSnapshot();
        hydrateCacheFromSnapshot(snapshot);
        isRealtimeCachePrimed = true;
        return;
    }
    if (realtimeRefreshPromise)
        return realtimeRefreshPromise;
    realtimeRefreshPromise = new Promise((resolve, reject) => {
        const worker = new Worker(new URL("./workers/realtimeCacheWorker.ts", import.meta.url), {
            execArgv: workerExecArgv,
        });
        activeRealtimeWorker = worker;
        let settled = false;
        worker.on("message", (message) => {
            if (settled)
                return;
            if (message.type === "result") {
                hydrateCacheFromSnapshot(message.snapshot);
                isRealtimeCachePrimed = true;
                settled = true;
                resolve();
            }
            else {
                logger.error("Realtime cache worker reported an error", {
                    module: "cache",
                    function: "refreshRealtimeCache",
                    error: message.error?.message ?? message.error,
                });
                settled = true;
                reject(new Error(message.error?.message ?? message.error ?? "Unknown worker error"));
            }
        });
        worker.on("error", (error) => {
            if (settled)
                return;
            settled = true;
            reject(error);
        });
        worker.on("exit", (code) => {
            if (activeRealtimeWorker === worker)
                activeRealtimeWorker = null;
            if (settled)
                return;
            settled = true;
            if (code === 0)
                resolve();
            else
                reject(new Error(`Realtime cache worker exited with code ${code}`));
        });
        worker.postMessage({ type: "refresh" });
    });
    try {
        await realtimeRefreshPromise;
    }
    finally {
        realtimeRefreshPromise = null;
        activeRealtimeWorker = null;
    }
}
