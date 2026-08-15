import logger from "./logger.js";
import { cacheFileExists, deleteCacheFile, loadCacheFile, writeCacheFile } from "./fs.js";
import * as cache from "../cache/index.js";
import * as qdf from "qdf-gtfs";
import { canonicalStationIdentity, type TraxConfig } from "../config.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { entityKey, parseEntityKey } from "../identity.js";
import type { QualifiedEntityId } from "qdf-gtfs";
import { interpolateTimes as wasmInterpolateTimes } from "../../build/release.js";
import { isRailLikeRouteType } from "./considered.js";

export type SRTMatrix = {
	[from: string]: {
		[to: string]: number;
	};
};

export interface ExpressInfo {
	type: "express" | "local" | "unknown_segment";
	from: string;
	to: string;
	skipping?: string[];
	message?: string;
}

export interface PassingStopSRT {
	from: string;
	to: string;
	emu: number;
	passing: boolean;
}

interface NetworkData {
	matrix: SRTMatrix;
	adjacency: Record<string, string[]>;
	lastUpdated: number;
	staticFingerprint?: string;
	topologyVersion?: number;
}

const CACHE_FILE = "network_topology.json";
const MAX_CACHE_AGE_DAYS = 7;
const TOPOLOGY_CACHE_VERSION = 3;

function loadNetworkData(ctx: cache.CacheContext): NetworkData | null {
	const cacheDir = ctx.config.cacheDir;
	if (cacheFileExists(CACHE_FILE, cacheDir)) {
		try {
			const data = JSON.parse(loadCacheFile(CACHE_FILE, cacheDir));
			const ageDays = (Date.now() - (data.lastUpdated ?? 0)) / (1000 * 60 * 60 * 24);
			if (
				ctx.runtimeState.srtExpectedStaticFingerprint !== null &&
				data.topologyVersion === TOPOLOGY_CACHE_VERSION &&
				data.staticFingerprint === ctx.runtimeState.srtExpectedStaticFingerprint &&
				ageDays < MAX_CACHE_AGE_DAYS
			) {
				return data;
			}
			logger.debug("Network topology cache is stale for the loaded static feed, regenerating...");
		} catch (e) {
			logger.error("Failed to parse network topology cache: " + (e as Error).message);
		}
	}
	return null;
}

function canonicalStationKey(config: TraxConfig, station: QualifiedEntityId): string {
	return entityKey(canonicalStationIdentity(config, station));
}

function finiteTime(value: number | null | undefined): number | null {
	return value != null && Number.isFinite(value) ? value : null;
}

/**
 * Derive one duration per edge without treating untimed GTFS passing points as
 * midnight. A timed span containing passing points is divided by shape distance
 * when available, or evenly when the feed does not provide usable distances.
 */
function getPatternEdgeTimes(stopTimes: qdf.StopTime[]): number[] {
	const edgeTimes = new Array(stopTimes.length).fill(0);
	const timedIndexes = stopTimes.flatMap((stopTime, index) =>
		finiteTime(stopTime.arrival_time) != null || finiteTime(stopTime.departure_time) != null ? [index] : [],
	);

	for (let anchor = 0; anchor < timedIndexes.length - 1; anchor++) {
		const fromIndex = timedIndexes[anchor];
		const toIndex = timedIndexes[anchor + 1];
		const from = stopTimes[fromIndex];
		const to = stopTimes[toIndex];
		const startTime = finiteTime(from.departure_time) ?? finiteTime(from.arrival_time);
		const endTime = finiteTime(to.arrival_time) ?? finiteTime(to.departure_time);
		if (startTime == null || endTime == null || endTime <= startTime) continue;

		const distances: number[] = [];
		for (let i = fromIndex + 1; i <= toIndex; i++) {
			const previousDistance = stopTimes[i - 1].shape_dist_traveled;
			const currentDistance = stopTimes[i].shape_dist_traveled;
			const distance =
				previousDistance != null &&
				currentDistance != null &&
				Number.isFinite(previousDistance) &&
				Number.isFinite(currentDistance)
					? currentDistance - previousDistance
					: 0;
			distances.push(distance);
		}

		const useDistances = distances.every((distance) => distance > 0);
		const weights = useDistances ? distances : distances.map(() => 1);
		const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
		const elapsedMinutes = (endTime - startTime) / 60;
		for (let i = fromIndex + 1; i <= toIndex; i++) {
			edgeTimes[i] = elapsedMinutes * (weights[i - fromIndex - 1] / totalWeight);
		}
	}

	return edgeTimes;
}

