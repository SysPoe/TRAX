import type { ProgressInfo, QualifiedEntityId, Stop, Trip } from "qdf-gtfs";
import logger from "./utils/logger.js";
import type { TransitPlugin } from "./plugins/types.js";
import { entityKey } from "./identity.js";
import type { CorridorResolutionConfig, CorridorResolutionOverrides } from "./utils/corridor/types.js";

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

/** Realtime facts a feed may use when deriving a public run number. */
export interface TripRealtimeContext {
	vehicleLabel: string | null;
}

/** Derives the public run number for one static feed's trips. */
export type TripNumberResolver = (
	trip: Pick<Trip, "trip_id" | "trip_short_name">,
	realtime?: TripRealtimeContext,
) => string | undefined;

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

/** Derive shared places when two feeds publish the same station ID. */
export interface SameStationIdPlacesDefinition {
	feedIds: readonly [string, string];
	canonicalFeedId: string;
	placeIdPrefix: string;
	maxDistanceMeters: number;
}

export interface NetworkDefinition {
	id: string;
	name: string;
	feeds: FeedDefinition[];
	modes: TransitMode[];
	plugins: TransitPlugin[];
	/** Client-facing places that group equivalent stations across static feeds. */
	places?: PlaceDefinition[];
	/** Feed pairs whose matching station IDs should become shared places after static loading. */
	sameStationIdPlaces?: SameStationIdPlacesDefinition[];
	/** Provider-neutral physical corridor data and resolver thresholds. */
	corridor?: CorridorResolutionOverrides;
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
	corridor?: CorridorResolutionOverrides;
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
	/** Explicit and static-feed-derived places for this loaded generation. */
	places: PlaceDefinition[];
	corridor: CorridorResolutionConfig;
}

const DEFAULT_CORRIDOR_GEOMETRY = {
	exactShapeMembershipMaxMeters: 250,
	compatibleShapeMaxMeters: 150,
	geometryOnlyMaxMeters: 80,
	endpointSnapMaxMeters: 300,
	maxProjectionsPerStation: 3,
} as const;

function resolveCorridorConfig(network: NetworkDefinition, options: RuntimeOptions): CorridorResolutionConfig {
	const networkOverrides = network.corridor ?? {};
	const optionOverrides = options.corridor ?? {};
	const geometry = {
		...DEFAULT_CORRIDOR_GEOMETRY,
		...(networkOverrides.geometry ?? {}),
		...(optionOverrides.geometry ?? {}),
	};
	if (Object.values(geometry).some((value) => !Number.isFinite(value) || value <= 0)) {
		throw new Error(`Network '${network.id}' contains invalid corridor geometry thresholds`);
	}
	if (!Number.isInteger(geometry.maxProjectionsPerStation) || geometry.maxProjectionsPerStation < 1) {
		throw new Error(`Network '${network.id}' requires at least one corridor projection per station`);
	}

	return {
		enabled: optionOverrides.enabled ?? networkOverrides.enabled ?? true,
		minimumOutputConfidence:
			optionOverrides.minimumOutputConfidence ?? networkOverrides.minimumOutputConfidence ?? "medium",
		geometry,
		geometrySources: optionOverrides.geometrySources ?? networkOverrides.geometrySources ?? [],
		manualNetworks: optionOverrides.manualNetworks ?? networkOverrides.manualNetworks ?? [],
		diagnostics: optionOverrides.diagnostics ?? networkOverrides.diagnostics ?? false,
		version: optionOverrides.version ?? networkOverrides.version ?? "1",
	};
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
	// Concurrency groups are only safe for mutually independent plugins.
	for (let i = 0; i < network.plugins.length; i++) {
		const left = network.plugins[i];
		if (!left.concurrencyGroup) continue;
		for (let j = i + 1; j < network.plugins.length; j++) {
			const right = network.plugins[j];
			if (right.concurrencyGroup !== left.concurrencyGroup) continue;
			const overlap = left.feedIds.filter((feedId) => right.feedIds.includes(feedId));
			if (overlap.length > 0) {
				throw new Error(
					`Plugins '${left.id}' and '${right.id}' share concurrency group '${left.concurrencyGroup}' but overlap on feed(s) ${overlap.join(", ")}`,
				);
			}
		}
	}
	for (const rule of network.sameStationIdPlaces ?? []) {
		const [leftFeedId, rightFeedId] = rule.feedIds;
		if (
			!feedIds.has(leftFeedId) ||
			!feedIds.has(rightFeedId) ||
			leftFeedId === rightFeedId ||
			!rule.feedIds.includes(rule.canonicalFeedId) ||
			!rule.placeIdPrefix ||
			!Number.isFinite(rule.maxDistanceMeters) ||
			rule.maxDistanceMeters <= 0
		) {
			throw new Error(`Network '${network.id}' contains an invalid same-station-ID place rule`);
		}
	}
	const placeIds = new Set<string>();
	const placeByMember = new Map<string, PlaceDefinition>();
	const places = (network.places ?? []).map((place) => ({
		...place,
		members: place.members.map((member) => ({ ...member })),
	}));
	for (const place of places) {
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
		places,
		corridor: resolveCorridorConfig(network, options),
	};
}

