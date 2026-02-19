import { GTFS } from "qdf-gtfs";
import { TraxConfig } from "./config.js";
import logger from "./utils/logger.js";

let currentGtfs: GTFS | null = null;

export function getGtfs(): GTFS {
	if (!currentGtfs) throw new Error("GTFS has not been initialized yet.");
	return currentGtfs;
}

export async function loadStatic(gtfs: GTFS, config: TraxConfig): Promise<void> {
	logger.info("Loading GTFS data...");
	await gtfs.loadStatic(config.urls);
	logger.info("Merging stops...");
	for (const st of config.mergeStops) gtfs.actions.mergeStops(st.to, st.from);
	logger.info("Updating stops...");
	for (const st of config.updateStopActions) gtfs.actions.updateStop(st.stop_id, st.new);
	logger.info("Static GTFS data loaded.");
}

export async function loadRealtime(gtfs: GTFS, config: TraxConfig): Promise<void> {
	if (!config.realtime) return;
	const rt = config.realtime;
	logger.info("Loading realtime data...");

	await gtfs.updateRealtimeFromUrl(rt.realtimeAlerts, rt.realtimeTripUpdates, rt.realtimeVehiclePositions);
	logger.info("Realtime data loaded.");
}

export async function createGtfs(config: TraxConfig, doRealtime: boolean = true): Promise<GTFS> {
	let gtfs = new GTFS({
		ansi: false,
		logger: config.logFunction,
		progress: config.progressLog,
		cache: true,
		cacheDir: config.cacheDir,
	});
	await loadStatic(gtfs, config).catch((e) => {
		const message = e instanceof Error ? e.message : String(e);
		logger.error("Error loading static gtfs!!! " + message, {
			module: "GTFS",
			function: "createGTFS",
		});
		return Promise.reject(e);
	});

	if (doRealtime) {
		await loadRealtime(gtfs, config).catch((e) => {
			const message = e instanceof Error ? e.message : String(e);
			logger.error("Error loading realtime gtfs!!! " + message, {
				module: "GTFS",
				function: "createGTFS",
			});
			return Promise.reject(e);
		});
	}
	currentGtfs = gtfs;
	return gtfs;
}
