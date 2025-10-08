import * as gtfs from "gtfs";
import fs from "fs";
import * as cache from "./cache.js";
import * as calendar from "./utils/calendar.js";
import * as stations from "./stations.js";
import * as express from "./utils/express.js";
import * as qrTravel from "./qr-travel/qr-travel-tracker.js";
import * as augmentedStopTime from "./utils/augmentedStopTime.js";
import * as timeUtils from "./utils/time.js";
import logger, { LogLevel } from "./utils/logger.js";
import { EventEmitter } from "events";

export const DEBUG = true;

const traxEmitter = new EventEmitter();

// Configure logger based on DEBUG flag
if (DEBUG) {
	logger.setLevel(LogLevel.DEBUG);
} else {
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
	logFunction: (message: string) => logger.debug(message, { module: "gtfs" }),
};

let realtimeInterval: NodeJS.Timeout | null = null;
let staticInterval: NodeJS.Timeout | null = null;

export async function loadGTFS(
	autoRefresh: boolean = false,
	forceReload: boolean = false,
	realtimeIntervalMs: number = 60 * 1000, // 1 minute
	staticIntervalMs: number = 24 * 60 * 60 * 1000, // 24 hours
): Promise<void> {
	const dbExists = fs.existsSync(config.sqlitePath);
	if (!dbExists || forceReload) await gtfs.importGtfs(config);

	await gtfs.updateGtfsRealtime(config);
	await cache.refreshStaticCache(true);
	await cache.refreshRealtimeCache();

	if (gtfs.getStops().length === 0) await gtfs.importGtfs(config);

	if (!autoRefresh) return;

	realtimeInterval = setInterval(
		() =>
			updateRealtime().catch((err: any) =>
				logger.error("Error refreshing realtime GTFS data", {
					module: "index",
					function: "loadGTFS",
					error: err.message || err,
				}),
			),
		realtimeIntervalMs,
	);
	staticInterval = setInterval(async () => {
		try {
			await gtfs.importGtfs(config);
			await cache.refreshStaticCache(true);
			await cache.refreshRealtimeCache();
		} catch (error: any) {
			logger.error("Error refreshing static GTFS data", {
				module: "index",
				function: "loadGTFS",
				error: error.message || error,
			});
		}
	}, staticIntervalMs);
}

export function clearIntervals(): void {
	if (realtimeInterval) {
		clearInterval(realtimeInterval);
		realtimeInterval = null;
	}
	if (staticInterval) {
		clearInterval(staticInterval);
		staticInterval = null;
	}
}

export function formatTimestamp(ts?: number | null): string {
	if (ts === null || ts === undefined) return "--:--";
	let h = Math.floor(ts / 3600);
	let m = Math.floor((ts % 3600) / 60);
	return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
}

export async function updateRealtime(): Promise<void> {
	traxEmitter.emit("update-realtime-start");
	try {
		await gtfs.updateGtfsRealtime(config);
		await cache.refreshRealtimeCache();
	} catch (error: any) {
		logger.error("Error updating realtime GTFS data", {
			module: "index",
			function: "updateRealtime",
			error: error.message || error,
		});
		throw error;
	} finally {
		traxEmitter.emit("update-realtime-end");
	}
}

export function today(): number {
	return Number.parseInt(new Date(Date.now() + 3600 * 10 * 1000).toISOString().slice(0, 10).replace(/-/g, ""));
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
	on: (event: string, listener: (...args: any[]) => void) => traxEmitter.on(event, listener),
	off: (event: string, listener: (...args: any[]) => void) => traxEmitter.off(event, listener),

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
	},
	config,
	logger,
	ScheduleRelationship: augmentedStopTime.ScheduleRelationship,
};

export default TRAX;

export type { AugmentedTrip, SerializableAugmentedTrip, RunSeries } from "./utils/augmentedTrip.js";

export type { AugmentedStopTime, SerializableAugmentedStopTime } from "./utils/augmentedStopTime.js";

export type { AugmentedStop, SerializableAugmentedStop } from "./utils/augmentedStop.js";

export type {
	TrainMovementDTO,
	ServiceDisruption,
	GetServiceResponse,
	QRTPlace,
	Service,
	Direction,
	ServiceLine,
	AllServicesResponse,
	QRTService,
	ServiceUpdate,
	TravelStopTime,
	TravelTrip,
} from "./qr-travel/types.js";

export type { ExpressInfo } from "./utils/express.js";

export type { SRTStop } from "./utils/SectionalRunningTimes/metroSRTTravelTrain.js";

export { Logger, LogLevel } from "./utils/logger.js"; // Export logger types
