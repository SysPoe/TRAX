import { ProgressInfo, GTFSFeedConfig } from "qdf-gtfs";
import logger from "./utils/logger.js";

export interface TraxConfig {
	urls: (string | GTFSFeedConfig)[];
	verbose: boolean;
	cacheDir: string;
	logFunction: (message: string) => void;
	progressLog: (info: ProgressInfo) => void;
	region: "SEQ" | "GTHA" | "none";
	realtime: {
		realtimeAlerts: (string | GTFSFeedConfig)[] | null;
		realtimeTripUpdates: (string | GTFSFeedConfig)[] | null;
		realtimeVehiclePositions: (string | GTFSFeedConfig)[] | null;
	} | null;
}

export type TraxConfigOptions = Partial<Omit<TraxConfig, "realtime">> & {
	url?: string;
	headers?: { [key: string]: string } | null;
	realtime?: {
		realtimeAlerts?: (string | GTFSFeedConfig)[] | string | GTFSFeedConfig | null;
		realtimeTripUpdates?: (string | GTFSFeedConfig)[] | string | GTFSFeedConfig | null;
		realtimeVehiclePositions?: (string | GTFSFeedConfig)[] | string | GTFSFeedConfig | null;
	} | null;
};

const METROLINX_KEY = process.env.METROLINX_KEY ?? "";

export const PRESETS: Record<"SEQ" | "GTHA", TraxConfigOptions> = {
	SEQ: {
		urls: ["https://gtfsrt.api.translink.com.au/GTFS/SEQ_GTFS.zip"],
		region: "SEQ",
		realtime: {
			realtimeAlerts: ["https://gtfsrt.api.translink.com.au/api/realtime/SEQ/alerts"],
			realtimeTripUpdates: ["https://gtfsrt.api.translink.com.au/api/realtime/SEQ/TripUpdates"],
			realtimeVehiclePositions: ["https://gtfsrt.api.translink.com.au/api/realtime/SEQ/VehiclePositions"],
		},
	},
	GTHA: {
		urls: ["https://assets.metrolinx.com/raw/upload/Documents/Metrolinx/Open%20Data/GO-GTFS.zip", "https://assets.metrolinx.com/raw/upload/Documents/Metrolinx/Open%20Data/UP-GTFS.zip"],
		region: "GTHA",
		realtime: {
			realtimeAlerts: ["https://api.openmetrolinx.com/OpenDataAPI/api/V1/Gtfs.proto/Feed/Alerts?key=" + METROLINX_KEY],
			realtimeTripUpdates: ["https://api.openmetrolinx.com/OpenDataAPI/api/V1/Gtfs.proto/Feed/TripUpdates?key=" + METROLINX_KEY],
			realtimeVehiclePositions: ["https://api.openmetrolinx.com/OpenDataAPI/api/V1/Gtfs.proto/Feed/VehiclePosition?key=" + METROLINX_KEY],
		}
	},
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
		(options.url ? [{ url: options.url, headers: options.headers ?? undefined }] : ["https://gtfsrt.api.translink.com.au/GTFS/SEQ_GTFS.zip"]);

	const defaults: TraxConfig = {
		urls: ["https://gtfsrt.api.translink.com.au/GTFS/SEQ_GTFS.zip"],
		verbose: true,
		cacheDir: ".TRAXCACHE",
		logFunction: (message: string) => logger.debug(message, { module: "gtfs" }),
		progressLog: (info: ProgressInfo) => logger.progress(info),
		region: "SEQ",
		realtime: {
			realtimeAlerts: ["https://gtfsrt.api.translink.com.au/api/realtime/SEQ/alerts"],
			realtimeTripUpdates: ["https://gtfsrt.api.translink.com.au/api/realtime/SEQ/TripUpdates"],
			realtimeVehiclePositions: ["https://gtfsrt.api.translink.com.au/api/realtime/SEQ/VehiclePositions"],
		},
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
	};
}
