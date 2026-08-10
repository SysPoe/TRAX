import type { ProgressInfo, Stop } from "qdf-gtfs";
import logger from "./utils/logger.js";
import type { TransitPlugin } from "./plugins/types.js";

export interface FeedSource {
	url: string;
	headers?: Record<string, string>;
}

export interface RealtimeSource {
	id: string;
	targetFeedId: string;
	kind: "trip-updates" | "vehicles" | "alerts";
	source: FeedSource;
}

export interface FeedDefinition {
	id: string;
	staticSource: FeedSource;
	realtimeSources: RealtimeSource[];
	/** Only use this when a feed's agency_timezone is defective. */
	timeZone?: string;
}

export type TransitMode = "rail" | "subway" | "tram" | "bus" | "ferry";

export interface NetworkDefinition {
	id: string;
	name: string;
	feeds: FeedDefinition[];
	modes: TransitMode[];
	plugins: TransitPlugin[];
}

export type MergeAction = { to: string; from: string[]; feedId: string };

export interface RuntimeOptions {
	verbose?: boolean;
	cacheDir?: string;
	logFunction?: (message: string) => void;
	progressLog?: (info: ProgressInfo) => void;
	disableTimers?: boolean;
	preloadStopTimes?: boolean;
	mergeStops?: MergeAction[];
	updateStopActions?: { feedId: string; stop_id: string; new: Partial<Stop> }[];
}

export interface TraxConfig {
	network: NetworkDefinition;
	verbose: boolean;
	cacheDir: string;
	logFunction: (message: string) => void;
	progressLog: (info: ProgressInfo) => void;
	disableTimers: boolean;
	preloadStopTimes: boolean;
	mergeStops: MergeAction[];
	updateStopActions: { feedId: string; stop_id: string; new: Partial<Stop> }[];
	/** Populated and validated from agency_timezone after the static feed loads. */
	feedTimeZones: Map<string, string>;
}

export function resolveConfig(network: NetworkDefinition, options: RuntimeOptions = {}): TraxConfig {
	if (!network.id || !network.name) throw new Error("NetworkDefinition requires id and name");
	if (network.feeds.length === 0) throw new Error(`Network '${network.id}' has no feeds`);
	const feedIds = new Set<string>();
	for (const feed of network.feeds) {
		if (!feed.id) throw new Error(`Network '${network.id}' contains a feed without id`);
		if (feedIds.has(feed.id)) throw new Error(`Network '${network.id}' contains duplicate feed '${feed.id}'`);
		feedIds.add(feed.id);
		for (const source of feed.realtimeSources) {
			if (source.targetFeedId !== feed.id) {
				throw new Error(`Realtime source '${source.id}' must target its containing feed '${feed.id}'`);
			}
		}
	}

	return {
		network,
		verbose: options.verbose ?? true,
		cacheDir: options.cacheDir ?? `.TRAXCACHE/${network.id}`,
		logFunction: options.logFunction ?? ((message) => logger.debug(message, { module: "gtfs" })),
		progressLog: options.progressLog ?? ((info) => logger.progress(info)),
		disableTimers: options.disableTimers ?? true,
		preloadStopTimes: options.preloadStopTimes ?? false,
		mergeStops: options.mergeStops ?? [],
		updateStopActions: options.updateStopActions ?? [],
		feedTimeZones: new Map(),
	};
}

export function hasPlugin(config: TraxConfig, pluginId: string): boolean {
	return config.network.plugins.some((plugin) => plugin.id === pluginId);
}

export function getFeedTimeZone(config: TraxConfig, feedId: string): string {
	const timeZone = config.feedTimeZones.get(feedId);
	if (!timeZone) throw new Error(`No validated timezone for feed '${feedId}' in network '${config.network.id}'`);
	return timeZone;
}

export function getDefaultTimeZone(config: TraxConfig): string {
	return getFeedTimeZone(config, config.network.feeds[0].id);
}