function stationDistanceMeters(left: Stop, right: Stop): number | null {
	if (
		!Number.isFinite(left.stop_lat) ||
		!Number.isFinite(left.stop_lon) ||
		!Number.isFinite(right.stop_lat) ||
		!Number.isFinite(right.stop_lon)
	)
		return null;
	const leftLat = (left.stop_lat! * Math.PI) / 180;
	const rightLat = (right.stop_lat! * Math.PI) / 180;
	const latDelta = rightLat - leftLat;
	const lonDelta = ((right.stop_lon! - left.stop_lon!) * Math.PI) / 180;
	const haversine =
		Math.sin(latDelta / 2) ** 2 + Math.cos(leftLat) * Math.cos(rightLat) * Math.sin(lonDelta / 2) ** 2;
	return 12_742_000 * Math.asin(Math.sqrt(haversine));
}

function stationStopsById(stops: Stop[], feedId: string): Map<string, Stop> {
	const feedStops = stops.filter((stop) => stop.feed_id === feedId);
	const byId = new Map(feedStops.map((stop) => [stop.stop_id, stop]));
	const stations = new Map<string, Stop>();
	for (const stop of feedStops) {
		const stationId = stop.parent_station ?? stop.stop_id;
		stations.set(stationId, byId.get(stationId) ?? stop);
	}
	return stations;
}

function generatedPlaceId(prefix: string, localId: string): string {
	const suffix = localId
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
	if (!suffix) throw new Error(`Cannot derive a place ID from station '${localId}'`);
	return `${prefix}${suffix}`;
}

/** Materialize feed-derived places without mutating the previous static generation. */
export function materializeSameStationIdPlaces(config: TraxConfig, stops: Stop[]): TraxConfig {
	const availableMembers = new Set(stops.map((stop) => entityKey({ feedId: stop.feed_id, localId: stop.stop_id })));
	const places = (config.network.places ?? [])
		.map((place) => ({
			...place,
			members: place.members.filter((member) => availableMembers.has(entityKey(member))).map((member) => ({ ...member })),
		}))
		.filter((place) => place.members.length > 0);
	const placeById = new Map(places.map((place) => [place.id, place]));
	const placeByMember = new Map<string, PlaceDefinition>();
	for (const place of places) {
		for (const member of place.members) placeByMember.set(entityKey(member), place);
	}

	for (const rule of config.network.sameStationIdPlaces ?? []) {
		const [leftFeedId, rightFeedId] = rule.feedIds;
		const leftStations = stationStopsById(stops, leftFeedId);
		const rightStations = stationStopsById(stops, rightFeedId);
		for (const localId of [...leftStations.keys()].filter((id) => rightStations.has(id)).sort()) {
			const left = leftStations.get(localId)!;
			const right = rightStations.get(localId)!;
			const distance = stationDistanceMeters(left, right);
			if (distance === null || distance > rule.maxDistanceMeters) continue;
			const members = rule.feedIds.map((feedId) => ({ feedId, localId }));
			const existingPlaces = new Set(
				members.flatMap((member) => {
					const place = placeByMember.get(entityKey(member));
					return place ? [place] : [];
				}),
			);
			if (existingPlaces.size > 1) {
				throw new Error(
					`Matching station '${localId}' belongs to multiple configured places in network '${config.network.id}'`,
				);
			}

			let place = [...existingPlaces][0];
			if (!place) {
				const id = generatedPlaceId(rule.placeIdPrefix, localId);
				if (!id || placeById.has(id)) {
					throw new Error(`Derived place '${id}' conflicts in network '${config.network.id}'`);
				}
				const canonicalStop = rule.canonicalFeedId === leftFeedId ? left : right;
				place = { id, name: canonicalStop.stop_name ?? localId, members: [] };
				places.push(place);
				placeById.set(id, place);
			}
			for (const member of members) {
				const key = entityKey(member);
				if (placeByMember.has(key)) continue;
				place.members.push(member);
				placeByMember.set(key, place);
			}
		}
	}

	return { ...config, places, placeByMember };
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
export function resolveTripNumber(
	network: NetworkDefinition,
	trip: Pick<Trip, "feed_id" | "trip_id" | "trip_short_name">,
	realtime?: TripRealtimeContext,
): string {
	const configured = network.feeds
		.find((feed) => feed.id === trip.feed_id)
		?.tripNumber?.(trip, realtime)
		?.trim();
	if (configured) return configured;
	return trip.trip_short_name && /^\d{1,3}$/.test(trip.trip_short_name)
		? trip.trip_short_name
		: trip.trip_id.slice(-4);
}
