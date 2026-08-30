import type { NetworkDefinition } from "./config.js";
import { seqPlugin } from "./plugins/seq.js";
import { gthaPlugin } from "./plugins/gtha.js";
import { viaPlugin } from "./plugins/via.js";
import { createVLinePlugin } from "./plugins/vline.js";
import { ptvMetroPlugin } from "./plugins/ptv-metro.js";
import {
	createTfnswRailPlugin,
	createTfnswRegionalBookingPlugin,
	type TfnswRailPluginOptions,
} from "./plugins/tfnsw-rail.js";
import type { VLinePluginOptions } from "./region-specific/AU/VIC/types.js";
import { getQrtManualNetwork } from "./region-specific/AU/SEQ/qr-travel/manual-network.js";

export const AU_SEQ_NETWORK: NetworkDefinition = {
	id: "au-seq",
	name: "South East Queensland",
	feeds: [
		{
			id: "translink-seq",
			staticSource: { url: "https://gtfsrt.api.translink.com.au/GTFS/SEQ_GTFS.zip" },
			// SEQ publishes the train's four-character report number (TRN) as the
			// realtime vehicle label; unplanned trips have no scheduled run number,
			// so their label is wrapped to make the report-number provenance explicit.
			tripNumber: (trip, realtime) => {
				const label = realtime?.vehicleLabel?.trim().toUpperCase();
				if (!label || !/^[A-Z0-9]{4}$/.test(label)) return undefined;
				return trip.trip_id.startsWith("UNPLANNED-") ? `TRN '${label}'` : label;
			},
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
	corridor: {
		geometrySources: [{ feedId: "QRT", borrowFromFeedIds: ["translink-seq"] }],
		manualNetworks: [getQrtManualNetwork()],
		version: "qrt-1",
	},
	places: [
		{
			id: "brisbane-central",
			name: "Brisbane Central",
			members: [{ feedId: "translink-seq", localId: "place_censta" }],
		},
	],
};

export type AuVicVlineNetworkOptions = VLinePluginOptions & { gtfsRtKey?: string };

export type AuRailNetworkOptions = AuVicVlineNetworkOptions & { tfnswApiKey?: string } & TfnswRailPluginOptions;

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
	const realtime = (
		feedId: "vic-vline" | "vic-metro",
		operator: "vline" | "metro",
		kind: "trip-updates" | "vehicles",
		endpoint: string,
	) => ({
		id: `${feedId}-${endpoint}`,
		targetFeedId: feedId,
		kind,
		source: {
			url: `https://api.opendata.transport.vic.gov.au/opendata/public-transport/gtfs/realtime/v1/${operator}/${endpoint}`,
			headers: { KeyId: key! },
		},
	});
	const staticUrl =
		"https://opendata.transport.vic.gov.au/dataset/3f4e292e-7f8a-4ffe-831f-1953be0fe448/resource/fb152201-859f-4882-9206-b768060b50ad/download/gtfs.zip";
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

const SHARED_NSW_RAIL_STATIONS = [
	["blacktown", "Blacktown Station", "214810"],
	["campbelltown", "Campbelltown Station", "256020"],
	["sydney-central", "Sydney Central", "200060"],
	["glenfield", "Glenfield Station", "216710"],
	["hornsby", "Hornsby Station", "207720"],
	["macarthur", "Macarthur Station", "256030"],
	["parramatta", "Parramatta Station", "215020"],
	["penrith", "Penrith Station", "275010"],
	["strathfield", "Strathfield Station", "213510"],
	["westmead", "Westmead Station", "214510"],
	["wollongong", "Wollongong Station", "250020"],
] as const;

const SHARED_VLINE_TRAINLINK_STATIONS = [
	["albury", "Albury Railway Station", "nsw:rail:ABY", "26401"],
	["benalla", "Benalla Railway Station", "vic:rail:BXA", "20295"],
	["seymour", "Seymour Railway Station", "vic:rail:SER", "20342"],
	["wangaratta", "Wangaratta Railway Station", "vic:rail:WRT", "20356"],
] as const;

/**
 * Build one Australian rail runtime. Cross-feed places are canonical graph
 * nodes, so interstate, suburban, and long-distance services share departures,
 * topology, passing stops, and station links.
 */
export function createAuRailNetwork(options: AuRailNetworkOptions = {}): NetworkDefinition {
	const victoria = createAuVicVlineNetwork(options);
	const tfnswKey = options.tfnswApiKey?.trim();
	const tfnswHeaders = tfnswKey ? { Authorization: `apikey ${tfnswKey}` } : undefined;
	const tfnswSource = (url: string) => ({ url, headers: tfnswHeaders! });
	const tfnswFeeds: NetworkDefinition["feeds"] = tfnswKey
		? [
				{
					id: "nsw-sydney-trains",
					tripNumber: (trip) => trip.trip_id.slice(0, 4),
					staticSource: tfnswSource("https://api.transport.nsw.gov.au/v1/gtfs/schedule/sydneytrains"),
					realtimeSources: [
						{
							id: "nsw-sydney-trains-trip-updates",
							targetFeedId: "nsw-sydney-trains",
							kind: "trip-updates",
							source: tfnswSource("https://api.transport.nsw.gov.au/v2/gtfs/realtime/sydneytrains"),
						},
						{
							id: "nsw-sydney-trains-vehicles",
							targetFeedId: "nsw-sydney-trains",
							kind: "vehicles",
							source: tfnswSource("https://api.transport.nsw.gov.au/v2/gtfs/vehiclepos/sydneytrains"),
						},
						{
							id: "nsw-sydney-trains-alerts",
							targetFeedId: "nsw-sydney-trains",
							kind: "alerts",
							source: tfnswSource("https://api.transport.nsw.gov.au/v2/gtfs/alerts/sydneytrains"),
						},
					],
				},
				{
					id: "nsw-trainlink",
					tripNumber: (trip) => trip.trip_id.slice(0, 4),
					staticSource: tfnswSource("https://api.transport.nsw.gov.au/v1/gtfs/schedule/nswtrains"),
					realtimeSources: [
						{
							id: "nsw-trainlink-trip-updates",
							targetFeedId: "nsw-trainlink",
							kind: "trip-updates",
							source: tfnswSource("https://api.transport.nsw.gov.au/v1/gtfs/realtime/nswtrains"),
						},
						{
							id: "nsw-trainlink-vehicles",
							targetFeedId: "nsw-trainlink",
							kind: "vehicles",
							source: tfnswSource("https://api.transport.nsw.gov.au/v1/gtfs/vehiclepos/nswtrains"),
						},
						{
							id: "nsw-trainlink-alerts",
							targetFeedId: "nsw-trainlink",
							kind: "alerts",
							source: tfnswSource("https://api.transport.nsw.gov.au/v2/gtfs/alerts/nswtrains"),
						},
					],
				},
			]
		: [];

	const victoriaPlaces = (victoria.places ?? []).map((place) => {
		const trainLinkId = place.id === "broadmeadows" ? "20030" : place.id === "southern-cross" ? "22180" : null;
		return trainLinkId && tfnswKey
			? { ...place, members: [...place.members, { feedId: "nsw-trainlink", localId: trainLinkId }] }
			: place;
	});
	const tfnswPlaces = tfnswKey
		? [
				...SHARED_NSW_RAIL_STATIONS.map(([id, name, localId]) => ({
					id,
					name,
					members: [
						{ feedId: "nsw-sydney-trains", localId },
						{ feedId: "nsw-trainlink", localId },
					],
				})),
				...SHARED_VLINE_TRAINLINK_STATIONS.map(([id, name, vlineId, trainLinkId]) => ({
					id,
					name,
					members: [
						{ feedId: "vic-vline", localId: vlineId },
						{ feedId: "nsw-trainlink", localId: trainLinkId },
					],
				})),
				{
					id: "brisbane-roma-street",
					name: "Roma Street station",
					members: [
						{ feedId: "translink-seq", localId: "place_romsta" },
						{ feedId: "nsw-sydney-trains", localId: "40001" },
						{ feedId: "nsw-trainlink", localId: "40001" },
					],
				},
			]
		: [];

	return {
		id: "au-rail",
		name: "Australia Rail",
		feeds: [...AU_SEQ_NETWORK.feeds, ...victoria.feeds, ...tfnswFeeds],
		modes: ["rail"],
		plugins: [
			...AU_SEQ_NETWORK.plugins,
			...victoria.plugins,
			...(tfnswKey
				? [createTfnswRailPlugin(options), createTfnswRegionalBookingPlugin(options.regionalBooking)]
				: []),
		],
		corridor: AU_SEQ_NETWORK.corridor,
		places: [...(AU_SEQ_NETWORK.places ?? []), ...victoriaPlaces, ...tfnswPlaces],
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
				realtimeSources:
					keys.length > 0
						? [
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
							]
						: [],
			},
			{
				id: "go",
				staticSource: {
					url: "https://assets.metrolinx.com/raw/upload/Documents/Metrolinx/Open%20Data/GO-GTFS.zip",
				},
				realtimeSources:
					keys.length > 0
						? [
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
							]
						: [],
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
