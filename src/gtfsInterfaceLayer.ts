import { GTFS, type GTFSFeedConfig, type GTFSRealtimeFeedConfig } from "qdf-gtfs";
import type { TraxConfig } from "./config.js";
import logger from "./utils/logger.js";

export type SourceReport = {
	id: string;
	feedId: string;
	kind: "static" | "trip-updates" | "vehicles" | "alerts";
	state: "loading" | "healthy" | "stale" | "error";
	error?: string;
	transport?: "network" | "fresh-cache" | "stale-cache";
};
export type SourceReporter = (report: SourceReport) => void;

export async function loadStatic(gtfs: GTFS, config: TraxConfig, report?: SourceReporter): Promise<void> {
	logger.info(`Loading static GTFS data for ${config.network.id}...`);
	const feeds: GTFSFeedConfig[] = config.network.feeds.map((feed) => ({
		id: feed.id,
		...feed.staticSource,
	}));
	for (const feed of config.network.feeds) report?.({ id: `${feed.id}:static`, feedId: feed.id, kind: "static", state: "loading" });
	try {
		const results = await gtfs.loadStatic(feeds);
		for (const result of results) report?.({
			id: `${result.id}:static`, feedId: result.id, kind: "static",
			state: result.source === "stale-cache" ? "stale" : "healthy", transport: result.source,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		for (const feed of config.network.feeds) report?.({ id: `${feed.id}:static`, feedId: feed.id, kind: "static", state: "error", error: message });
		throw error;
	}
	for (const action of config.mergeStops) gtfs.actions.mergeStops(action.to, action.from, action.feedId);
	for (const action of config.updateStopActions) {
		gtfs.actions.updateStop(action.stop_id, action.new, action.feedId);
	}
	logger.info(`Static GTFS data loaded for ${config.network.id}.`);
}

export async function loadRealtime(gtfs: GTFS, config: TraxConfig, report?: SourceReporter): Promise<void> {
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
	for (const source of sources) report?.({ id: source.id, feedId: source.targetFeedId, kind: source.kind, state: "loading" });
	const results = await gtfs.updateRealtimeFromUrl(sources);
	for (const result of results) {
		const source = sources.find((candidate) => candidate.id === result.id)!;
		report?.({
			id: result.id, feedId: source.targetFeedId, kind: source.kind,
			state: result.ok ? "healthy" : "error", error: result.error,
		});
	}
	logger.info(`Realtime data loaded for ${config.network.id}.`);
}

export async function createGtfs(config: TraxConfig, doRealtime = true, report?: SourceReporter): Promise<GTFS> {
	const gtfs = new GTFS({
		ansi: false,
		logger: config.logFunction,
		progress: config.progressLog,
		cache: true,
		cacheDir: config.cacheDir,
		cacheMaxAgeMs: config.cacheMaxAgeMs,
		requestTimeoutMs: config.requestTimeoutMs,
	});
	await loadStatic(gtfs, config, report);
	if (doRealtime) {
		await loadRealtime(gtfs, config, report).catch((error) => {
			logger.error(`Initial realtime load failed for ${config.network.id}: ${error instanceof Error ? error.message : String(error)}`);
		});
	}
	return gtfs;
}