function generateNetworkData(ctx: cache.CacheContext): NetworkData {
	if (!ctx.gtfs) throw new Error("GTFS not initialized!");
	const gtfs = ctx.gtfs;
	const timer = ctx.augmented.timer;
	timer.start("SRT:generateNetworkData");
	const trips = gtfs.getTrips();
	const railTrips = trips.filter((t) =>
		isRailLikeRouteType(gtfs.getRoutes({ feed_id: t.feed_id, route_id: t.route_id })[0]?.route_type),
	);

	const uniquePatterns: { id: string; timeFromPrev: number }[][] = [];
	const seenSignatures = new Set<string>();

	logger.debug("Extracting unique stopping patterns...", {
		module: "topology",
	});

	railTrips.forEach((trip) => {
		const stopTimes = gtfs.getStopTimes({ feed_id: trip.feed_id, trip_id: trip.trip_id });
		const edgeTimes = getPatternEdgeTimes(stopTimes);
		const stops = stopTimes.map((st: qdf.StopTime, i: number) => {
			const stop = gtfs.getStops({ feed_id: st.feed_id, stop_id: st.stop_id })[0];
			const id = canonicalStationKey(ctx.config, {
				feedId: st.feed_id,
				localId: stop ? (stop.parent_station ?? stop.stop_id) : st.stop_id,
			});

			return { id, timeFromPrev: edgeTimes[i] };
		});
		const signature = stops.map((stop) => stop.id).join("|");
		if (seenSignatures.has(signature)) return;
		seenSignatures.add(signature);

		uniquePatterns.push(stops);
	});

	const validEdges = new Set<string>();
	uniquePatterns.forEach((pattern) => {
		for (let i = 0; i < pattern.length - 1; i++) {
			validEdges.add(`${pattern[i].id}|${pattern[i + 1].id}`);
		}
	});

	logger.debug(`Found ${validEdges.size} potential edges. Pruning express skips...`, {
		module: "topology",
	});

	uniquePatterns.forEach((pattern) => {
		for (let i = 0; i < pattern.length - 2; i++) {
			const startNode = pattern[i].id;
			for (let j = i + 2; j < pattern.length; j++) {
				const endNode = pattern[j].id;
				const skipKey = `${startNode}|${endNode}`;
				if (validEdges.has(skipKey)) {
					validEdges.delete(skipKey);
				}
			}
		}
	});

	for (const plugin of ctx.config.network.plugins) plugin.filterTrackEdges?.(validEdges);

	logger.debug(`Reduced to ${validEdges.size} physical edges. Building graph and matrix...`, {
		module: "topology",
	});

	const matrix: SRTMatrix = {};
	const adjacency: Record<string, string[]> = {};
	const segmentStats = new Map<string, { total: number; count: number }>();

	uniquePatterns.forEach((pattern) => {
		for (let i = 0; i < pattern.length - 1; i++) {
			const from = pattern[i].id;
			const to = pattern[i + 1].id;
			const key = `${from}|${to}`;

			if (validEdges.has(key)) {
				if (!adjacency[from]) adjacency[from] = [];
				if (!adjacency[from].includes(to)) adjacency[from].push(to);

				if (!adjacency[to]) adjacency[to] = [];
				if (!adjacency[to].includes(from)) adjacency[to].push(from);

				const time = pattern[i + 1].timeFromPrev;
				if (time <= 0) continue;

				const entry = segmentStats.get(key);
				if (entry) {
					entry.total += time;
					entry.count++;
				} else {
					segmentStats.set(key, { total: time, count: 1 });
				}
			}
		}
	});

	// The graph and matrix must describe the same physical edges. Keep a neutral
	// weight for edge-only feed data that has neither usable times nor distances.
	for (const key of validEdges) {
		const [from, to] = key.split("|");
		if (!segmentStats.has(key) && !segmentStats.has(`${to}|${from}`)) {
			segmentStats.set(key, { total: 1, count: 1 });
		}
	}

	for (const [key, stats] of segmentStats.entries()) {
		const [from, to] = key.split("|");
		const avg = stats.total / stats.count;

		if (!matrix[from]) matrix[from] = {};
		matrix[from][to] = parseFloat(avg.toFixed(2));

		if (!matrix[to]) matrix[to] = {};
		if (!matrix[to][from]) matrix[to][from] = parseFloat(avg.toFixed(2));
	}

	for (const plugin of ctx.config.network.plugins) plugin.enrichTrackGraph?.(matrix, adjacency);

	const result = {
		matrix,
		adjacency,
		lastUpdated: Date.now(),
		staticFingerprint: ctx.runtimeState.srtExpectedStaticFingerprint ?? undefined,
		topologyVersion: TOPOLOGY_CACHE_VERSION,
	};
	writeCacheFile(CACHE_FILE, JSON.stringify(result), ctx.config.cacheDir);
	timer.stop("SRT:generateNetworkData");
	return result;
}

