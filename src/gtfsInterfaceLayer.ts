import { GTFS, type GTFSFeedConfig, type GTFSRealtimeFeedConfig } from "qdf-gtfs";
import type { TraxConfig } from "./config.js";
import logger from "./utils/logger.js";

export async function loadStatic(gtfs: GTFS, config: TraxConfig): Promise<void> {
	logger.info(`Loading static GTFS data for ${config.network.id}...`);
	const feeds: GTFSFeedConfig[] = config.network.feeds.map((feed) => ({
		id: feed.id,
		...feed.staticSource,
	}));
	await gtfs.loadStatic(feeds);
	for (const action of config.mergeStops) gtfs.actions.mergeStops(action.to, action.from, action.feedId);
	for (const action of config.updateStopActions) {
		gtfs.actions.updateStop(action.stop_id, action.new, action.feedId);
	}
	logger.info(`Static GTFS data loaded for ${config.network.id}.`);
}

export async function loadRealtime(gtfs: GTFS, config: TraxConfig): Promise<void> {
	const sources: GTFSRealtimeFeedConfig[] = config.network.feeds.flatMap((feed) =>
		feed.realtimeSources.map((realtime) => ({
			id: realtime.id,
			targetFeedId: realtime.targetFeedId,
			kind: realtime.kind,
			...realtime.source,
		})),
	);
	if (sources.length === 0) return;
	logger.info(`Loading realtime data for ${config.network.id}...`);
	await gtfs.updateRealtimeFromUrl(sources);
	logger.info(`Realtime data loaded for ${config.network.id}.`);
}

export async function createGtfs(config: TraxConfig, doRealtime = true): Promise<GTFS> {
	const gtfs = new GTFS({
		ansi: false,
		logger: config.logFunction,
		progress: config.progressLog,
		cache: true,
		cacheDir: config.cacheDir,
	});
	await loadStatic(gtfs, config);
	if (doRealtime) {
		await loadRealtime(gtfs, config).catch((error) => {
			logger.error(`Initial realtime load failed for ${config.network.id}: ${error instanceof Error ? error.message : String(error)}`);
		});
	}
	return gtfs;
}
