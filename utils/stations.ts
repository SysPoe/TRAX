import { CacheContext, getAugmentedStops, getRawStops } from "../cache.js";
import { getGtfs } from "../gtfsInterfaceLayer.js";
import { AugmentedStop } from "./augmentedStop.js";
import * as qdf from "qdf-gtfs";
import { loadDataFile } from "./fs.js";

let qr_stations: string[] = JSON.parse(loadDataFile("qr_stations.json"));

export function getGtfsStations(): qdf.Stop[] {
	return getGtfs()
		.getStops()
		.filter((v) => qr_stations.includes(v.stop_id));
}

export function getStations(ctx?: CacheContext): AugmentedStop[] {
	return qr_stations.map((stop_id) => getAugmentedStops(stop_id, ctx)[0]).filter((v) => v);
}
