import { ProgressInfo } from "qdf-gtfs";
import logger, { LogLevel } from "./utils/logger.js";

export const DEBUG = true;

export const TRAX_CONFIG: {
	url: string;
	verbose: boolean;
	cacheDir: string;
	logFunction: (message: string) => void;
	progressLog: (info: ProgressInfo) => void;
	region: "SEQ" | "none";
} & (
	| {
			hasRealtime: true;
			realtimeAlerts: string;
			realtimeTripUpdates: string;
			realtimeVehiclePositions: string;
	  }
	| {
			hasRealtime: false;
	  }
) = {
	url: "https://gtfsrt.api.translink.com.au/GTFS/SEQ_GTFS.zip",
	hasRealtime: true,
	realtimeAlerts: "https://gtfsrt.api.translink.com.au/api/realtime/SEQ/alerts",
	realtimeTripUpdates: "https://gtfsrt.api.translink.com.au/api/realtime/SEQ/TripUpdates",
	realtimeVehiclePositions: "https://gtfsrt.api.translink.com.au/api/realtime/SEQ/VehiclePositions",
	verbose: DEBUG,
	cacheDir: ".TRAXCACHE",
	logFunction: (message: string) => logger.debug(message, { module: "gtfs" }),
	progressLog: (info: ProgressInfo) => logger.progress(info),
	region: "SEQ",
};

if (DEBUG) logger.setLevel(LogLevel.DEBUG);
else logger.setLevel(LogLevel.INFO);
