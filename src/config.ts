import { ProgressInfo, GTFSFeedConfig } from "qdf-gtfs";
import logger from "./utils/logger.js";

export type TRAXRegion = "AU/SEQ" | "CA" | "CA/GTHA";

export type MergeAction = {
	to: string;
	from: string[];
};

export interface TraxConfig {
	urls: (string | GTFSFeedConfig)[];
	verbose: boolean;
	cacheDir: string;
	logFunction: (message: string) => void;
	progressLog: (info: ProgressInfo) => void;
	region: TRAXRegion | "none";
	timezone: string;
	realtime: {
		realtimeAlerts: (string | GTFSFeedConfig)[] | null;
		realtimeTripUpdates: (string | GTFSFeedConfig)[] | null;
		realtimeVehiclePositions: (string | GTFSFeedConfig)[] | null;
	} | null;
	mergeStops: MergeAction[];
}

export type TraxConfigOptions = Partial<Omit<TraxConfig, "realtime">> & {
	url?: string;
	headers?: { [key: string]: string } | null;
	timezone?: string;
	realtime?: {
		realtimeAlerts?: (string | GTFSFeedConfig)[] | string | GTFSFeedConfig | null;
		realtimeTripUpdates?: (string | GTFSFeedConfig)[] | string | GTFSFeedConfig | null;
		realtimeVehiclePositions?: (string | GTFSFeedConfig)[] | string | GTFSFeedConfig | null;
	} | null;
	mergeStops?: MergeAction[] | null;
};

export const PRESETS: Record<TRAXRegion, (apiKey?: string | undefined) => TraxConfigOptions> = {
	"AU/SEQ": () =>
		({
			urls: ["https://gtfsrt.api.translink.com.au/GTFS/SEQ_GTFS.zip"],
			region: "AU/SEQ",
			timezone: "Australia/Brisbane",
			realtime: {
				realtimeAlerts: ["https://gtfsrt.api.translink.com.au/api/realtime/SEQ/alerts"],
				realtimeTripUpdates: ["https://gtfsrt.api.translink.com.au/api/realtime/SEQ/TripUpdates"],
				realtimeVehiclePositions: ["https://gtfsrt.api.translink.com.au/api/realtime/SEQ/VehiclePositions"],
			},
		}) as TraxConfigOptions,
	CA: () =>
		({
			urls: ["https://www.viarail.ca/sites/all/files/gtfs/viarail.zip"],
			region: "CA",
			timezone: "America/Toronto",
			realtime: null,
			mergeStops: [
				{ to: "UN", from: ["119"] },
				{ to: "OS", from: ["367"] },
				{ to: "KI", from: ["114"] },
				{ to: "AL", from: ["600"] },
				{ to: "OA", from: ["436"] },
				{ to: "GU", from: ["450"] },
				{ to: "BR", from: ["322"] },
				{ to: "GE", from: ["6"] },
				{ to: "MA", from: ["34"] },
				{ to: "NI", from: ["346"] },
				{ to: "SCTH", from: ["185"] },
			],
		}) as TraxConfigOptions,
	"CA/GTHA": (apiKey) =>
		({
			urls: [
				"https://assets.metrolinx.com/raw/upload/Documents/Metrolinx/Open%20Data/UP-GTFS.zip",
				"https://assets.metrolinx.com/raw/upload/Documents/Metrolinx/Open%20Data/GO-GTFS.zip",
				"https://www.viarail.ca/sites/all/files/gtfs/viarail.zip",
			],
			region: "CA/GTHA",
			timezone: "America/Toronto",
			realtime: {
				realtimeAlerts: [
					"https://api.openmetrolinx.com/OpenDataAPI/api/V1/UP/Gtfs.proto/Feed/Alerts?key=" + apiKey,
					"https://api.openmetrolinx.com/OpenDataAPI/api/V1/Gtfs.proto/Feed/Alerts?key=" + apiKey,
				],
				realtimeTripUpdates: [
					"https://api.openmetrolinx.com/OpenDataAPI/api/V1/UP/Gtfs.proto/Feed/TripUpdates?key=" + apiKey,
					"https://api.openmetrolinx.com/OpenDataAPI/api/V1/Gtfs.proto/Feed/TripUpdates?key=" + apiKey,
				],
				realtimeVehiclePositions: [
					"https://api.openmetrolinx.com/OpenDataAPI/api/V1/UP/Gtfs.proto/Feed/VehiclePosition?key=" + apiKey,
					"https://api.openmetrolinx.com/OpenDataAPI/api/V1/Gtfs.proto/Feed/VehiclePosition?key=" + apiKey,
				],
			},
			mergeStops: [
				{ to: "UN", from: ["119"] },
				{ to: "OS", from: ["367"] },
				{ to: "KI", from: ["114"] },
				{ to: "AL", from: ["600"] },
				{ to: "OA", from: ["436"] },
				{ to: "GU", from: ["450"] },
				{ to: "BR", from: ["322"] },
				{ to: "GE", from: ["6"] },
				{ to: "MA", from: ["34"] },
				{ to: "NI", from: ["346"] },
				{ to: "SCTH", from: ["185"] },
			],
		}) as TraxConfigOptions,
};

export function resolveConfig(options: TraxConfigOptions = {}): TraxConfig {
	const normalizeFeeds = (
		feeds: (string | GTFSFeedConfig)[] | string | GTFSFeedConfig | null | undefined,
	): (string | GTFSFeedConfig)[] | null => {
		if (feeds === null || feeds === undefined) return null;
		if (Array.isArray(feeds)) return feeds;
		return [feeds];
	};

	const staticUrls: (string | GTFSFeedConfig)[] =
		options.urls ??
		(options.url
			? [{ url: options.url, headers: options.headers ?? undefined }]
			: ["https://gtfsrt.api.translink.com.au/GTFS/SEQ_GTFS.zip"]);

	const defaults: TraxConfig = {
		urls: ["https://gtfsrt.api.translink.com.au/GTFS/SEQ_GTFS.zip"],
		verbose: true,
		cacheDir: ".TRAXCACHE",
		logFunction: (message: string) => logger.debug(message, { module: "gtfs" }),
		progressLog: (info: ProgressInfo) => logger.progress(info),
		region: "AU/SEQ",
		timezone: "Australia/Brisbane",
		realtime: {
			realtimeAlerts: ["https://gtfsrt.api.translink.com.au/api/realtime/SEQ/alerts"],
			realtimeTripUpdates: ["https://gtfsrt.api.translink.com.au/api/realtime/SEQ/TripUpdates"],
			realtimeVehiclePositions: ["https://gtfsrt.api.translink.com.au/api/realtime/SEQ/VehiclePositions"],
		},
		mergeStops: [],
	};

	const resolvedRealtime = options.realtime
		? {
				realtimeAlerts: normalizeFeeds(options.realtime.realtimeAlerts),
				realtimeTripUpdates: normalizeFeeds(options.realtime.realtimeTripUpdates),
				realtimeVehiclePositions: normalizeFeeds(options.realtime.realtimeVehiclePositions),
			}
		: options.url || options.urls
			? null
			: defaults.realtime;

	return {
		...defaults,
		...options,
		urls: staticUrls,
		realtime: resolvedRealtime as TraxConfig["realtime"],
		mergeStops: options.mergeStops ?? defaults.mergeStops,
	};
}
