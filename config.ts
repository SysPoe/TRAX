import { ProgressInfo } from "qdf-gtfs";
import logger, { LogLevel } from "./utils/logger.js";

export const DEBUG = true;

export const TRAX_CONFIG = {
	url: "https://gtfsrt.api.translink.com.au/GTFS/SEQ_GTFS.zip",
	realtimeAlerts: "https://gtfsrt.api.translink.com.au/api/realtime/SEQ/alerts",
	realtimeTripUpdates: "https://gtfsrt.api.translink.com.au/api/realtime/SEQ/TripUpdates",
	realtimeVehiclePositions: "https://gtfsrt.api.translink.com.au/api/realtime/SEQ/VehiclePositions",
	serviceCapacityUrl:
		"https://www.data.qld.gov.au/dataset/17b6ae0c-8b34-46fa-b944-dfda609621e0/resource/a0a83f8c-6ee4-4372-a276-669c79fe592b/download/service_capacity_tracker_dashboard_train_ferry_tram.csv",
	sqlitePath: "./.TRAXCACHE.sqlite",
	verbose: DEBUG,
	db: undefined,
	logFunction: (message: string) => logger.debug(message, { module: "gtfs" }),
	progressLog: (info: ProgressInfo) => logger.progress(info),
};

// Configure logger based on DEBUG flag
if (DEBUG) {
	logger.setLevel(LogLevel.DEBUG);
} else {
	logger.setLevel(LogLevel.INFO);
}
