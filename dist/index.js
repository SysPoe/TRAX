import * as cache from "./cache.js";
import * as calendar from "./utils/calendar.js";
import * as stations from "./utils/stations.js";
import * as express from "./utils/express.js";
import * as qrTravel from "./qr-travel/qr-travel-tracker.js";
import * as timeUtils from "./utils/time.js";
import { EventEmitter } from "events";
import { createGtfs, getGtfs, hasGtfs } from "./gtfsInterfaceLayer.js";
import logger from "./utils/logger.js";
import { TRAX_CONFIG } from "./config.js";
const traxEmitter = new EventEmitter();
let realtimeInterval = null;
let staticInterval = null;
export async function loadGTFS(autoRefresh = false, forceReload = false, realtimeIntervalMs = 60 * 1000, // 1 minute
staticIntervalMs = 24 * 60 * 60 * 1000) {
    await createGtfs();
    await cache.refreshStaticCache(true);
    await cache.refreshRealtimeCache();
    if (!autoRefresh)
        return;
    realtimeInterval = setInterval(() => {
        traxEmitter.emit("realtime-update-start");
        updateRealtime()
            .catch((err) => logger.error("Error refreshing realtime GTFS data", {
            module: "index",
            function: "loadGTFS",
            error: err.message || err,
        }))
            .finally(() => {
            traxEmitter.emit("realtime-update-complete");
        });
    }, realtimeIntervalMs);
    staticInterval = setInterval(async () => {
        traxEmitter.emit("static-update-start");
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
        finally {
            traxEmitter.emit("static-update-complete");
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
    const gtfs = getGtfs();
    try {
        await gtfs.updateRealtimeFromUrl(TRAX_CONFIG.realtimeAlerts, TRAX_CONFIG.realtimeTripUpdates, TRAX_CONFIG.realtimeVehiclePositions);
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
    on: traxEmitter.on.bind(traxEmitter),
    off: traxEmitter.off.bind(traxEmitter),
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
        getGtfs,
    },
    TRAX_CONFIG,
    logger,
};
export default TRAX;
export { Logger, LogLevel } from "./utils/logger.js"; // Export logger types
