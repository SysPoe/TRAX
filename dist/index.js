import * as cache from "./cache.js";
import * as calendar from "./utils/calendar.js";
import * as stations from "./utils/stations.js";
import * as express from "./utils/express.js";
import * as qrTravel from "./qr-travel/qr-travel-tracker.js";
import * as augmentedStopTime from "./utils/augmentedStopTime.js";
import * as timeUtils from "./utils/time.js";
import logger, { LogLevel } from "./utils/logger.js";
import { EventEmitter } from "events";
import { createGtfs, getGtfs, hasGtfs } from "./gtfsInterfaceLayer.js";
export const DEBUG = true;
const traxEmitter = new EventEmitter();
// Configure logger based on DEBUG flag
if (DEBUG) {
    logger.setLevel(LogLevel.DEBUG);
}
else {
    logger.setLevel(LogLevel.INFO);
}
export const TRAX_CONFIG = {
    url: "https://gtfsrt.api.translink.com.au/GTFS/SEQ_GTFS.zip",
    realtimeAlerts: "https://gtfsrt.api.translink.com.au/api/realtime/SEQ/alerts",
    realtimeTripUpdates: "https://gtfsrt.api.translink.com.au/api/realtime/SEQ/TripUpdates",
    realtimeVehiclePositions: "https://gtfsrt.api.translink.com.au/api/realtime/SEQ/VehiclePositions",
    sqlitePath: "./.TRAXCACHE.sqlite",
    verbose: DEBUG,
    db: undefined,
    logFunction: (message) => logger.debug(message, { module: "gtfs" }),
};
let realtimeInterval = null;
let staticInterval = null;
export async function loadGTFS(autoRefresh = false, forceReload = false, realtimeIntervalMs = 60 * 1000, // 1 minute
staticIntervalMs = 24 * 60 * 60 * 1000) {
    await createGtfs();
    if (!autoRefresh)
        return;
    realtimeInterval = setInterval(() => updateRealtime().catch((err) => logger.error("Error refreshing realtime GTFS data", {
        module: "index",
        function: "loadGTFS",
        error: err.message || err,
    })), realtimeIntervalMs);
    staticInterval = setInterval(async () => {
        try {
            await createGtfs();
            await cache.refreshStaticCache(true);
            await cache.refreshRealtimeCache();
        }
        catch (error) {
            logger.error("Error refreshing static GTFS data", {
                module: "index",
                function: "loadGTFS",
                error: error.message || error,
            });
        }
    }, staticIntervalMs);
}
export function clearIntervals() {
    if (realtimeInterval) {
        clearInterval(realtimeInterval);
        realtimeInterval = null;
    }
    if (staticInterval) {
        clearInterval(staticInterval);
        staticInterval = null;
    }
}
export function formatTimestamp(ts) {
    if (ts === null || ts === undefined)
        return "--:--";
    let h = Math.floor(ts / 3600);
    let m = Math.floor((ts % 3600) / 60);
    return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
}
export async function updateRealtime() {
    traxEmitter.emit("update-realtime-start");
    try {
        await gtfs.updateGtfsRealtime(config);
        await cache.refreshRealtimeCache();
    }
    catch (error) {
        logger.error("Error updating realtime GTFS data", {
            module: "index",
            function: "updateRealtime",
            error: error.message || error,
        });
        throw error;
    }
    finally {
        traxEmitter.emit("update-realtime-end");
    }
}
export function today() {
    return new Date(Date.now() + 3600 * 10 * 1000).toISOString().slice(0, 10).replace(/-/g, "");
}
const TRAX = {
    // Core functions
    loadGTFS,
    updateRealtime,
    clearIntervals,
    today,
    formatTimestamp,
    // Data access functions
    getAugmentedTrips: cache.getAugmentedTrips,
    getAugmentedStops: cache.getAugmentedStops,
    getAugmentedStopTimes: cache.getAugmentedStopTimes,
    getBaseStopTimes: cache.getBaseStopTimes,
    getRunSeries: cache.getRunSeries,
    getStations: stations.getStations,
    getRawTrips: cache.getRawTrips,
    getRawStops: cache.getRawStops,
    getRawRoutes: cache.getRawRoutes,
    getStopTimeUpdates: cache.getStopTimeUpdates,
    getTripUpdates: cache.getTripUpdates,
    getVehiclePositions: cache.getVehiclePositions,
    getQRTPlaces: cache.getQRTPlaces,
    getQRTTrains: cache.getQRTTrains,
    // Event handling
    on: (event, listener) => traxEmitter.on(event, listener),
    off: (event, listener) => traxEmitter.off(event, listener),
    // Namespaced modules
    cache,
    stations,
    calendar,
    express,
    qrTravel,
    // Utilities and config
    utils: {
        time: timeUtils,
        formatTimestamp,
        hasGtfs,
        getGtfs
    },
    TRAX_CONFIG,
    logger,
    ScheduleRelationship: augmentedStopTime.ScheduleRelationship,
};
export default TRAX;
export { Logger, LogLevel } from "./utils/logger.js"; // Export logger types
