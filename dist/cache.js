import * as gtfs from "gtfs";
import { augmentStop } from "./utils/augmentedStop.js";
import { augmentTrip } from "./utils/augmentedTrip.js";
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
/**
 * Refresh static GTFS cache (stops, stopTimes).
 * @returns {Promise<void>}
 */
export async function refreshStaticCache() {
    if (DEBUG)
        console.log("Refreshing static GTFS cache...");
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
        for (const serviceDate of trip.serviceDates) {
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
    for (const trip of augmentedCache.trips) {
        augmentedCache.tripsRec[trip._trip.trip_id] = trip;
    }
    if (DEBUG)
        console.log("Done. Realtime GTFS cache refreshed.");
}
/**
 * Efficiently update only the realtime portions of stop times without recalculating everything
 */
function updateRealtimeDataEfficiently() {
    if (!augmentedCache.stopTimes || !augmentedCache.baseStopTimes)
        return;
    // Group stop time updates by trip for efficient processing
    const updatesByTrip = new Map();
    for (const update of rawCache.stopTimeUpdates) {
        if (!update.trip_id)
            continue; // Skip updates without trip_id
        if (!updatesByTrip.has(update.trip_id)) {
            updatesByTrip.set(update.trip_id, []);
        }
        updatesByTrip.get(update.trip_id).push(update);
    }
    // Only update trips that have realtime updates
    for (const [tripId, updates] of updatesByTrip) {
        if (augmentedCache.baseStopTimes[tripId]) {
            augmentedCache.stopTimes[tripId] = applyRealtimeUpdates(augmentedCache.baseStopTimes[tripId], updates);
        }
    }
}
/**
 * Clear performance caches to free memory
 */
export function clearPerformanceCaches() {
    augmentedCache.expressInfoCache = {};
    augmentedCache.passingStopsCache = {};
}
/**
 * Batch process trips for better performance during initial load
 */
export function batchProcessTrips(tripIds) {
    if (DEBUG)
        console.log(`Batch processing ${tripIds.length} trips...`);
    for (const tripId of tripIds) {
        if (!augmentedCache.tripsRec?.[tripId])
            continue;
        const trip = augmentedCache.tripsRec[tripId];
        // Pre-calculate stop times during batch processing
        const stopTimes = trip.stopTimes;
        if (!augmentedCache.stopTimes)
            augmentedCache.stopTimes = {};
        if (!augmentedCache.baseStopTimes)
            augmentedCache.baseStopTimes = {};
        augmentedCache.stopTimes[tripId] = stopTimes;
        augmentedCache.baseStopTimes[tripId] = [...stopTimes];
    }
    if (DEBUG)
        console.log(`Batch processing completed for ${tripIds.length} trips.`);
}
function applyRealtimeUpdates(baseStopTimes, updates) {
    // Create a map of updates by stop for fast lookup
    const updatesByStop = new Map();
    for (const update of updates) {
        if (update.stop_id) {
            updatesByStop.set(update.stop_id, update);
        }
    }
    // Clone base stop times and apply realtime updates
    return baseStopTimes.map(baseStopTime => {
        const stopId = baseStopTime.actual_stop?.stop_id || baseStopTime.scheduled_stop?.stop_id;
        if (!stopId)
            return baseStopTime;
        const update = updatesByStop.get(stopId);
        if (!update)
            return baseStopTime; // No update for this stop
        // Create updated stop time with minimal changes
        const updatedStopTime = { ...baseStopTime };
        // Apply delay updates
        if (update.departure_delay !== undefined) {
            updatedStopTime.actual_departure_timestamp =
                (baseStopTime.scheduled_departure_timestamp ?? 0) + update.departure_delay;
            updatedStopTime.rt_departure_updated = true;
        }
        if (update.arrival_delay !== undefined) {
            updatedStopTime.actual_arrival_timestamp =
                (baseStopTime.scheduled_arrival_timestamp ?? 0) + update.arrival_delay;
            updatedStopTime.rt_arrival_updated = true;
        }
        // Update realtime info
        if (update.departure_delay !== undefined || update.arrival_delay !== undefined) {
            const delaySecs = update.departure_delay ?? update.arrival_delay ?? 0;
            updatedStopTime.realtime = true;
            updatedStopTime.realtime_info = {
                delay_secs: delaySecs,
                delay_string: delaySecs === 0 ? "on time" :
                    delaySecs > 0 ? `${Math.round(delaySecs / 60)}m late` :
                        `${Math.round(Math.abs(delaySecs) / 60)}m early`,
                delay_class: delaySecs === 0 ? "on-time" :
                    delaySecs > 300 ? "very-late" :
                        delaySecs > 0 ? "late" : "early",
                schedule_relationship: baseStopTime.realtime_info?.schedule_relationship ?? 0,
                propagated: false
            };
        }
        return updatedStopTime;
    });
}
