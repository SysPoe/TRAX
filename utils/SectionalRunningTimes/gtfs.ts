import logger from "../logger.js";
import { getGtfs } from '../../gtfsInterfaceLayer.js';
import { cacheFileExists, loadCacheFile, writeCacheFile } from "../fs.js";
import * as cache from "../../cache.js";
import * as qdf from "qdf-gtfs";
// Assuming 'qdf' types are available globally or imported. 
// If not, you may need to import them from your types definition file.

// --- Types ---

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

// Internal structure for the cached data file
interface NetworkData {
	matrix: SRTMatrix;
	adjacency: Record<string, string[]>; // The graph for BFS
	lastUpdated: number;
}

// --- State & Caching ---

let _networkData: NetworkData | null = null;
const CACHE_FILE = "network_topology.json";
const MAX_CACHE_AGE_DAYS = 7;

function loadNetworkData(): NetworkData | null {
	if (cacheFileExists(CACHE_FILE)) {
		try {
			const data = JSON.parse(loadCacheFile(CACHE_FILE));
			const ageDays = (Date.now() - (data.lastUpdated || 0)) / (1000 * 60 * 60 * 24);
			if (ageDays < MAX_CACHE_AGE_DAYS) {
				return data;
			}
			logger.info("Network topology cache expired, regenerating...");
		} catch (e) {
			logger.error("Failed to parse network topology cache: " + (e as Error).message);
		}
	}
	return null;
}

// --- Generation Logic ---

function getPatternSignature(stopTimes: any[]): string {
	return stopTimes.map(st => st.stop_id).join('|');
}

/**
 * Scans GTFS to build:
 * 1. An Adjacency Graph (Physical connections between stations, excluding express skips).
 * 2. An SRT Matrix (Average running times between connected stations).
 */
