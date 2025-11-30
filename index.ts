import * as cache from "./cache.js";
import * as calendar from "./utils/calendar.js";
import * as stations from "./utils/stations.js";
import * as express from "./utils/express.js";
import * as qrTravel from "./qr-travel/qr-travel-tracker.js";
import * as timeUtils from "./utils/time.js";
import { EventEmitter } from "events";
import { createGtfs, getGtfs, hasGtfs } from "./gtfsInterfaceLayer.js"
import logger from "./utils/logger.js";
import { TRAX_CONFIG } from "./config.js";

const traxEmitter = new EventEmitter();

let realtimeInterval: NodeJS.Timeout | null = null;
let staticInterval: NodeJS.Timeout | null = null;

export async function loadGTFS(
	autoRefresh: boolean = false,
	forceReload: boolean = false,
	realtimeIntervalMs: number = 60 * 1000, // 1 minute
	staticIntervalMs: number = 24 * 60 * 60 * 1000, // 24 hours
): Promise<void> {
	await createGtfs();

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
			await createGtfs();
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
	const gtfs = getGtfs();
	try {
		await gtfs.updateRealtimeFromUrl(TRAX_CONFIG.realtimeAlerts, TRAX_CONFIG.realtimeTripUpdates, TRAX_CONFIG.realtimeVehiclePositions);
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

export function today(): string {
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
		hasGtfs,
		getGtfs
	},
	TRAX_CONFIG,
	logger,
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
