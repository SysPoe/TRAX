import logger from "./logger.js";
import { getGtfs } from "../gtfsInterfaceLayer.js";
import { cacheFileExists, loadCacheFile, writeCacheFile } from "./fs.js";
import * as cache from "../cache.js";
import * as qdf from "qdf-gtfs";

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
}

let _networkData: NetworkData | null = null;
const CACHE_FILE = "network_topology.json";
const MAX_CACHE_AGE_DAYS = 7;

function loadNetworkData(ctx: cache.CacheContext): NetworkData | null {
	const cacheDir = ctx.config.cacheDir;
	if (cacheFileExists(CACHE_FILE, cacheDir)) {
		try {
			const data = JSON.parse(loadCacheFile(CACHE_FILE, cacheDir));
			const ageDays = (Date.now() - (data.lastUpdated ?? 0)) / (1000 * 60 * 60 * 24);
			if (ageDays < MAX_CACHE_AGE_DAYS) {
				return data;
			}
			logger.debug("Network topology cache expired, regenerating...");
		} catch (e) {
			logger.error("Failed to parse network topology cache: " + (e as Error).message);
		}
	}
	return null;
}

function getPatternSignature(stopTimes: any[]): string {
	return stopTimes.map((st) => st.stop_id).join("|");
}

function generateNetworkData(ctx: cache.CacheContext): NetworkData {
	const gtfs = ctx.gtfs ?? getGtfs();
	const trips = gtfs.getTrips();
	const railTrips = trips.filter((t) => gtfs.getRoute(t.route_id)?.route_type === 2);

	const uniquePatterns: any[][] = [];
	const seenSignatures = new Set<string>();

	logger.debug("Topology: Extracting unique stopping patterns...");

	railTrips.forEach((trip) => {
		const stopTimes = gtfs.getStopTimesForTrip(trip.trip_id);
		const signature = getPatternSignature(stopTimes);

		if (seenSignatures.has(signature)) return;
		seenSignatures.add(signature);

		const stops = stopTimes.map((st, i) => {
			const stop = gtfs.getStop(st.stop_id);
			const id = stop ? (stop.parent_station ?? stop.stop_id) : st.stop_id;

			let timeFromPrev = 0;
			if (i > 0) {
				const prev = stopTimes[i - 1];
				const currTime = st.arrival_time ?? st.departure_time ?? 0;
				const prevTime = prev.departure_time ?? prev.arrival_time ?? 0;
				timeFromPrev = (currTime - prevTime) / 60;
			}

			return { id, timeFromPrev };
		});

		uniquePatterns.push(stops);
	});

	const validEdges = new Set<string>();
	uniquePatterns.forEach((pattern) => {
		for (let i = 0; i < pattern.length - 1; i++) {
			validEdges.add(`${pattern[i].id}|${pattern[i + 1].id}`);
		}
	});

	logger.debug(`Topology: Found ${validEdges.size} potential edges. Pruning express skips...`);

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

	logger.debug(`Topology: Reduced to ${validEdges.size} physical edges. Building graph and matrix...`);

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

	for (const [key, stats] of segmentStats.entries()) {
		const [from, to] = key.split("|");
		const avg = stats.total / stats.count;

		if (!matrix[from]) matrix[from] = {};
		matrix[from][to] = parseFloat(avg.toFixed(2));

		if (!matrix[to]) matrix[to] = {};
		if (!matrix[to][from]) matrix[to][from] = parseFloat(avg.toFixed(2));
	}

	const result = { matrix, adjacency, lastUpdated: Date.now() };
	writeCacheFile(CACHE_FILE, JSON.stringify(result), ctx.config.cacheDir);
	return result;
}

function ensureDataLoaded(ctx: cache.CacheContext) {
	if (!_networkData) {
		_networkData = loadNetworkData(ctx);
		if (!_networkData) {
			_networkData = generateNetworkData(ctx);
		}
	}
}

export function getSRT(from: string, to: string, ctx: cache.CacheContext): number | undefined {
	ensureDataLoaded(ctx);
	if ((from == "place_exhsta" && to == "place_bowsta") || (from == "place_bowsta" && to == "place_exhsta")) return 3;

	return _networkData!.matrix[from]?.[to] ?? _networkData!.matrix[to]?.[from];
}

function getGraph(ctx: cache.CacheContext): Record<string, string[]> {
	ensureDataLoaded(ctx);
	return _networkData!.adjacency;
}

function findPathBFS(start: string, end: string, ctx: cache.CacheContext): string[] | null {
	const graph = getGraph(ctx);
	if (!graph[start] || !graph[end]) return null;
	if (start === end) return [start];

	const queue: { stop: string; path: string[] }[] = [{ stop: start, path: [start] }];
	const visited = new Set<string>([start]);

	while (queue.length > 0) {
		const { stop: currentStop, path: currentPath } = queue.shift()!;
		const neighbors = graph[currentStop];

		if (neighbors) {
			for (const neighbor of neighbors) {
				if (!visited.has(neighbor)) {
					visited.add(neighbor);
					const newPath = [...currentPath, neighbor];
					if (neighbor === end) return newPath;
					queue.push({ stop: neighbor, path: newPath });
				}
			}
		}
	}
	return null;
}

