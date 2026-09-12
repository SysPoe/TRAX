import { CacheContext, getAugmentedStops } from "../cache/index.js";
import * as cache from "../cache/index.js";
import { AugmentedStop } from "./augmentedStop.js";
import * as qdf from "qdf-gtfs";
import logger from "./logger.js";
import { cacheFileExists, loadCacheFile, writeCacheFileAtomic } from "./fs.js";
import { entityKey, parseEntityKey } from "../identity.js";
import { isRailLikeRouteType } from "./considered.js";
import { getStaticFeedFingerprint } from "./SRT.js";

type ConsideredStationsCache = {
	feedIds: string[];
	stationIds: string[];
	staticFingerprint: string | null;
};

function getConfiguredFeedIds(ctx: CacheContext): string[] {
	return ctx.config.network.feeds.map((feed) => feed.id).sort();
}

function hasSameFeedIds(cached: string[], configured: string[]): boolean {
	return cached.length === configured.length && cached.every((feedId, index) => feedId === configured[index]);
}

function cachedStationIdsIfCurrent(
	cached: ConsideredStationsCache | string[],
	configuredFeedIds: string[],
	staticFingerprint: string | null,
): string[] | null {
	if (staticFingerprint === null || Array.isArray(cached)) return null;
	if (!hasSameFeedIds(cached.feedIds, configuredFeedIds)) return null;
	return cached.staticFingerprint === staticFingerprint ? cached.stationIds : null;
}

function getPatternSignature(stopTimes: qdf.StopTime[]): string {
	return stopTimes.map((st) => entityKey({ feedId: st.feed_id, localId: st.stop_id })).join("|");
}

export function getConsideredStations(ctx: CacheContext): qdf.Stop[] {
	if (ctx.augmented.railStations.length > 0) {
		return ctx.augmented.railStations;
	}

	if (!ctx.gtfs) throw new Error("GTFS not initialized!");
	const gtfs = ctx.gtfs;
	const cacheDir = ctx.config.cacheDir;
	const configuredFeedIds = getConfiguredFeedIds(ctx);
	const staticFingerprint = getStaticFeedFingerprint(ctx.config);

	let stations: string[] | null = null;

	if (cacheFileExists("considered_stations_v2.json", cacheDir)) {
		const cached = JSON.parse(loadCacheFile("considered_stations_v2.json", cacheDir)) as
			| ConsideredStationsCache
			| string[];
		stations = cachedStationIdsIfCurrent(cached, configuredFeedIds, staticFingerprint);
	}

	if (stations === null) {
		stations = [];
		let included: { [key: string]: boolean } = {};
		let seen: { [key: string]: boolean } = {};
		let startTime = Date.now();

		const processTrip = (trip: qdf.Trip) => {
			if (!isRailLikeRouteType(cache.getRawRoute(ctx, { feedId: trip.feed_id, localId: trip.route_id })?.route_type)) return;

			const stopTimes = cache.getRawStopTimes(ctx, { feedId: trip.feed_id, localId: trip.trip_id });
			const sig = getPatternSignature(stopTimes);
			if (seen[sig]) return;
			seen[sig] = true;

			stopTimes.forEach((st: qdf.StopTime) => {
				const stop = cache.getRawStop(ctx, { feedId: st.feed_id, localId: st.stop_id });
				if (stop) {
					const stationId = entityKey({ feedId: stop.feed_id, localId: stop.parent_station ?? stop.stop_id });
					if (!included[stationId]) {
						included[stationId] = true;
						stations!.push(stationId);
					}
				}
			});
		};

		if (ctx.augmented.trips.length > 0) {
			ctx.augmented.trips.forEach((at) => processTrip(at));
		} else {
			gtfs.getTrips().forEach(processTrip);
		}

		writeCacheFileAtomic(
			"considered_stations_v2.json",
			JSON.stringify({
				feedIds: configuredFeedIds,
				stationIds: stations,
				staticFingerprint,
			} satisfies ConsideredStationsCache),
			cacheDir,
		);

		logger.debug(`Loaded considered_stations in ${Date.now() - startTime}ms`, { module: "SRT" });
	}

	const result = stations.map((value) => {
		const ref = parseEntityKey(value);
		return cache.getRawStop(ctx, ref);
	}).filter((v) => v) as qdf.Stop[];

	if (ctx) {
		ctx.augmented.railStations = result;
	}

	return result;
}

export const _test = { cachedStationIdsIfCurrent };

export function getAugmentedRailStations(ctx: CacheContext): AugmentedStop[] {
	return getConsideredStations(ctx)
		.map((stop) => getAugmentedStops(ctx, { feedId: stop.feed_id, localId: stop.stop_id })[0])
		.filter((v) => v);
}
