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
	// Delegate per-feed fallbacks to QDF in a single loadStatic call. QDF tries
	// each source's primary then its fallbacks independently, so a failing feed
	// never forces a healthy feed to reload. Never mutate the configured sources.
	const feeds: GTFSFeedConfig[] = config.network.feeds.map((feed) => {
		const seen = new Set<string>([feed.staticSource.url]);
		const fallbackUrls: string[] = [];
		for (const url of feed.staticSource.fallbackUrls ?? []) {
			if (typeof url !== "string") continue;
			// Config validation rejects empty URLs; skip blanks defensively so a
			// misconfigured fallback can never become a silent empty fetch.
			if (url.trim().length === 0 || seen.has(url)) continue;
			seen.add(url);
			fallbackUrls.push(url);
		}
		return {
			id: feed.id,
			url: feed.staticSource.url,
			headers: feed.staticSource.headers,
			archiveEntry: feed.staticSource.archiveEntry,
			...(fallbackUrls.length > 0 ? { fallbackUrls } : {}),
		};
	});
	for (const feed of config.network.feeds)
		report?.({ id: `${feed.id}:static`, feedId: feed.id, kind: "static", state: "loading" });
	try {
		const results = await gtfs.loadStatic(feeds);
		for (const result of results)
			report?.({
				id: `${result.id}:static`,
				feedId: result.id,
				kind: "static",
				state: result.source === "stale-cache" ? "stale" : "healthy",
				transport: result.source,
			});
		for (const action of config.mergeStops) gtfs.actions.mergeStops(action.to, action.from, action.feedId);
		for (const action of config.updateStopActions) {
			gtfs.actions.updateStop(action.stop_id, action.new, action.feedId);
		}
		logger.info(`Static GTFS data loaded for ${config.network.id}.`);
		return;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		for (const feed of config.network.feeds)
			report?.({ id: `${feed.id}:static`, feedId: feed.id, kind: "static", state: "error", error: message });
		throw error;
	}
}

export async function loadRealtime(gtfs: GTFS, config: TraxConfig, report?: SourceReporter): Promise<void> {
	const definitions = config.network.feeds.flatMap((feed) => feed.realtimeSources);
	const sources: GTFSRealtimeFeedConfig[] = definitions.map((realtime) => ({
		id: realtime.id,
		targetFeedId: realtime.targetFeedId,
		kind: realtime.kind,
		url: realtime.source.url,
		headers: realtime.source.headers,
	}));
	if (sources.length === 0) return;
	logger.info(`Loading realtime data for ${config.network.id}...`);
	for (const source of sources)
		report?.({ id: source.id, feedId: source.targetFeedId, kind: source.kind, state: "loading" });
	let results: Awaited<ReturnType<GTFS["updateRealtimeFromUrl"]>>;
	try {
		results = await gtfs.updateRealtimeFromUrl(sources);
	} catch (error) {
		// A transport-level throw must still try per-source fallbacks safely
		// instead of aborting the whole realtime cycle.
		const message = error instanceof Error ? error.message : String(error);
		results = sources.map((source) => ({ id: source.id, ok: false as const, error: message }));
	}
	for (let result of results) {
		const source = sources.find((candidate) => candidate.id === result.id)!;
		const definition = definitions.find((candidate) => candidate.id === result.id)!;
		if (!result.ok) {
			const seen = new Set([source.url]);
			for (const fallbackUrl of definition.source.fallbackUrls ?? []) {
				if (typeof fallbackUrl !== "string" || fallbackUrl.trim().length === 0 || seen.has(fallbackUrl)) continue;
				seen.add(fallbackUrl);
				try {
					const [fallbackResult] = await gtfs.updateRealtimeFromUrl([{ ...source, url: fallbackUrl }]);
					result = fallbackResult;
					if (result.ok) break;
				} catch (error) {
					result = {
						id: source.id,
						ok: false as const,
						error: error instanceof Error ? error.message : String(error),
					};
				}
			}
		}
		report?.({
			id: result.id,
			feedId: source.targetFeedId,
			kind: source.kind,
			state: result.ok ? "healthy" : "error",
			error: result.error,
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
		maxDownloadBytes: config.maxDownloadBytes,
	});
	await loadStatic(gtfs, config, report);
	if (doRealtime) {
		await loadRealtime(gtfs, config, report).catch((error) => {
			logger.error(
				`Initial realtime load failed for ${config.network.id}: ${error instanceof Error ? error.message : String(error)}`,
			);
		});
	}
	return gtfs;
}
