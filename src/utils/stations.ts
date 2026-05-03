import { CacheContext, getAugmentedStops } from "../cache/index.js";
import { AugmentedStop } from "./augmentedStop.js";
import * as qdf from "qdf-gtfs";
import logger from "./logger.js";
import { cacheFileExists, getCacheFilePath, loadCacheFile, writeCacheFile } from "./fs.js";
import fs from "fs";

function getPatternSignature(stopTimes: qdf.StopTime[]): string {
	return stopTimes.map((st) => st.stop_id).join("|");
}

export function getConsideredStations(ctx: CacheContext): qdf.Stop[] {
	if (ctx.augmented.railStations.length > 0) {
		return ctx.augmented.railStations;
	}

	if (!ctx.gtfs) throw new Error("GTFS not initialized!");
	const gtfs = ctx.gtfs;
	const cacheDir = ctx.config.cacheDir;

	let stations: string[] | null = null;

	if (cacheFileExists("considered_stations.json", cacheDir)) {
		const stats = fs.statSync(getCacheFilePath("considered_stations.json", cacheDir));
		const mtime = new Date(stats.mtime);
		const ageDays = (Date.now() - mtime.getTime()) / (1000 * 60 * 60 * 24);
		if (ageDays <= 2) {
			stations = JSON.parse(loadCacheFile("considered_stations.json", cacheDir));
		}
	}

	if (stations === null) {
		stations = [];
		let included: { [key: string]: boolean } = {};
		let seen: { [key: string]: boolean } = {};
		let startTime = Date.now();

		const processTrip = (trip: qdf.Trip) => {
			if (gtfs.getRoutes({ route_id: trip.route_id })[0]?.route_type !== 2) return;

			const stopTimes = gtfs.getStopTimes({ trip_id: trip.trip_id });
			const sig = getPatternSignature(stopTimes);
			if (seen[sig]) return;
			seen[sig] = true;

			stopTimes.forEach((st: qdf.StopTime) => {
				const stop = gtfs.getStops({ stop_id: st.stop_id })[0];
				if (stop) {
					const stationId = stop.parent_station ?? stop.stop_id;
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

		writeCacheFile("considered_stations.json", JSON.stringify(stations), cacheDir);

		logger.debug(`Loaded considered_stations in ${Date.now() - startTime}ms`, { module: "SRT" });
	}

	const result = stations.map((v) => gtfs.getStops({ stop_id: v })[0]).filter((v) => v) as qdf.Stop[];

	if (ctx) {
		ctx.augmented.railStations = result;
	}

	return result;
}

export function getAugmentedRailStations(ctx: CacheContext): AugmentedStop[] {
	return getConsideredStations(ctx)
		.map((stop) => getAugmentedStops(ctx, stop.stop_id)[0])
		.filter((v) => v);
}