function generateNetworkData(): NetworkData {
	const gtfs = getGtfs();
	const trips = gtfs.getTrips();

	// We strictly want Rail (route_type 2)
	// You might need to adjust this filter based on your specific GTFS data
	const railTrips = trips.filter(t => gtfs.getRoute(t.route_id)?.route_type === 2);

	const uniquePatterns: any[][] = [];
	const seenSignatures = new Set<string>();

	logger.info("Topology: Extracting unique stopping patterns...");

	railTrips.forEach((trip) => {
		const stopTimes = gtfs.getStopTimesForTrip(trip.trip_id);
		const signature = getPatternSignature(stopTimes);

		if (seenSignatures.has(signature)) return;
		seenSignatures.add(signature);

		const stops = stopTimes.map((st, i) => {
			const stop = gtfs.getStop(st.stop_id);
			// Use parent station if available to unify platforms
			const id = stop ? stop.parent_station ?? stop.stop_id : st.stop_id;

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

	// 1. Identify all POTENTIAL edges (including Express skips)
	const validEdges = new Set<string>();
	uniquePatterns.forEach(pattern => {
		for (let i = 0; i < pattern.length - 1; i++) {
			validEdges.add(`${pattern[i].id}|${pattern[i + 1].id}`);
		}
	});

	logger.info(`Topology: Found ${validEdges.size} potential edges. Pruning express skips...`);

	// 2. Prune edges that are actually express skips
	// If we see A->B->C, we remove the edge A->C if it exists
	uniquePatterns.forEach(pattern => {
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

	logger.info(`Topology: Reduced to ${validEdges.size} physical edges. Building graph and matrix...`);

	const matrix: SRTMatrix = {};
	const adjacency: Record<string, string[]> = {};
	const segmentStats = new Map<string, { total: number; count: number }>();

	// 3. Build Adjacency List & Accumulate Stats
	uniquePatterns.forEach(pattern => {
		for (let i = 0; i < pattern.length - 1; i++) {
			const from = pattern[i].id;
			const to = pattern[i + 1].id;
			const key = `${from}|${to}`;

			if (validEdges.has(key)) {
				// Add to Adjacency Graph
				if (!adjacency[from]) adjacency[from] = [];
				if (!adjacency[from].includes(to)) adjacency[from].push(to);

				// Add reverse link for bidirectional graph traversal support
				if (!adjacency[to]) adjacency[to] = [];
				if (!adjacency[to].includes(from)) adjacency[to].push(from);

				// Add to Stats
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

	// 4. Finalize Matrix
	for (const [key, stats] of segmentStats.entries()) {
		const [from, to] = key.split('|');
		const avg = stats.total / stats.count;

		if (!matrix[from]) matrix[from] = {};
		matrix[from][to] = parseFloat(avg.toFixed(2));

		// Ensure reverse mapping exists for SRT lookup if missing
		if (!matrix[to]) matrix[to] = {};
		if (!matrix[to][from]) matrix[to][from] = parseFloat(avg.toFixed(2));
	}

	const result = { matrix, adjacency, lastUpdated: Date.now() };
	writeCacheFile(CACHE_FILE, JSON.stringify(result));
	return result;
}

function ensureDataLoaded() {
	if (!_networkData) {
		_networkData = loadNetworkData();
		if (!_networkData) {
			_networkData = generateNetworkData();
		}
	}
}

// --- Accessors ---

export function getSRT(from: string, to: string): number | undefined {
	ensureDataLoaded();
	// Special case for Exhibition loop which is often missing from scheduled logic
	if ((from == "place_exhsta" && to == "place_bowsta") || (from == "place_bowsta" && to == "place_exhsta")) return 3;

	return _networkData!.matrix[from]?.[to] || _networkData!.matrix[to]?.[from];
}

function getGraph(): Record<string, string[]> {
	ensureDataLoaded();
	return _networkData!.adjacency;
}

// --- Pathfinding & Express Logic ---

function findPathBFS(start: string, end: string): string[] | null {
	const graph = getGraph();
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

export function findExpress(givenStops: string[]): ExpressInfo[] {
	const result: ExpressInfo[] = [];

	for (let i = 0; i < givenStops.length - 1; i++) {
		const startStop = givenStops[i];
		const endStop = givenStops[i + 1];

		// Find the "Local" physical path between these two stops in our topology
		const physicalPath = findPathBFS(startStop, endStop);

		if (physicalPath) {
			// If the physical path is exactly [start, end], it's a local segment
			if (physicalPath.length === 2) {
				result.push({
					type: "local",
					from: startStop,
					to: endStop,
				});
			}
			// If the physical path is longer (start -> A -> B -> end), then A and B were skipped
			else if (physicalPath.length > 2) {
				const skippedStops = physicalPath.slice(1, physicalPath.length - 1);
				result.push({
					type: "express",
					from: startStop,
					to: endStop,
					skipping: skippedStops
				});
			}
		} else {
			result.push({
				type: "unknown_segment",
				from: startStop,
				to: endStop,
				message: "No physical track connection found."
			});
		}
	}
	return result;
}

export function findExpressString(expressData: ExpressInfo[], stop_id: string | null = null): string {
	if (stop_id != null)
		expressData = expressData.slice(
			expressData.findIndex((v) => v.from === stop_id || v.skipping?.includes(stop_id) || v.to === stop_id),
		);

	// Filter out local segments, we only care about express runs for the string
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
				const startName = cache.getRawStops(run.from)[0]?.stop_name?.replace(" station", "");
				const endName = cache.getRawStops(run.to)[0]?.stop_name?.replace(" station", "");
				const stoppingAtNames = run.stoppingAt.map((stopId) =>
					cache.getRawStops(stopId)[0]?.stop_name?.replace(" station", ""),
				);
				const formattedStoppingAtNames =
					stoppingAtNames.length <= 1
						? stoppingAtNames[0]
						: stoppingAtNames.length == 2
							? `${stoppingAtNames[0]} and ${stoppingAtNames[1]}`
							: `${stoppingAtNames.slice(0, -1).join(", ")}, and ${stoppingAtNames[stoppingAtNames.length - 1]}`;

				return stop_id !== null &&
					(run.from == cache.getRawStops(stop_id)[0]?.parent_station || run.from == stop_id)
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

// --- Passing Stop Logic (Interpolation) ---

const loggedMissingSRT = new Set<string>();

/**
 * Helper to determine what stops are passed/skipped based on the provided list of stops.
 */
function findPassingStops(stops: string[], ctx?: cache.CacheContext): { stop_id: string; passing: boolean }[] {
	const stopListHash = stops.join("|");
	const cached = cache.getCachedPassingStops(stopListHash, ctx);
	if (cached) return cached;

	// Use the new graph-based express finder
	const expressSegments = findExpress(stops);
	const allStops: { stop_id: string; passing: boolean }[] = [];

	const addStop = (id: string, passing: boolean) => {
		// Prevent duplicates at segment boundaries
		if (allStops.at(-1)?.stop_id !== id) {
			allStops.push({ stop_id: id, passing });
		}
	};

	for (const segment of expressSegments) {
		if (segment.type === "unknown_segment") {
			logger.warn(`Unknown segment between ${segment.from} and ${segment.to}: ${segment.message}`, {
				module: "augmentedStopTime",
				function: "findPassingStops",
			});
			continue;
		}

		if (segment.type === "local") {
			addStop(segment.from, false);
			// Since it is local, there are no intermediate stops to add between from/to based on segment info
			// (The BFS already confirmed they are adjacent in physical graph)
			addStop(segment.to, false);
			continue;
		}

		// Handle express segments
		addStop(segment.from, false);
		segment.skipping?.forEach((s) => addStop(s, true));
		addStop(segment.to, false);
	}

	cache.cachePassingStops(stopListHash, allStops, ctx);
	return allStops;
}

function findPassingStopSRTs(stops: string[], ctx?: cache.CacheContext): PassingStopSRT[] {
	const allStops = findPassingStops(stops, ctx);
	const results: PassingStopSRT[] = [];

	for (let i = 0; i < allStops.length - 1; i++) {
		const from = allStops[i].stop_id;
		const to = allStops[i + 1].stop_id;
		const srt = getSRT(from, to); // Uses dynamic matrix

		if (srt === undefined) {
			const key = `${from}|${to}`;
			if (!loggedMissingSRT.has(key)) {
				logger.warn(`No SRT found between ${from} and ${to}`, {
					module: "augmentedStopTime",
					function: "findPassingStopSRTs",
				});
				loggedMissingSRT.add(key);
			}
			// Default to 1 minute if missing to prevent calculation break
			results.push({ from, to, emu: 1, passing: allStops[i + 1].passing });
		} else {
			results.push({ from, to, emu: srt, passing: allStops[i + 1].passing });
		}
	}
	return results;
}

// Helper to normalize stop IDs to parent IDs for consistent matrix lookup
function getStopOrParentId(stopId: string, ctx?: cache.CacheContext): string | undefined {
	// Assuming you have a helper or can use cache.getRawStops
	const s = cache.getRawStops(stopId, ctx)?.[0];
	return s ? (s.parent_station ?? s.stop_id) : undefined;
}

export function findPassingStopTimes(stopTimes: qdf.StopTime[], ctx?: cache.CacheContext): (qdf.StopTime & { _passing: boolean })[] {
	if (stopTimes.length === 0) return [];

	// Extract parent stations for SRT lookup, sorted by sequence
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
		// Fallback or warning if we couldn't determine path
		return sortedStopTimes.map(v => ({ ...v, _passing: false }));
	}

	// We define a new Interface for result items which might be 'Passing' (virtual)
	type PassingResult = qdf.StopTime & { _passing: boolean };

	let resultTimes: PassingResult[] = [{ ...idsToTimes[passingSRTs[0].from], _passing: false }];
	let currentPassingRun: PassingStopSRT[] = [];

	// Process segments
	for (const srt of passingSRTs) {
		if (srt.passing) {
			currentPassingRun.push(srt);
			continue;
		}

		if (currentPassingRun.length === 0) {
			// Just a normal stop
			if (idsToTimes[srt.to]) {
				resultTimes.push({ ...idsToTimes[srt.to], _passing: false });
			}
			continue;
		}

		// We have a block of passing stops to interpolate
		const startTime = resultTimes.at(-1);
		const endTime = idsToTimes[srt.to];

		if (!startTime?.departure_time || !endTime?.departure_time) {
			// Skip interpolation if data invalid, but add the endpoint
			if (endTime) resultTimes.push({ ...endTime, _passing: false });
			currentPassingRun = [];
			continue;
		}

		const totalTimeDiff = Math.floor((endTime.departure_time - startTime.departure_time) / 60);
		const totalEmu = currentPassingRun.reduce((acc, curr) => acc + curr.emu, 0);

		let accumulatedEmu = 0;
		for (let i = 0; i < currentPassingRun.length; i++) {
			const run = currentPassingRun[i];
			// Rescale EMU based on actual scheduled difference
			const scaledEmu = totalEmu > 0 ? (run.emu / totalEmu) * totalTimeDiff : 0;
			accumulatedEmu += scaledEmu;

			if (scaledEmu <= 0 && totalEmu > 0) continue;

			const interpolatedTime = startTime.departure_time + Math.floor(accumulatedEmu * 60);

			resultTimes.push({
				_passing: true,
				stop_id: run.to,
				trip_id: stopTimes[0].trip_id,
				stop_sequence: (startTime.stop_sequence ?? 0) + (i + 1) * ((endTime.stop_sequence ?? 0) - (startTime.stop_sequence ?? 0)) / (currentPassingRun.length + 1),
				departure_time: interpolatedTime,
				arrival_time: interpolatedTime,
				drop_off_type: 1, // None
				pickup_type: 1,   // None
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
	findPassingStopTimes
};