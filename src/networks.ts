import type { NetworkDefinition } from "./config.js";
import { seqPlugin } from "./plugins/seq.js";
import { gthaPlugin } from "./plugins/gtha.js";
import { viaPlugin } from "./plugins/via.js";
import { createVLinePlugin } from "./plugins/vline.js";
import { ptvMetroPlugin } from "./plugins/ptv-metro.js";
import type { VLinePluginOptions } from "./region-specific/AU/VIC/types.js";

export const AU_SEQ_NETWORK: NetworkDefinition = {
	id: "au-seq",
	name: "South East Queensland",
	feeds: [
		{
			id: "translink-seq",
			staticSource: { url: "https://gtfsrt.api.translink.com.au/GTFS/SEQ_GTFS.zip" },
			realtimeSources: [
				{
					id: "translink-seq-alerts",
					targetFeedId: "translink-seq",
					kind: "alerts",
					source: { url: "https://gtfsrt.api.translink.com.au/api/realtime/SEQ/alerts" },
				},
				{
					id: "translink-seq-trip-updates",
					targetFeedId: "translink-seq",
					kind: "trip-updates",
					source: { url: "https://gtfsrt.api.translink.com.au/api/realtime/SEQ/TripUpdates" },
				},
				{
					id: "translink-seq-vehicles",
					targetFeedId: "translink-seq",
					kind: "vehicles",
					source: { url: "https://gtfsrt.api.translink.com.au/api/realtime/SEQ/VehiclePositions" },
				},
			],
		},
	],
	modes: ["rail"],
	plugins: [seqPlugin],
};

export type AuVicVlineNetworkOptions = VLinePluginOptions & { gtfsRtKey?: string };

const SHARED_VICTORIA_RAIL_STATIONS = [
	["southern-cross", "Southern Cross Railway Station", "vic:rail:SSS"],
	["berwick", "Berwick Railway Station", "vic:rail:BEW"],
	["broadmeadows", "Broadmeadows Railway Station", "vic:rail:BMS"],
	["caulfield", "Caulfield Railway Station", "vic:rail:CFD"],
	["clayton", "Clayton Railway Station", "vic:rail:CLA"],
	["craigieburn", "Craigieburn Railway Station", "vic:rail:CGB"],
	["dandenong", "Dandenong Railway Station", "vic:rail:DNG"],
	["east-pakenham", "East Pakenham Railway Station", "vic:rail:EPH"],
	["essendon", "Essendon Railway Station", "vic:rail:ESD"],
	["flinders-street", "Flinders Street Railway Station", "vic:rail:FSS"],
	["footscray", "Footscray Railway Station", "vic:rail:FSY"],
	["north-melbourne", "North Melbourne Railway Station", "vic:rail:NME"],
	["pakenham", "Pakenham Railway Station", "vic:rail:PKM"],
	["richmond", "Richmond Railway Station", "vic:rail:RMD"],
	["sunbury", "Sunbury Railway Station", "vic:rail:SUY"],
	["sunshine", "Sunshine Railway Station", "vic:rail:SUN"],
	["watergardens", "Watergardens Railway Station", "vic:rail:WGS"],
] as const;

export function createAuVicVlineNetwork(options: AuVicVlineNetworkOptions = {}): NetworkDefinition {
	const key = options.gtfsRtKey?.trim();
	const realtime = (feedId: "vic-vline" | "vic-metro", operator: "vline" | "metro", kind: "trip-updates" | "vehicles", endpoint: string) => ({
		id: `${feedId}-${endpoint}`,
		targetFeedId: feedId,
		kind,
		source: {
			url: `https://api.opendata.transport.vic.gov.au/opendata/public-transport/gtfs/realtime/v1/${operator}/${endpoint}`,
			headers: { KeyId: key! },
		},
	});
	const staticUrl = "https://opendata.transport.vic.gov.au/dataset/3f4e292e-7f8a-4ffe-831f-1953be0fe448/resource/fb152201-859f-4882-9206-b768060b50ad/download/gtfs.zip";
	return {
		id: "au-vic-vline",
		name: "Victoria Rail",
		feeds: [
			{
				id: "vic-vline",
				staticSource: { url: staticUrl, archiveEntry: "1/google_transit.zip" },
				realtimeSources: key
					? [
						realtime("vic-vline", "vline", "trip-updates", "trip-updates"),
						realtime("vic-vline", "vline", "vehicles", "vehicle-positions"),
					]
					: [],
			},
			{
				id: "vic-metro",
				staticSource: { url: staticUrl, archiveEntry: "2/google_transit.zip" },
				realtimeSources: key
					? [
						realtime("vic-metro", "metro", "trip-updates", "trip-updates"),
						realtime("vic-metro", "metro", "vehicles", "vehicle-positions"),
					]
					: [],
			},
		],
		modes: ["rail"],
		plugins: [createVLinePlugin(options), ptvMetroPlugin],
		places: SHARED_VICTORIA_RAIL_STATIONS.map(([id, name, localId]) => ({
			id,
			name,
			members: [
				{ feedId: "vic-vline", localId },
				{ feedId: "vic-metro", localId },
			],
		})),
	};
}

