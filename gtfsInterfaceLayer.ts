import { GTFS } from "qdf-gtfs";
import { TraxConfig } from "./config.js";
import logger from "./utils/logger.js";

let currentGtfs: GTFS | null = null;

async function loadStatic(gtfs: GTFS, config: TraxConfig) {
	logger.info("Loading GTFS data...");
	await gtfs.loadStatic(config.urls);
	logger.info("GTFS data loaded.");
}

async function loadRealtime(gtfs: GTFS, config: TraxConfig) {
	if (!config.realtime) return;
	const rt = config.realtime;
	logger.info("Loading realtime data...");

	await gtfs.updateRealtimeFromUrl(
		rt.realtimeAlerts,
		rt.realtimeTripUpdates,
		rt.realtimeVehiclePositions,
	);
	logger.info("Realtime data loaded.");
}

export async function createGtfs(config: TraxConfig) {
	let gtfs = new GTFS({
		ansi: false,
		logger: config.logFunction,
		progress: config.progressLog,
		cache: true,
		cacheDir: config.cacheDir,
	});
	await Promise.all([loadStatic(gtfs, config), loadRealtime(gtfs, config)]);
	currentGtfs = gtfs;
}

export function hasGtfs() {
	return currentGtfs != null;
}

export function getGtfs(): GTFS {
	if (currentGtfs == null) throw new Error("Tried to access GTFS object before it's loaded!!!");
	return currentGtfs;
}