function ensureDataLoaded(ctx: cache.CacheContext) {
	let networkData = ctx.runtimeState.srtNetworkData as NetworkData | null;
	if (!networkData) {
		networkData = loadNetworkData(ctx);
		if (!networkData) {
			networkData = generateNetworkData(ctx);
		}
		ctx.runtimeState.srtNetworkData = networkData;
	}
}

export function getSRT(from: string, to: string, ctx: cache.CacheContext): number | undefined {
	ensureDataLoaded(ctx);
	if ((from == "place_exhsta" && to == "place_bowsta") || (from == "place_bowsta" && to == "place_exhsta")) return 3;

	const networkData = ctx.runtimeState.srtNetworkData as NetworkData;
	return networkData.matrix[from]?.[to] ?? networkData.matrix[to]?.[from];
}

function getGraph(ctx: cache.CacheContext): Record<string, string[]> {
	ensureDataLoaded(ctx);
	return (ctx.runtimeState.srtNetworkData as NetworkData).adjacency;
}

function findPathBFS(start: string, end: string, ctx: cache.CacheContext): string[] | null {
	const cacheKey = `${start}|${end}`;
	if (ctx.runtimeState.srtBfs.has(cacheKey)) {
		return ctx.runtimeState.srtBfs.get(cacheKey)!;
	}

	const graph = getGraph(ctx);
	const queue: string[][] = [[start]];
	const visited = new Set([start]);
	let path: string[] | null = null;
	while (queue.length > 0) {
		const candidate = queue.shift()!;
		const node = candidate[candidate.length - 1];
		if (node === end) {
			path = candidate;
			break;
		}
		for (const neighbor of graph[node] ?? []) {
			if (visited.has(neighbor)) continue;
			visited.add(neighbor);
			queue.push([...candidate, neighbor]);
		}
	}
	ctx.runtimeState.srtBfs.set(cacheKey, path);
	return path;
}

export function findExpress(givenStops: string[], ctx: cache.CacheContext): ExpressInfo[] {
	const timer = ctx.augmented.timer;
	timer.start("SRT:findExpress");
	const result: ExpressInfo[] = [];

	const canonicalStops = givenStops.map((stop) => canonicalStationKey(ctx.config, parseEntityKey(stop)));
	for (let i = 0; i < canonicalStops.length - 1; i++) {
		const startStop = canonicalStops[i];
		const endStop = canonicalStops[i + 1];

		const physicalPath = findPathBFS(startStop, endStop, ctx);

		if (physicalPath) {
			if (physicalPath.length === 2) {
				result.push({
					type: "local",
					from: startStop,
					to: endStop,
				});
			} else if (physicalPath.length > 2) {
				const skippedStops = physicalPath.slice(1, physicalPath.length - 1);
				result.push({
					type: "express",
					from: startStop,
					to: endStop,
					skipping: skippedStops,
				});
			}
		} else {
			result.push({
				type: "unknown_segment",
				from: startStop,
				to: endStop,
				message: "No physical track connection found.",
			});
		}
	}
	timer.stop("SRT:findExpress");
	return result;
}

