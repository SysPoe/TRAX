import logger, { LogLevel } from "./utils/logger.js";

export const DEBUG = true;

export const TRAX_CONFIG = {
    url: "https://gtfsrt.api.translink.com.au/GTFS/SEQ_GTFS.zip",
    realtimeAlerts: "https://gtfsrt.api.translink.com.au/api/realtime/SEQ/alerts",
    realtimeTripUpdates: "https://gtfsrt.api.translink.com.au/api/realtime/SEQ/TripUpdates",
    realtimeVehiclePositions: "https://gtfsrt.api.translink.com.au/api/realtime/SEQ/VehiclePositions",
    sqlitePath: "./.TRAXCACHE.sqlite",
    verbose: DEBUG,
    db: undefined,
    logFunction: (message: string) => logger.debug(message, { module: "gtfs" }),
};

// Configure logger based on DEBUG flag
if (DEBUG) {
    logger.setLevel(LogLevel.DEBUG);
} else {
    logger.setLevel(LogLevel.INFO);
}