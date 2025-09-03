import * as gtfs from "gtfs";
import { AugmentedStop, augmentStop } from "./utils/augmentedStop.js";
import { AugmentedTrip, augmentTrip } from "./utils/augmentedTrip.js";
import { AugmentedStopTime } from "./utils/augmentedStopTime.js";
import { DEBUG, QRTPlace, TravelTrip } from "./index.js";
import { getCurrentQRTravelTrains, getPlaces } from "./qr-travel/qr-travel-tracker.js";

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
    trips?: AugmentedTrip[];
    stops?: AugmentedStop[];

    stopTimes?: { [trip_id: string]: AugmentedStopTime[] };
    baseStopTimes?: { [trip_id: string]: AugmentedStopTime[] }; // Cached base stop times without realtime
    tripsRec?: { [trip_id: string]: AugmentedTrip };
    stopsRec?: { [stop_id: string]: AugmentedStop };

    serviceDateTrips?: { [service_date: number]: string[] }; // Maps serviceDate to trip IDs

    // Performance caches
    expressInfoCache?: { [stopListHash: string]: any[] };
    passingStopsCache?: { [stopListHash: string]: any[] };
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
};

export function getRawTrips(trip_id?: string): gtfs.Trip[] {
    if (trip_id)
        return rawCache.tripsRec[trip_id] ? [rawCache.tripsRec[trip_id]] : [];
    return rawCache.trips;
}

export function getRawStops(stop_id?: string): gtfs.Stop[] {
    if (stop_id)
        return rawCache.stopsRec[stop_id] ? [rawCache.stopsRec[stop_id]] : [];
    return rawCache.stops;
}

export function getRawRoutes(route_id?: string): gtfs.Route[] {
    if (route_id)
        return rawCache.routesRec[route_id] ? [rawCache.routesRec[route_id]] : [];
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
    if (trip_id)
        return gtfs.getStoptimes({ trip_id });
    return gtfs.getStoptimes();
}

export function getAugmentedTrips(trip_id?: string): AugmentedTrip[] {
    if (trip_id) {
        if (augmentedCache.tripsRec && augmentedCache.tripsRec[trip_id])
            return [augmentedCache.tripsRec[trip_id]!];
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
        if (augmentedCache.stopsRec && augmentedCache.stopsRec[stop_id])
            return [augmentedCache.stopsRec[stop_id]!];
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
    if (trip_id) {
        return (augmentedCache.stopTimes?.[trip_id] ?? []);
    }
    return Object.values(augmentedCache.stopTimes ?? {}).flat();
}

export function getBaseStopTimes(trip_id: string): AugmentedStopTime[] {
    return (augmentedCache.baseStopTimes?.[trip_id] ?? []);
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

/**
 * Refresh static GTFS cache (stops, stopTimes).
 * @returns {Promise<void>}
 */
export async function refreshStaticCache(): Promise<void> {
    if (DEBUG) console.log("Refreshing static GTFS cache...");

    if (DEBUG) console.log("Loading QRT places...");
    rawCache.qrtPlaces = await getPlaces();
    if (DEBUG) console.log("Loaded", rawCache.qrtPlaces.length, "QRT places.");

    if (DEBUG) console.log("Loading stops...");
    rawCache.stops = gtfs.getStops();
    if (DEBUG) console.log("Loaded", rawCache.stops.length, "stops.");
    if (DEBUG) console.log("Loading routes...");
    rawCache.routes = gtfs.getRoutes();
    if (DEBUG) console.log("Loaded", rawCache.routes.length, "routes.");
    if (DEBUG) console.log("Loading trips...");
    rawCache.trips = gtfs.getTrips().filter((v) => v.trip_id.includes("-QR "));
    if (DEBUG) console.log("Loaded", rawCache.trips.length, "trips.");
    if (DEBUG) console.log("Building raw cache records...");
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

    if (DEBUG) console.log("Augmenting trips...");
    augmentedCache.trips = rawCache.trips.map(augmentTrip);
    if (DEBUG) console.log("Augmented", augmentedCache.trips.length, "trips.");
    if (DEBUG) console.log("Augmenting stops...");
    augmentedCache.stops = rawCache.stops.map(augmentStop);
    if (DEBUG) console.log("Augmented", augmentedCache.stops.length, "stops.");
    augmentedCache.tripsRec = {};
    augmentedCache.stopsRec = {};
    augmentedCache.serviceDateTrips = {};

    if (DEBUG) console.log("Building augmented cache records...");
    for (const trip of augmentedCache.trips) {
        if (!augmentedCache.stopTimes) augmentedCache.stopTimes = {};
        if (!augmentedCache.baseStopTimes) augmentedCache.baseStopTimes = {};
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

    if (DEBUG) console.log("Done. Static GTFS cache refreshed.");
}

/**
 * Refresh realtime GTFS cache (stopTimeUpdates, tripUpdates, vehiclePositions).
 * @returns {Promise<void>}
 */
export async function refreshRealtimeCache(): Promise<void> {
    if (DEBUG) console.log("Refreshing realtime GTFS cache...");
    // Reset realtime cache first
    rawCache.stopTimeUpdates = [];
    rawCache.tripUpdates = [];
    rawCache.vehiclePositions = [];
    rawCache.qrtTrains = [];

    if (DEBUG) console.log("Refreshing qrtTrains cache...");
    rawCache.qrtTrains = await getCurrentQRTravelTrains();
    if (DEBUG) console.log("Loaded", rawCache.qrtTrains.length, "QRT trains.");
    if (DEBUG) console.log("Loading stop time updates...");
    rawCache.stopTimeUpdates = gtfs.getStopTimeUpdates();
    if (DEBUG) console.log("Loaded", rawCache.stopTimeUpdates.length, "stop time updates.");
    if (DEBUG) console.log("Loading trip updates...");
    rawCache.tripUpdates = gtfs.getTripUpdates();
    if (DEBUG) console.log("Loaded", rawCache.tripUpdates.length, "trip updates.");
    if (DEBUG) console.log("Loading vehicle positions...");
    rawCache.vehiclePositions = gtfs.getVehiclePositions();
    if (DEBUG) console.log("Loaded", rawCache.vehiclePositions.length, "vehicle positions.");
    // if (DEBUG) console.log("Updating realtime data efficiently...");
    // updateRealtimeDataEfficiently();

    if (DEBUG) console.warn("Re-augmenting trips as efficient realtime updates are not implemented yet.");
    // Re-augment trips to apply realtime updates
    augmentedCache.trips = rawCache.trips.map(augmentTrip);
    if (DEBUG) console.log("Augmented", augmentedCache.trips.length, "trips.");
    if (DEBUG) console.log("Building augmented cache records...");
    augmentedCache.tripsRec = {};
    augmentedCache.serviceDateTrips = {};
    augmentedCache.baseStopTimes = {};
    augmentedCache.stopTimes = {};

    for (const trip of augmentedCache.trips) {
        if (!augmentedCache.stopTimes) augmentedCache.stopTimes = {};
        if (!augmentedCache.baseStopTimes) augmentedCache.baseStopTimes = {};
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
    if (DEBUG) console.log("Done. Realtime GTFS cache refreshed.");
}