export function createCaGthaNetwork(apiKeys: string | readonly string[] = []): NetworkDefinition {
	const rawKeys = typeof apiKeys === "string" ? [apiKeys] : [...apiKeys];
	const keys = [...new Set(rawKeys.map((key) => key.trim()).filter(Boolean))];
	const source = (id: string, targetFeedId: string, kind: "alerts" | "trip-updates" | "vehicles", url: string) => ({
		id,
		targetFeedId,
		kind,
		source: {
			url: `${url}?key=${keys[0]}`,
			fallbackUrls: keys.slice(1).map((key) => `${url}?key=${key}`),
		},
	});
	const interchange = (id: string, name: string, goId: string, viaId: string, includeUp = false) => ({
		id,
		name,
		members: [
			{ feedId: "go", localId: goId },
			...(includeUp ? [{ feedId: "up", localId: goId }] : []),
			{ feedId: "via", localId: viaId },
		],
	});
	return {
		id: "ca-gtha",
		name: "Canada Rail",
		feeds: [
			{
				id: "up",
				staticSource: {
					url: "https://assets.metrolinx.com/raw/upload/Documents/Metrolinx/Open%20Data/UP-GTFS.zip",
				},
				realtimeSources: keys.length > 0 ? [
					source(
						"up-alerts",
						"up",
						"alerts",
						"https://api.openmetrolinx.com/OpenDataAPI/api/V1/UP/Gtfs.proto/Feed/Alerts",
					),
					source(
						"up-trip-updates",
						"up",
						"trip-updates",
						"https://api.openmetrolinx.com/OpenDataAPI/api/V1/UP/Gtfs.proto/Feed/TripUpdates",
					),
					source(
						"up-vehicles",
						"up",
						"vehicles",
						"https://api.openmetrolinx.com/OpenDataAPI/api/V1/UP/Gtfs.proto/Feed/VehiclePosition",
					),
				] : [],
			},
			{
				id: "go",
				staticSource: {
					url: "https://assets.metrolinx.com/raw/upload/Documents/Metrolinx/Open%20Data/GO-GTFS.zip",
				},
				realtimeSources: keys.length > 0 ? [
					source(
						"go-alerts",
						"go",
						"alerts",
						"https://api.openmetrolinx.com/OpenDataAPI/api/V1/Gtfs.proto/Feed/Alerts",
					),
					source(
						"go-trip-updates",
						"go",
						"trip-updates",
						"https://api.openmetrolinx.com/OpenDataAPI/api/V1/Gtfs.proto/Feed/TripUpdates",
					),
					source(
						"go-vehicles",
						"go",
						"vehicles",
						"https://api.openmetrolinx.com/OpenDataAPI/api/V1/Gtfs.proto/Feed/VehiclePosition",
					),
				] : [],
			},
			{
				id: "via",
				staticSource: { url: "https://www.viarail.ca/sites/all/files/gtfs/viarail.zip" },
				realtimeSources: [],
			},
		],
		modes: ["rail"],
		plugins: [gthaPlugin, viaPlugin],
		places: [
			interchange("toronto-union", "Toronto Union Station", "UN", "119", true),
			interchange("oshawa", "Oshawa", "OS", "367"),
			interchange("guildwood", "Guildwood", "GU", "450"),
			interchange("kitchener", "Kitchener", "KI", "114"),
			interchange("aldershot", "Aldershot", "AL", "600"),
			interchange("oakville", "Oakville", "OA", "436"),
			interchange("guelph", "Guelph Central", "GL", "70"),
			interchange("stratford", "Stratford", "SF", "7"),
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
	feeds: [
		{
			id: "via",
			staticSource: { url: "https://www.viarail.ca/sites/all/files/gtfs/viarail.zip" },
			realtimeSources: [],
		},
	],
	modes: ["rail"],
	plugins: [viaPlugin],
};
