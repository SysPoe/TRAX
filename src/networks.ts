import type { NetworkDefinition } from "./config.js";
import { seqPlugin } from "./plugins/seq.js";
import { gthaPlugin } from "./plugins/gtha.js";
import { viaPlugin } from "./plugins/via.js";

export const AU_SEQ_NETWORK: NetworkDefinition = {
	id: "au-seq",
	name: "South East Queensland",
	feeds: [{
		id: "translink-seq",
		staticSource: { url: "https://gtfsrt.api.translink.com.au/GTFS/SEQ_GTFS.zip" },
		realtimeSources: [
			{ id: "translink-seq-alerts", targetFeedId: "translink-seq", kind: "alerts", source: { url: "https://gtfsrt.api.translink.com.au/api/realtime/SEQ/alerts" } },
			{ id: "translink-seq-trip-updates", targetFeedId: "translink-seq", kind: "trip-updates", source: { url: "https://gtfsrt.api.translink.com.au/api/realtime/SEQ/TripUpdates" } },
			{ id: "translink-seq-vehicles", targetFeedId: "translink-seq", kind: "vehicles", source: { url: "https://gtfsrt.api.translink.com.au/api/realtime/SEQ/VehiclePositions" } },
		],
	}],
	modes: ["rail"],
	plugins: [seqPlugin],
};

export function createCaGthaNetwork(apiKey: string): NetworkDefinition {
	const source = (id: string, targetFeedId: string, kind: "alerts" | "trip-updates" | "vehicles", url: string) => ({ id, targetFeedId, kind, source: { url: `${url}?key=${apiKey}` } });
	const interchange = (id: string, name: string, goId: string, viaId: string, includeUp = false) => ({
		id, name,
		members: [
			{ feedId: "go", localId: goId },
			...(includeUp ? [{ feedId: "up", localId: goId }] : []),
			{ feedId: "via", localId: viaId },
		],
	});
	return {
		id: "ca-gtha",
		name: "Greater Toronto and Hamilton Area",
		feeds: [
			{ id: "up", staticSource: { url: "https://assets.metrolinx.com/raw/upload/Documents/Metrolinx/Open%20Data/UP-GTFS.zip" }, realtimeSources: [
				source("up-alerts", "up", "alerts", "https://api.openmetrolinx.com/OpenDataAPI/api/V1/UP/Gtfs.proto/Feed/Alerts"),
				source("up-trip-updates", "up", "trip-updates", "https://api.openmetrolinx.com/OpenDataAPI/api/V1/UP/Gtfs.proto/Feed/TripUpdates"),
				source("up-vehicles", "up", "vehicles", "https://api.openmetrolinx.com/OpenDataAPI/api/V1/UP/Gtfs.proto/Feed/VehiclePosition"),
			] },
			{ id: "go", staticSource: { url: "https://assets.metrolinx.com/raw/upload/Documents/Metrolinx/Open%20Data/GO-GTFS.zip" }, realtimeSources: [
				source("go-alerts", "go", "alerts", "https://api.openmetrolinx.com/OpenDataAPI/api/V1/Gtfs.proto/Feed/Alerts"),
				source("go-trip-updates", "go", "trip-updates", "https://api.openmetrolinx.com/OpenDataAPI/api/V1/Gtfs.proto/Feed/TripUpdates"),
				source("go-vehicles", "go", "vehicles", "https://api.openmetrolinx.com/OpenDataAPI/api/V1/Gtfs.proto/Feed/VehiclePosition"),
			] },
			{ id: "via", staticSource: { url: "https://www.viarail.ca/sites/all/files/gtfs/viarail.zip" }, realtimeSources: [] },
		],
		modes: ["rail"],
		plugins: [gthaPlugin, viaPlugin],
		places: [
			interchange("toronto-union", "Toronto Union Station", "UN", "119", true),
			interchange("oshawa", "Oshawa", "OS", "367"),
			interchange("kitchener", "Kitchener", "KI", "114"),
			interchange("aldershot", "Aldershot", "AL", "600"),
			interchange("oakville", "Oakville", "OA", "436"),
			interchange("guelph", "Guelph Central", "GU", "450"),
			interchange("brampton", "Brampton", "BR", "322"),
			interchange("georgetown", "Georgetown", "GE", "6"),
			interchange("malton", "Malton", "MA", "34"),
			interchange("niagara-falls", "Niagara Falls", "NI", "346"),
			interchange("st-catharines", "St. Catharines", "SCTH", "185"),
		],
	};
}

export const CA_VIA_NETWORK: NetworkDefinition = {
	id: "ca-via",
	name: "VIA Rail Canada",
	feeds: [{ id: "via", staticSource: { url: "https://www.viarail.ca/sites/all/files/gtfs/viarail.zip" }, realtimeSources: [] }],
	modes: ["rail"],
	plugins: [viaPlugin],
};
