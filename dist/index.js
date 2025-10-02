import * as gtfs from "gtfs";
import fs from "fs";
import * as cache from "./cache.js";
import * as calendar from "./utils/calendar.js";
import * as stations from "./stations.js";
import * as express from "./utils/express.js";
import * as qrTravel from "./qr-travel/qr-travel-tracker.js";
import * as augmentedStopTime from "./utils/augmentedStopTime.js";
import logger, { LogLevel } from "./utils/logger.js";
export const DEBUG = true;
// Configure logger based on DEBUG flag
if (DEBUG) {
    logger.setLevel(LogLevel.DEBUG);
}
else {
    logger.setLevel(LogLevel.INFO);
}
let config = {
    agencies: [
        {
            url: "https://gtfsrt.api.translink.com.au/GTFS/SEQ_GTFS.zip",
            realtimeAlerts: {
                url: "https://gtfsrt.api.translink.com.au/api/realtime/SEQ/alerts",
            },
            realtimeTripUpdates: {
                url: "https://gtfsrt.api.translink.com.au/api/realtime/SEQ/TripUpdates",
            },
            realtimeVehiclePositions: {
                url: "https://gtfsrt.api.translink.com.au/api/realtime/SEQ/VehiclePositions",
            },
        },
    ],
    sqlitePath: "./.TRAXCACHE.sqlite",
    verbose: DEBUG,
    db: undefined,
    logFunction: (message) => logger.debug(message, { module: "gtfs" }),
};
let realtimeInterval = null;
let staticInterval = null;
export async function loadGTFS(autoRefresh = false, forceReload = false, realtimeIntervalMs = 60 * 1000, // 1 minute
staticIntervalMs = 24 * 60 * 60 * 1000) {
    const dbExists = fs.existsSync(config.sqlitePath);
    if (!dbExists || forceReload)
        await gtfs.importGtfs(config);
    await gtfs.updateGtfsRealtime(config);
    await cache.refreshStaticCache(true);
    await cache.refreshRealtimeCache();
    if (gtfs.getStops().length === 0)
        await gtfs.importGtfs(config);
    if (!autoRefresh)
        return;
    realtimeInterval = setInterval(() => updateRealtime().catch((err) => logger.error("Error refreshing realtime GTFS data", {
        module: "index",
        function: "loadGTFS",
        error: err.message || err,
    })), realtimeIntervalMs);
    staticInterval = setInterval(async () => {
        try {
            await gtfs.importGtfs(config);
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
}
export function today() {
    return Number.parseInt(new Date(Date.now() + 3600 * 10 * 1000).toISOString().slice(0, 10).replace(/-/g, ""));
}
export default {
    config,
    loadGTFS,
    updateRealtime,
    clearIntervals,
    formatTimestamp,
    today,
    ...cache,
    express,
    calendar,
    ...stations,
    qrTravel,
    ScheduleRelationship: augmentedStopTime.ScheduleRelationship,
    logger, // Export the logger
};
export { Logger, LogLevel } from "./utils/logger.js"; // Export logger types
