import { CacheContext, getAugmentedStops } from "../cache.js";
import { getGtfs } from "../gtfsInterfaceLayer.js";
import { AugmentedStop } from "./augmentedStop.js";
import * as qdf from "qdf-gtfs";
import logger from "./logger.js";
import { cacheFileExists, getCacheFilePath, loadCacheFile, writeCacheFile } from "./fs.js";
import fs from "fs";

let rail_stations: string[] | null = cacheFileExists("considered_stations.json") ? JSON.parse(loadCacheFile("considered_stations.json")) : null;
if (rail_stations) {
	const stats = fs.statSync(getCacheFilePath("considered_stations.json"));
	const mtime = new Date(stats.mtime);
	const ageDays = (Date.now() - mtime.getTime()) / (1000 * 60 * 60 * 24);
	if (ageDays > 2) {
		rail_stations = null;
	}
}

function getPatternSignature(stopTimes: any[]): string {
	return stopTimes.map(st => st.stop_id).join('|');
}

export function getConsideredStations(): qdf.Stop[] {
	const gtfs = getGtfs();
	if (rail_stations === null) {
		rail_stations = [];
		let included: { [key: string]: boolean } = {};
		let seen: { [key: string]: boolean } = {};
		let startTime = Date.now();
		gtfs.getTrips().forEach(trip => {
			if (gtfs.getRoute(trip.route_id)?.route_type !== 2) return;

			const stopTimes = gtfs.getStopTimesForTrip(trip.trip_id);
			const sig = getPatternSignature(stopTimes);
			if (seen[sig]) return;
			seen[sig] = true;

			stopTimes.forEach(st => {
				const stop = gtfs.getStop(st.stop_id);
				if (stop) {
					const stationId = stop.parent_station ?? stop.stop_id;
					if (!rail_stations) rail_stations = [];
					if (!included[stationId]) {
						included[stationId] = true;
						rail_stations.push(stationId);
					}
				}
			});
		});

		writeCacheFile("considered_stations.json", JSON.stringify(rail_stations));

		logger.debug(`Loaded considered_stations in ${Date.now() - startTime}ms`, { module: "SRT" });
	}
	return rail_stations.map(v => gtfs.getStop(v)).filter(v => v) as qdf.Stop[];
}

export function getAugmentedRailStations(ctx?: CacheContext): AugmentedStop[] {
	return getConsideredStations().map((stop) => getAugmentedStops(stop.stop_id, ctx)[0]).filter((v) => v);
}