export function findExpressString(
	expressData: ExpressInfo[],
	ctx: cache.CacheContext,
	stop: QualifiedEntityId | null = null,
): string {
	const stop_id = stop ? canonicalStationKey(ctx.config, stop) : null;
	if (stop_id != null)
		expressData = expressData.slice(
			expressData.findIndex((v) => v.from === stop_id || v.skipping?.includes(stop_id) || v.to === stop_id),
		);

	expressData = expressData.filter((v) => v.type !== "local");

	if (expressData.length === 0) return "All stops";

	const segments = expressData.reduce(
		(acc, segment, index) => {
			if (index === 0 || segment.from !== acc[acc.length - 1].to) {
				acc.push({
					from: segment.from,
					to: segment.to,
					stoppingAt: [],
				});
			} else {
				acc[acc.length - 1].stoppingAt.push(segment.from);
				acc[acc.length - 1].to = segment.to;
			}
			return acc;
		},
		[] as { from: string; to: string; stoppingAt: string[] }[],
	);

	return (
		"Running express " +
		segments
			.map((run) => {
				const startRef = parseEntityKey(run.from);
				const endRef = parseEntityKey(run.to);
				const startName = (
					ctx.augmented.stopsRec.get(run.from)?.stop_name ?? cache.getRawStops(ctx, { feed_id: startRef.feedId, stop_id: startRef.localId })[0]?.stop_name
				)?.replace(" station", "");
				const endName = (
					ctx.augmented.stopsRec.get(run.to)?.stop_name ?? cache.getRawStops(ctx, { feed_id: endRef.feedId, stop_id: endRef.localId })[0]?.stop_name
				)?.replace(" station", "");
				const stoppingAtNames = run.stoppingAt.map((stopId) => {
					const ref = parseEntityKey(stopId);
					return (
						ctx.augmented.stopsRec.get(stopId)?.stop_name ?? cache.getRawStops(ctx, { feed_id: ref.feedId, stop_id: ref.localId })[0]?.stop_name
					)?.replace(" station", "");
				});
				const formattedStoppingAtNames =
					stoppingAtNames.length <= 1
						? stoppingAtNames[0]
						: stoppingAtNames.length == 2
							? `${stoppingAtNames[0]} and ${stoppingAtNames[1]}`
							: `${stoppingAtNames.slice(0, -1).join(", ")}, and ${stoppingAtNames[stoppingAtNames.length - 1]}`;

				return stop_id !== null &&
					(run.from === canonicalStationKey(ctx.config, { feedId: stop!.feedId, localId: cache.getRawStops(ctx, { feed_id: stop!.feedId, stop_id: stop!.localId })[0]?.parent_station ?? stop!.localId }) || run.from == stop_id)
					? run.stoppingAt.length > 0
						? `to ${endName}, stopping only at ${formattedStoppingAtNames}`
						: `to ${endName}`
					: run.stoppingAt.length > 0
						? `between ${startName} and ${endName}, stopping only at ${formattedStoppingAtNames}`
						: `between ${startName} and ${endName}`;
			})
			.join("; ")
	);
}

export type PassingStop = { stop_id: string; passing: boolean };

