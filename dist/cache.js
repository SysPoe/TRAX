import * as gtfs from "gtfs";
import { augmentStop } from "./utils/augmentedStop.js";
import { augmentTrip, calculateRunSeries } from "./utils/augmentedTrip.js";
import { DEBUG } from "./index.js";
import { getCurrentQRTravelTrains, getPlaces } from "./qr-travel/qr-travel-tracker.js";
let rawCache = {
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
    if (trip_id) {
        return (augmentedCache.stopTimes?.[trip_id] ?? []);
    }
    return Object.values(augmentedCache.stopTimes ?? {}).flat();
}
export function getBaseStopTimes(trip_id) {
    return (augmentedCache.baseStopTimes?.[trip_id] ?? []);
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
    if (!augmentedCache.runSeriesCache[date][runSeries] && calcIfNotFound && Object.keys(augmentedCache.serviceDateTrips[date]).find(v => v.endsWith(runSeries))) {
        calculateRunSeries(getAugmentedTrips(Object.keys(augmentedCache.serviceDateTrips[date]).find(v => v.endsWith(runSeries)))[0]);
    }
    else if (!augmentedCache.runSeriesCache[date][runSeries])
        augmentedCache.runSeriesCache[date][runSeries] = {
            trips: [],
            vehicle_sightings: [],
            series: runSeries.toUpperCase(),
            date
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
/**
 * Refresh static GTFS cache (stops, stopTimes).
 * @returns {Promise<void>}
 */
export async function refreshStaticCache() {
    if (DEBUG)
        console.log("Refreshing static GTFS cache...");
    // Reset data
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
    if (DEBUG)
        console.log("Loading QRT places...");
    rawCache.qrtPlaces = await getPlaces();
    if (DEBUG)
        console.log("Loaded", rawCache.qrtPlaces.length, "QRT places.");
    if (DEBUG)
        console.log("Loading stops...");
    rawCache.stops = gtfs.getStops();
    if (DEBUG)
        console.log("Loaded", rawCache.stops.length, "stops.");
    if (DEBUG)
        console.log("Loading routes...");
    rawCache.routes = gtfs.getRoutes();
    if (DEBUG)
        console.log("Loaded", rawCache.routes.length, "routes.");
    if (DEBUG)
        console.log("Loading trips...");
    rawCache.trips = gtfs.getTrips().filter((v) => v.trip_id.includes("-QR "));
    if (DEBUG)
        console.log("Loaded", rawCache.trips.length, "trips.");
    if (DEBUG)
        console.log("Building raw cache records...");
    rawCache.tripsRec = {};
    rawCache.stopsRec = {};
    rawCache.routesRec = {};
    for (const trip of rawCache.trips) {
        rawCache.tripsRec[trip.trip_id] = trip;
    }
    for (const stop of rawCache.stops) {
        rawCache.stopsRec[stop.stop_id] = stop;
    }
    for (const route of rawCache.routes) {
        rawCache.routesRec[route.route_id] = route;
    }
    if (DEBUG)
        console.log("Augmenting trips...");
    augmentedCache.trips = rawCache.trips.map(augmentTrip);
    if (DEBUG)
        console.log("Augmented", augmentedCache.trips.length, "trips.");
    if (DEBUG)
        console.log("Augmenting stops...");
    augmentedCache.stops = rawCache.stops.map(augmentStop);
    if (DEBUG)
        console.log("Augmented", augmentedCache.stops.length, "stops.");
    augmentedCache.tripsRec = {};
    augmentedCache.stopsRec = {};
    augmentedCache.serviceDateTrips = {};
    if (DEBUG)
        console.log("Building augmented cache records...");
    for (const trip of augmentedCache.trips) {
        if (!augmentedCache.stopTimes)
            augmentedCache.stopTimes = {};
        if (!augmentedCache.baseStopTimes)
            augmentedCache.baseStopTimes = {};
        augmentedCache.tripsRec[trip._trip.trip_id] = trip;
        // Store both current stop times and base stop times (without realtime)
        augmentedCache.stopTimes[trip._trip.trip_id] = trip.stopTimes;
        augmentedCache.baseStopTimes[trip._trip.trip_id] = [...trip.stopTimes]; // Deep copy for base
        for (const serviceDate of trip.actualTripDates) {
            if (!augmentedCache.serviceDateTrips[serviceDate]) {
                augmentedCache.serviceDateTrips[serviceDate] = [];
            }
            augmentedCache.serviceDateTrips[serviceDate].push(trip._trip.trip_id);
        }
    }
    for (const stop of augmentedCache.stops) {
        augmentedCache.stopsRec[stop.stop_id] = stop;
    }
    if (DEBUG)
        console.log("Done. Static GTFS cache refreshed.");
}
/**
 * Refresh realtime GTFS cache (stopTimeUpdates, tripUpdates, vehiclePositions).
 * @returns {Promise<void>}
 */
export async function refreshRealtimeCache() {
    if (DEBUG)
        console.log("Refreshing realtime GTFS cache...");
    // Reset realtime cache first
    rawCache.stopTimeUpdates = [];
    rawCache.tripUpdates = [];
    rawCache.vehiclePositions = [];
    rawCache.qrtTrains = [];
    if (DEBUG)
        console.log("Refreshing qrtTrains cache...");
    rawCache.qrtTrains = await getCurrentQRTravelTrains();
    if (DEBUG)
        console.log("Loaded", rawCache.qrtTrains.length, "QRT trains.");
    if (DEBUG)
        console.log("Loading stop time updates...");
    rawCache.stopTimeUpdates = gtfs.getStopTimeUpdates();
    if (DEBUG)
        console.log("Loaded", rawCache.stopTimeUpdates.length, "stop time updates.");
    if (DEBUG)
        console.log("Loading trip updates...");
    rawCache.tripUpdates = gtfs.getTripUpdates();
    if (DEBUG)
        console.log("Loaded", rawCache.tripUpdates.length, "trip updates.");
    if (DEBUG)
        console.log("Loading vehicle positions...");
    rawCache.vehiclePositions = gtfs.getVehiclePositions();
    if (DEBUG)
        console.log("Loaded", rawCache.vehiclePositions.length, "vehicle positions.");
    // if (DEBUG) console.log("Updating realtime data efficiently...");
    // updateRealtimeDataEfficiently();
    if (DEBUG)
        console.warn("Re-augmenting trips as efficient realtime updates are not implemented yet.");
    // Re-augment trips to apply realtime updates
    augmentedCache.trips = rawCache.trips.map(augmentTrip);
    if (DEBUG)
        console.log("Augmented", augmentedCache.trips.length, "trips.");
    if (DEBUG)
        console.log("Building augmented cache records...");
    augmentedCache.tripsRec = {};
    augmentedCache.serviceDateTrips = {};
    augmentedCache.baseStopTimes = {};
    augmentedCache.stopTimes = {};
    for (const trip of augmentedCache.trips) {
        if (!augmentedCache.stopTimes)
            augmentedCache.stopTimes = {};
        if (!augmentedCache.baseStopTimes)
            augmentedCache.baseStopTimes = {};
        augmentedCache.tripsRec[trip._trip.trip_id] = trip;
        // Store both current stop times and base stop times (without realtime)
        augmentedCache.stopTimes[trip._trip.trip_id] = trip.stopTimes;
        augmentedCache.baseStopTimes[trip._trip.trip_id] = [...trip.stopTimes]; // Deep copy for base
        for (const serviceDate of trip.actualTripDates) {
            if (!augmentedCache.serviceDateTrips[serviceDate]) {
                augmentedCache.serviceDateTrips[serviceDate] = [];
            }
            augmentedCache.serviceDateTrips[serviceDate].push(trip._trip.trip_id);
        }
    }
    if (DEBUG)
        console.log("Done. Realtime GTFS cache refreshed.");
}