export function findExpress(givenStops: string[], ctx: cache.CacheContext): ExpressInfo[] {
	const result: ExpressInfo[] = [];

	for (let i = 0; i < givenStops.length - 1; i++) {
		const startStop = givenStops[i];
		const endStop = givenStops[i + 1];

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
	return result;
}

export function findExpressString(
	expressData: ExpressInfo[],
	ctx: cache.CacheContext,
	stop_id: string | null = null,
): string {
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
				const startName = cache.getRawStops(ctx, run.from)[0]?.stop_name?.replace(" station", "");
				const endName = cache.getRawStops(ctx, run.to)[0]?.stop_name?.replace(" station", "");
				const stoppingAtNames = run.stoppingAt.map((stopId) =>
					cache.getRawStops(ctx, stopId)[0]?.stop_name?.replace(" station", ""),
				);
				const formattedStoppingAtNames =
					stoppingAtNames.length <= 1
						? stoppingAtNames[0]
						: stoppingAtNames.length == 2
							? `${stoppingAtNames[0]} and ${stoppingAtNames[1]}`
							: `${stoppingAtNames.slice(0, -1).join(", ")}, and ${stoppingAtNames[stoppingAtNames.length - 1]}`;

				return stop_id !== null &&
					(run.from == cache.getRawStops(ctx, stop_id)[0]?.parent_station || run.from == stop_id)
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

const loggedMissingSRT = new Set<string>();

function findPassingStops(stops: string[], ctx: cache.CacheContext): { stop_id: string; passing: boolean }[] {
	const stopListHash = stops.join("|");
	const cached = cache.getCachedPassingStops(ctx, stopListHash);
	if (cached) return cached;

	const expressSegments = findExpress(stops, ctx);
	const allStops: { stop_id: string; passing: boolean }[] = [];

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
			if (!loggedMissingSRT.has(key)) {
				logger.warn(`No SRT found between ${from} and ${to}`, {
					module: "augmentedStopTime",
					function: "findPassingStopSRTs",
				});
				loggedMissingSRT.add(key);
			}
			results.push({ from, to, emu: 1, passing: allStops[i + 1].passing });
		} else {
			results.push({ from, to, emu: srt, passing: allStops[i + 1].passing });
		}
	}
	return results;
}

function getStopOrParentId(stopId: string, ctx: cache.CacheContext): string | undefined {
	const s = cache.getRawStops(ctx, stopId)?.[0];
	return s ? (s.parent_station ?? s.stop_id) : undefined;
}

export function findPassingStopTimes(
	stopTimes: qdf.StopTime[],
	ctx: cache.CacheContext,
): (qdf.StopTime & { _passing: boolean })[] {
	if (stopTimes.length === 0) return [];

	const sortedStopTimes = [...stopTimes].sort((a, b) => (a.stop_sequence ?? 0) - (b.stop_sequence ?? 0));
	const stops = sortedStopTimes
		.map((st) => getStopOrParentId(st.stop_id, ctx))
		.filter((v): v is string => v !== undefined);

	const idsToTimes: Record<string, qdf.StopTime> = {};
	for (const st of stopTimes) {
		const parent = getStopOrParentId(st.stop_id, ctx);
		if (parent) idsToTimes[parent] = st;
	}

	const passingSRTs = findPassingStopSRTs(stops, ctx);
	if (!passingSRTs.length) {
		return sortedStopTimes.map((v) => ({ ...v, _passing: false }));
	}

	type PassingResult = qdf.StopTime & { _passing: boolean };

	let resultTimes: PassingResult[] = [{ ...idsToTimes[passingSRTs[0].from], _passing: false }];
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

		if (!startTime?.departure_time || !endTime?.departure_time) {
			if (endTime) resultTimes.push({ ...endTime, _passing: false });
			currentPassingRun = [];
			continue;
		}

		const totalTimeDiff = Math.floor((endTime.departure_time - startTime.departure_time) / 60);
		const totalEmu = currentPassingRun.reduce((acc, curr) => acc + curr.emu, 0);

		let accumulatedEmu = 0;
		for (let i = 0; i < currentPassingRun.length; i++) {
			const run = currentPassingRun[i];
			const scaledEmu = totalEmu > 0 ? (run.emu / totalEmu) * totalTimeDiff : 0;
			accumulatedEmu += scaledEmu;

			if (scaledEmu <= 0 && totalEmu > 0) continue;

			const interpolatedTime = startTime.departure_time + Math.floor(accumulatedEmu * 60);

			resultTimes.push({
				_passing: true,
				stop_id: run.to,
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
