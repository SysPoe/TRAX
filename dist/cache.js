import * as gtfs from "gtfs";
import { augmentStop } from "./utils/augmentedStop.js";
import { augmentTrip, calculateRunSeries } from "./utils/augmentedTrip.js";
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
    tripsRec: new Map(),
    stopsRec: new Map(),
    routesRec: new Map(),
    qrtPlaces: [],
    qrtTrains: [],
};
let augmentedCache = {
    trips: [],
    stops: [],
    stopTimes: {},
    baseStopTimes: {},
    tripsRec: new Map(),
    stopsRec: new Map(),
    serviceDateTrips: new Map(),
    expressInfoCache: new Map(),
    passingStopsCache: new Map(),
    runSeriesCache: new Map(),
};
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
    if (trip_id) {
        const trip = rawCache.tripsRec.get(trip_id);
        return trip ? [trip] : [];
    }
    return rawCache.trips;
}
export function getRawStops(stop_id) {
    if (stop_id) {
        const stop = rawCache.stopsRec.get(stop_id);
        return stop ? [stop] : [];
    }
    return rawCache.stops;
}
export function getRawRoutes(route_id) {
    if (route_id) {
        const route = rawCache.routesRec.get(route_id);
        return route ? [route] : [];
    }
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
        const trip = augmentedCache.tripsRec.get(trip_id);
        if (trip)
            return [trip];
        const rawTrip = rawCache.tripsRec.get(trip_id);
        if (rawTrip) {
            const augmentedTrip = augmentTrip(rawTrip);
            augmentedCache.tripsRec.set(trip_id, augmentedTrip);
            return [augmentedTrip];
        }
        return [];
    }
    return augmentedCache.trips ?? [];
}
export function getAugmentedStops(stop_id) {
    if (stop_id) {
        const stop = augmentedCache.stopsRec.get(stop_id);
        if (stop)
            return [stop];
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
export function getAugmentedStopTimes(trip_id) {
    if (trip_id)
        return augmentedCache.stopTimes?.[trip_id] ?? [];
    return Object.values(augmentedCache.stopTimes ?? {}).flat();
}
export function getBaseStopTimes(trip_id) {
    return augmentedCache.baseStopTimes?.[trip_id] ?? [];
}
export function cacheExpressInfo(stopListHash, expressInfo) {
    augmentedCache.expressInfoCache.set(stopListHash, expressInfo);
}
export function getCachedExpressInfo(stopListHash) {
    return augmentedCache.expressInfoCache.get(stopListHash);
}
export function cachePassingStops(stopListHash, passingStops) {
    augmentedCache.passingStopsCache.set(stopListHash, passingStops);
}
export function getCachedPassingStops(stopListHash) {
    return augmentedCache.passingStopsCache.get(stopListHash);
}
export function getRunSeries(date, runSeries, calcIfNotFound = true) {
    let dateMap = augmentedCache.runSeriesCache.get(date);
    if (!dateMap) {
        dateMap = new Map();
        augmentedCache.runSeriesCache.set(date, dateMap);
    }
    if (!dateMap.get(runSeries) &&
        calcIfNotFound &&
        augmentedCache.serviceDateTrips.get(date)?.find((v) => v.endsWith(runSeries))) {
        calculateRunSeries(getAugmentedTrips(augmentedCache.serviceDateTrips.get(date)?.find((v) => v.endsWith(runSeries)))[0]);
    }
    else if (!dateMap.get(runSeries))
        dateMap.set(runSeries, {
            trips: [],
            vehicle_sightings: [],
            series: runSeries.toUpperCase(),
            date,
        });
    return dateMap.get(runSeries);
}
export function setRunSeries(date, runSeries, data) {
    let dateMap = augmentedCache.runSeriesCache.get(date);
    if (!dateMap) {
        dateMap = new Map();
        augmentedCache.runSeriesCache.set(date, dateMap);
    }
    dateMap.set(runSeries, data);
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
        expressInfoCache: new Map(),
        passingStopsCache: new Map(),
        runSeriesCache: new Map(),
    };
}
function resetRealtimeCache() {
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
export async function refreshStaticCache(skipRealtimeOverlap = false) {
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
        rawCache.tripsRec.set(trip.trip_id, trip);
    for (const stop of rawCache.stops)
        rawCache.stopsRec.set(stop.stop_id, stop);
    for (const route of rawCache.routes)
        rawCache.routesRec.set(route.route_id, route);
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
    for (const stop of augmentedCache.stops)
        augmentedCache.stopsRec.set(stop.stop_id, stop);
    logger.info("Static GTFS cache refreshed.", {
        module: "cache",
        function: "refreshStaticCache",
    });
}
export async function refreshRealtimeCache() {
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
    logger.info("Realtime GTFS cache refreshed.", {
        module: "cache",
        function: "refreshRealtimeCache",
    });
}
