import type { ProgressInfo, QualifiedEntityId, Stop, Trip } from "qdf-gtfs";
import logger from "./utils/logger.js";
import type { TransitPlugin } from "./plugins/types.js";
import { entityKey } from "./identity.js";

export interface FeedSource {
	url: string;
	/** Ordered alternatives used when the primary endpoint fails. */
	fallbackUrls?: readonly string[];
	headers?: Record<string, string>;
	/** Path of a nested GTFS ZIP inside the downloaded archive. */
	archiveEntry?: string;
}

export interface RealtimeSource {
	id: string;
	targetFeedId: string;
	kind: "trip-updates" | "vehicles" | "alerts";
	source: FeedSource;
}

/** Derives the public run number for one static feed's trips. */
export type TripNumberResolver = (trip: Pick<Trip, "trip_id" | "trip_short_name">) => string | undefined;

export interface FeedDefinition {
	id: string;
	staticSource: FeedSource;
	realtimeSources: RealtimeSource[];
	/** Only use this when a feed's agency_timezone is defective. */
	timeZone?: string;
	/** Overrides TRAX's numeric short-name, then trailing-four-character default. */
	tripNumber?: TripNumberResolver;
}

export type TransitMode = "rail" | "subway" | "tram" | "bus" | "ferry";

export interface PlaceDefinition {
	id: string;
	name: string;
	members: QualifiedEntityId[];
}

export interface NetworkDefinition {
	id: string;
	name: string;
	feeds: FeedDefinition[];
	modes: TransitMode[];
	plugins: TransitPlugin[];
	/** Client-facing places that group equivalent stations across static feeds. */
	places?: PlaceDefinition[];
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
	cacheMaxAgeMs?: number;
	requestTimeoutMs?: number;
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
	cacheMaxAgeMs: number;
	requestTimeoutMs: number;
	/** Populated and validated from agency_timezone after the static feed loads. */
	feedTimeZones: Map<string, string>;
	/** O(1) lookup for the cross-feed place containing a station member. */
	placeByMember: Map<string, PlaceDefinition>;
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
	for (const plugin of network.plugins) {
		if (plugin.feedIds.length === 0) throw new Error(`Plugin '${plugin.id}' must declare at least one feed scope`);
		for (const feedId of plugin.feedIds) {
			if (!feedIds.has(feedId)) throw new Error(`Plugin '${plugin.id}' references unknown feed '${feedId}'`);
		}
	}
	const placeIds = new Set<string>();
	const placeByMember = new Map<string, PlaceDefinition>();
	for (const place of network.places ?? []) {
		if (!place.id || !place.name || place.members.length === 0)
			throw new Error(`Network '${network.id}' contains an invalid place`);
		if (placeIds.has(place.id)) throw new Error(`Network '${network.id}' contains duplicate place '${place.id}'`);
		placeIds.add(place.id);
		for (const member of place.members) {
			if (!feedIds.has(member.feedId) || !member.localId)
				throw new Error(`Place '${place.id}' contains invalid member '${member.feedId}:${member.localId}'`);
			const memberKey = entityKey(member);
			const existing = placeByMember.get(memberKey);
			if (existing)
				throw new Error(
					`Station member '${member.feedId}:${member.localId}' belongs to both places '${existing.id}' and '${place.id}'`,
				);
			placeByMember.set(memberKey, place);
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
		cacheMaxAgeMs: options.cacheMaxAgeMs ?? 24 * 60 * 60 * 1000,
		requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
		feedTimeZones: new Map(),
		placeByMember,
	};
}

export function getPlaceForStation(config: TraxConfig, station: QualifiedEntityId): PlaceDefinition | null {
	return config.placeByMember.get(entityKey(station)) ?? null;
}

/** Use one physical graph node for equivalent station records from different feeds. */
export function canonicalStationIdentity(config: TraxConfig, station: QualifiedEntityId): QualifiedEntityId {
	return getPlaceForStation(config, station)?.members[0] ?? station;
}

export function hasPlugin(config: TraxConfig, pluginId: string, feedId?: string): boolean {
	return config.network.plugins.some(
		(plugin) => plugin.id === pluginId && (!feedId || plugin.feedIds.includes(feedId)),
	);
}

export function getFeedTimeZone(config: TraxConfig, feedId: string): string {
	const timeZone = config.feedTimeZones.get(feedId);
	if (!timeZone) throw new Error(`No validated timezone for feed '${feedId}' in network '${config.network.id}'`);
	return timeZone;
}

export function getDefaultTimeZone(config: TraxConfig): string {
	return getFeedTimeZone(config, config.network.feeds[0].id);
}

/** Resolve a trip's run number using its feed rule, or TRAX's shared default. */
export function resolveTripNumber(network: NetworkDefinition, trip: Pick<Trip, "feed_id" | "trip_id" | "trip_short_name">): string {
	const configured = network.feeds.find((feed) => feed.id === trip.feed_id)?.tripNumber?.(trip)?.trim();
	if (configured) return configured;
	return trip.trip_short_name && /^\d{1,3}$/.test(trip.trip_short_name)
		? trip.trip_short_name
		: trip.trip_id.slice(-4);
}
