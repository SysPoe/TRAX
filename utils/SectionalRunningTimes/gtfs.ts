import logger from "../logger.js";
import fs from "fs";
import { getGtfs } from '../../gtfsInterfaceLayer.js';
import { getDataFilePath, loadDataFile } from "../fs.js";

export type SRTMatrix = {
	[from: string]: {
		[to: string]: number;
	};
};

let _matrix: SRTMatrix | null = fs.existsSync(getDataFilePath("srt_matrix.json")) ? JSON.parse(loadDataFile("srt_matrix.json")) : null;
if (_matrix) {
	const stats = fs.statSync(getDataFilePath("srt_matrix.json"));
	const mtime = new Date(stats.mtime);
	const ageDays = (Date.now() - mtime.getTime()) / (1000 * 60 * 60 * 24);
	if (ageDays > 7) {
		_matrix = null;
	}
}

function getPatternSignature(stopTimes: any[]): string {
	return stopTimes.map(st => st.stop_id).join('|');
}

function generateSRTMatrix(): SRTMatrix {
	const gtfs = getGtfs();

	const trips = gtfs.getTrips();

	const uniquePatterns: any[][] = [];
	const seenSignatures = new Set<string>();

	logger.info("SRT: Extracting unique stopping patterns from GTFS...");

	trips.forEach((trip) => {
		if (gtfs.getRoute(trip.route_id)?.route_type !== 2) return;

		const stopTimes = gtfs.getStopTimesForTrip(trip.trip_id);
		const signature = getPatternSignature(stopTimes);

		if (seenSignatures.has(signature)) return;
		seenSignatures.add(signature);

		const stops = stopTimes.map((st, i) => {
			const stop = gtfs.getStop(st.stop_id);
			const id = stop ? stop.parent_station ?? stop.stop_id : st.stop_id;

			let timeFromPrev = 0;
			if (i > 0) {
				const prev = stopTimes[i - 1];
				const currTime = st.arrival_time ?? st.departure_time ?? 0;
				const prevTime = prev.departure_time ?? prev.arrival_time ?? 0;
				timeFromPrev = (currTime - prevTime) / 60;
			}

			return {
				id, timeFromPrev
			};
		});

		uniquePatterns.push(stops);
	});

	const validEdges = new Set<string>();

	uniquePatterns.forEach(pattern => {
		for (let i = 0; i < pattern.length - 1; i++) {
			const from = pattern[i].id;
			const to = pattern[i + 1].id;
			validEdges.add(`${from}|${to}`);
		}
	});

	logger.info(`SRT: Found ${validEdges.size} potential edges. Pruning express skips...`);

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

	logger.info(`SRT: Reduced to ${validEdges.size} physical edges. Calculating averages...`);

	const matrix: SRTMatrix = {};
	const segmentStats = new Map<string, { total: number; count: number }>();

	uniquePatterns.forEach(pattern => {
		for (let i = 0; i < pattern.length - 1; i++) {
			const from = pattern[i].id;
			const to = pattern[i + 1].id;
			const key = `${from}|${to}`;

			if (validEdges.has(key)) {
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
		const [from, to] = key.split('|');
		const avg = stats.total / stats.count;

		if (!matrix[from]) matrix[from] = {};
		matrix[from][to] = parseFloat(avg.toFixed(2));
	}

	return matrix;
}

export function getSRT(from: string, to: string): number | undefined {
	if (!_matrix) _matrix = generateSRTMatrix();
	return _matrix[from]?.[to] || _matrix[to]?.[from];
}