function findPassingStops(stops: string[], ctx: cache.CacheContext): PassingStop[] {
	const stopListHash = stops.join("|");
	const cached = cache.getCachedPassingStops(ctx, stopListHash);
	if (cached) return cached;

	const expressSegments = findExpress(stops, ctx);
	const allStops: PassingStop[] = [];

	const addStop = (id: string, passing: boolean) => {
		if (allStops.at(-1)?.stop_id !== id) {
			allStops.push({ stop_id: id, passing });
		}
	};

	for (const segment of expressSegments) {
		if (segment.type === "unknown_segment") {
			if (segment.from && segment.from.trim() !== "" && segment.to && segment.to.trim() !== "")
				logger.warn(`Unknown segment between ${segment.from} and ${segment.to}: ${segment.message}`, {
					module: "augmentedStopTime",
					function: "findPassingStops",
				});

			continue;
		}

		if (segment.type === "local") {
			addStop(segment.from, false);
			addStop(segment.to, false);
			continue;
		}

		addStop(segment.from, false);
		segment.skipping?.forEach((s) => addStop(s, true));
		addStop(segment.to, false);
	}

	cache.cachePassingStops(ctx, stopListHash, allStops);
	return allStops;
}

function findPassingStopSRTs(stops: string[], ctx: cache.CacheContext): PassingStopSRT[] {
	const allStops = findPassingStops(stops, ctx);
	const results: PassingStopSRT[] = [];

	for (let i = 0; i < allStops.length - 1; i++) {
		const from = allStops[i].stop_id;
		const to = allStops[i + 1].stop_id;
		const srt = getSRT(from, to, ctx);

		if (srt === undefined) {
			const key = `${from}|${to}`;
			if (!ctx.runtimeState.loggedMissingSrt.has(key)) {
				logger.warn(`No SRT found between ${from} and ${to}`, {
					module: "augmentedStopTime",
					function: "findPassingStopSRTs",
				});
				ctx.runtimeState.loggedMissingSrt.add(key);
			}
			results.push({ from, to, emu: 1, passing: allStops[i + 1].passing });
		} else {
			results.push({ from, to, emu: srt, passing: allStops[i + 1].passing });
		}
	}
	return results;
}

function getStopOrParentId(stopTime: qdf.StopTime, ctx: cache.CacheContext): string | undefined {
	const key = entityKey({ feedId: stopTime.feed_id, localId: stopTime.stop_id });
	const s =
		ctx.augmented.stopsRec.get(key) ??
		cache.getRawStops(ctx, { feed_id: stopTime.feed_id, stop_id: stopTime.stop_id })?.[0];
	return s
		? canonicalStationKey(ctx.config, { feedId: s.feed_id, localId: s.parent_station ?? s.stop_id })
		: undefined;
}

/** emu weights for wasmInterpolateTimes (length = passing legs + 1); only set on synthetic passing rows. */
export type StopTimeWithPassingMeta = qdf.StopTime & {
	_passing: boolean;
	_segmentEmus?: number[];
};

export function findPassingStopTimes(stopTimes: qdf.StopTime[], ctx: cache.CacheContext): StopTimeWithPassingMeta[] {
	if (stopTimes.length === 0) return [];

	const sortedStopTimes = [...stopTimes].sort((a, b) => (a.stop_sequence ?? 0) - (b.stop_sequence ?? 0));
	const stops = sortedStopTimes
		.map((st) => getStopOrParentId(st, ctx))
		.filter((v): v is string => v !== undefined);

	const idsToTimes: Record<string, qdf.StopTime> = {};
	for (const st of stopTimes) {
		const parent = getStopOrParentId(st, ctx);
		if (parent) idsToTimes[parent] = st;
	}

	const passingSRTs = findPassingStopSRTs(stops, ctx);
	if (!passingSRTs.length) {
		return sortedStopTimes.map((v) => ({ ...v, _passing: false }));
	}

	let resultTimes: StopTimeWithPassingMeta[] = [{ ...idsToTimes[passingSRTs[0].from], _passing: false }];
	let currentPassingRun: PassingStopSRT[] = [];

	for (const srt of passingSRTs) {
		if (srt.passing) {
			currentPassingRun.push(srt);
			continue;
		}

		if (currentPassingRun.length === 0) {
			if (idsToTimes[srt.to]) {
				resultTimes.push({ ...idsToTimes[srt.to], _passing: false });
			}
			continue;
		}

		const startTime = resultTimes.at(-1);
		const endTime = idsToTimes[srt.to];

		if (
			startTime?.departure_time === undefined ||
			startTime?.departure_time === null ||
			endTime?.arrival_time === undefined ||
			endTime?.arrival_time === null
		) {
			if (endTime) resultTimes.push({ ...endTime, _passing: false });
			currentPassingRun = [];
			continue;
		}

		const segmentEmus = [...currentPassingRun.map((r) => r.emu), srt.emu];
		const interpolatedTimes = wasmInterpolateTimes(startTime.departure_time, endTime.arrival_time, segmentEmus);

		for (let i = 0; i < currentPassingRun.length; i++) {
			const run = currentPassingRun[i];
			const interpolatedTime = interpolatedTimes[i];

			const passingStop = parseEntityKey(run.to);
			resultTimes.push({
				_passing: true,
				_segmentEmus: segmentEmus,
				stop_id: passingStop.localId,
				trip_id: stopTimes[0].trip_id,
				stop_sequence:
					(startTime.stop_sequence ?? 0) +
					((i + 1) * ((endTime.stop_sequence ?? 0) - (startTime.stop_sequence ?? 0))) /
						(currentPassingRun.length + 1),
				departure_time: interpolatedTime,
				arrival_time: interpolatedTime,
				drop_off_type: 1,
				pickup_type: 1,
				continuous_drop_off: 0,
				continuous_pickup: 0,
				shape_dist_traveled: -1,
				stop_headsign: "",
				timepoint: 0,
				feed_id: passingStop.feedId,
			});
		}

		resultTimes.push({ ...endTime, _passing: false });
		currentPassingRun = [];
	}

	return resultTimes;
}

