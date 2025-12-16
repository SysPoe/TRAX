import { GTFS } from "qdf-gtfs";
import { TRAX_CONFIG } from "./config.js";
import logger from "./utils/logger.js";

let currentGtfs: GTFS | null = null;

async function loadStatic(gtfs: GTFS) {
	logger.info("Loading GTFS data...");
	await gtfs.loadFromUrl(TRAX_CONFIG.url);
	logger.info("GTFS data loaded.");
}

async function loadRealtime(gtfs: GTFS) {
	if (!TRAX_CONFIG.hasRealtime) return;
	logger.info("Loading realtime data...");
	await gtfs.updateRealtimeFromUrl(
		TRAX_CONFIG.realtimeAlerts,
		TRAX_CONFIG.realtimeTripUpdates,
		TRAX_CONFIG.realtimeVehiclePositions,
	);
	logger.info("Realtime data loaded.");
}

export async function createGtfs() {
	let gtfs = new GTFS({
		ansi: false,
		logger: TRAX_CONFIG.logFunction,
		progress: TRAX_CONFIG.progressLog,
		cache: true,
		cacheDir: ".TRAXCACHE",
	});
	await Promise.all([loadStatic(gtfs), loadRealtime(gtfs)]);
	currentGtfs = gtfs;
}

export function hasGtfs() {
	return currentGtfs != null;
}

export function getGtfs(): GTFS {
	// dangerous!
	if (currentGtfs == null) throw new Error("Tried to access GTFS object before it's loaded!!!");
	return currentGtfs;
}
