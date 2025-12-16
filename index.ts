import * as cache from "./cache.js";
import * as calendar from "./utils/calendar.js";
import * as stations from "./utils/stations.js";
import * as qrTravel from "./qr-travel/qr-travel-tracker.js";
import * as timeUtils from "./utils/time.js";
import { EventEmitter } from "events";
import { createGtfs, getGtfs, hasGtfs } from "./gtfsInterfaceLayer.js";
import logger from "./utils/logger.js";
import { TRAX_CONFIG } from "./config.js";
import { findExpressString } from "./utils/SectionalRunningTimes/gtfs.js";
import { getServiceCapacity } from "./utils/serviceCapacity.js";
import {
	attachDeparturesHelpers,
	getDeparturesForStop,
	getServiceDateDeparturesForStop,
} from "./utils/departures.js";

interface TRAXEvent {
	"realtime-update-start": [];
	"realtime-update-end": [];
	"static-update-start": [];
	"static-update-end": [];
}

const traxEmitter: EventEmitter<TRAXEvent> = new EventEmitter();

let realtimeInterval: NodeJS.Timeout | null = null;
let staticInterval: NodeJS.Timeout | null = null;

export async function loadGTFS(
	autoRefresh: boolean = false,
	realtimeIntervalMs: number = 60 * 1000, // 1 minute
	staticIntervalMs: number = 24 * 60 * 60 * 1000, // 24 hours
): Promise<void> {
	await createGtfs();
	await cache.refreshStaticCache();
	await cache.refreshRealtimeCache();

	if (!autoRefresh) return;

	const scheduleNextRealtime = () => {
		realtimeInterval = setTimeout(async () => {
			traxEmitter.emit("realtime-update-start");
			try {
				await updateRealtime();
			} catch (error: any) {
				logger.error("Error updating realtime GTFS data: " + (error.message || error), {
					module: "index",
					function: "loadGTFS - scheduleNextRealtime",
				});
			} finally {
				traxEmitter.emit("realtime-update-end");
				scheduleNextRealtime();
			}
		}, realtimeIntervalMs);
	}

	const scheduleNextStatic = () => {
		staticInterval = setTimeout(async () => {
			traxEmitter.emit("static-update-start");
			try {
				await createGtfs();
				await cache.refreshStaticCache();
				await cache.refreshRealtimeCache();
			} catch (error: any) {
				logger.error("Error refreshing static GTFS data", {
					module: "index",
					function: "loadGTFS - scheduleNextStatic",
					error: error.message || error,
				});
			} finally {
				traxEmitter.emit("static-update-end");
				scheduleNextStatic();
			}
		}, staticIntervalMs);
	}

	scheduleNextRealtime();
	scheduleNextStatic();
}

export function clearIntervals(): void {
	if (realtimeInterval) {
		clearTimeout(realtimeInterval);
		realtimeInterval = null;
	}
	if (staticInterval) {
		clearTimeout(staticInterval);
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
	const gtfs = getGtfs();
	try {
		await gtfs.updateRealtimeFromUrl(
			TRAX_CONFIG.realtimeAlerts,
			TRAX_CONFIG.realtimeTripUpdates,
			TRAX_CONFIG.realtimeVehiclePositions,
		);
		await cache.refreshRealtimeCache();
	} catch (error: any) {
		logger.error("Error updating realtime GTFS data: " + error.message || error, {
			module: "index",
			function: "updateRealtime",
		});
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
	getAugmentedTripInstance: cache.getAugmentedTripInstance,
	getAugmentedStops: cache.getAugmentedStops,
	getAugmentedStopTimes: cache.getAugmentedStopTimes,
	getBaseStopTimes: cache.getBaseStopTimes,
	getRunSeries: cache.getRunSeries,
	getStations: stations.getAugmentedRailStations,
	getRawTrips: cache.getRawTrips,
	getRawStops: cache.getRawStops,
	getRawRoutes: cache.getRawRoutes,
	getRawCalendars: cache.getRawCalendars,
	getRawCalendarDates: cache.getRawCalendarDates,
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
	qrTravel,
	express: { findExpressString },
	getServiceCapacity,

	// Utilities and config
	utils: {
		time: timeUtils,
		formatTimestamp,
		hasGtfs,
		getGtfs,
		departures: { attachDeparturesHelpers, getDeparturesForStop, getServiceDateDeparturesForStop },
	},
	TRAX_CONFIG,
	logger,
};

export default TRAX;

export type { AugmentedTrip, RunSeries } from "./utils/augmentedTrip.js";

export type { AugmentedStopTime } from "./utils/augmentedStopTime.js";

export type { AugmentedStop } from "./utils/augmentedStop.js";

export { attachDeparturesHelpers, getDeparturesForStop, getServiceDateDeparturesForStop } from "./utils/departures.js";

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

export type { SRTStop } from "./utils/SectionalRunningTimes/qrt.js";

export { Logger as TraxLogger, LogLevel } from "./utils/logger.js"; // Export logger types