export default {
	findExpress,
	findExpressString,
	getSRT,
	findPassingStopTimes,
};

export const _test = {
	getPatternEdgeTimes,
};

/**
 * Fingerprint the exact QDF static ZIP cache entries plus TRAX's static stop
 * actions. QDF keys those files by md5(url|headers|archiveEntry), so stat identity is cheap
 * to obtain and changes whenever QDF replaces a cached feed.
 */
export function getStaticFeedFingerprint(config: TraxConfig): string | null {
	const hash = crypto.createHash("sha256");
	hash.update(config.network.id);
	hash.update(JSON.stringify(config.mergeStops));
	hash.update(JSON.stringify(config.updateStopActions));
	hash.update(JSON.stringify(config.network.places ?? []));

	for (const feed of config.network.feeds) {
		const feedConfig = feed.staticSource;
		const keySource = `${feedConfig.url}|${JSON.stringify(feedConfig.headers ?? {})}|${feedConfig.archiveEntry ?? ""}`;
		const cacheName = crypto.createHash("md5").update(keySource).digest("hex");
		const cachePath = path.join(config.cacheDir, cacheName);
		try {
			const stat = fs.statSync(cachePath, { bigint: true });
			hash.update(cacheName);
			hash.update(String(stat.size));
			hash.update(String(stat.mtimeNs));
		} catch {
			return null;
		}
	}

	return hash.digest("hex");
}

/**
 * Reset process-local graph state for a newly loaded static generation while
 * preserving the disk cache only when it can be matched to that exact feed.
 */
export function resetNetworkTopologyForStaticFeed(ctx: cache.CacheContext): void {
	ctx.runtimeState.srtNetworkData = null;
	ctx.runtimeState.srtBfs.clear();
	ctx.runtimeState.loggedMissingSrt.clear();
	ctx.runtimeState.srtExpectedStaticFingerprint = getStaticFeedFingerprint(ctx.config);
	if (ctx.runtimeState.srtExpectedStaticFingerprint === null) deleteCacheFile(CACHE_FILE, ctx.config.cacheDir);
}

/** Clears in-memory rail topology and deletes the on-disk cache explicitly. */
export function invalidateNetworkTopologyCache(ctx: cache.CacheContext): void {
	ctx.runtimeState.srtNetworkData = null;
	ctx.runtimeState.srtBfs.clear();
	ctx.runtimeState.loggedMissingSrt.clear();
	ctx.runtimeState.srtExpectedStaticFingerprint = null;
	deleteCacheFile(CACHE_FILE, ctx.config.cacheDir);
}
