import { GTFS } from "qdf-gtfs";
import { TraxConfig } from "./config.js";
import logger from "./utils/logger.js";

let currentGtfs: GTFS | null = null;

export async function loadStatic(gtfs: GTFS, config: TraxConfig) {
	logger.info("Loading GTFS data...");
	await gtfs.loadStatic(config.urls);
	logger.info("Merging stops...");
	for (const st of config.mergeStops) gtfs.actions.mergeStops(st.to, st.from);
	logger.info("Static GTFS data loaded.");
}

export async function loadRealtime(gtfs: GTFS, config: TraxConfig) {
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
	await Promise.all([
		loadStatic(gtfs, config).catch((e) => {
			logger.error("Error loading static gtfs!!! " + ((e as any).message ?? e), {
				module: "GTFS",
				function: "createGTFS",
			});
			console.error(e);
		}),
		doRealtime
			? loadRealtime(gtfs, config).catch((e) => {
					logger.error("Error loading realtime gtfs!!! " + ((e as any).message ?? e), {
						module: "GTFS",
						function: "createGTFS",
					});
					console.error(e);
				})
			: Promise.resolve(),
	]);
	return gtfs;
}
