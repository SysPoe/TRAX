import { ProgressInfo, GTFSFeedConfig, Stop } from "qdf-gtfs";
import logger from "./utils/logger.js";
import { VIA_MERGE_STOPS, VIA_UPDATE_STOPS } from "./region-specific/CA/VIA/realtime.js";

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
	disableTimers: boolean;
	preloadStopTimes: boolean;
	realtime: {
		realtimeAlerts: (string | GTFSFeedConfig)[] | null;
		realtimeTripUpdates: (string | GTFSFeedConfig)[] | null;
		realtimeVehiclePositions: (string | GTFSFeedConfig)[] | null;
	} | null;
	mergeStops: MergeAction[];
	updateStopActions: {
		stop_id: string;
		new: Partial<Stop>;
	}[];
}

export function isRegion(region: TraxConfig["region"] | null | undefined, target: string): boolean {
	if (!region) return false;
	return region === target || region.startsWith(`${target}/`);
}

export type TraxConfigOptions = Partial<Omit<TraxConfig, "realtime">> & {
	url?: string;
	headers?: { [key: string]: string } | null;
	timezone?: string;
	disableTimers?: boolean;
	preloadStopTimes?: boolean;
	realtime?: {
		realtimeAlerts?: (string | GTFSFeedConfig)[] | string | GTFSFeedConfig | null;
		realtimeTripUpdates?: (string | GTFSFeedConfig)[] | string | GTFSFeedConfig | null;
		realtimeVehiclePositions?: (string | GTFSFeedConfig)[] | string | GTFSFeedConfig | null;
	} | null;
	mergeStops?: MergeAction[] | null;
	updateStopActions?: {
		stop_id: string;
		new: Partial<Stop>;
	}[];
};

export const PRESETS: Record<TRAXRegion, (apiKey?: string | undefined) => TraxConfigOptions> = {
	"AU/SEQ": () =>
		({
			urls: [
				{
					url: "https://gtfsrt.api.translink.com.au/GTFS/SEQ_GTFS.zip",
					feed_id: "SEQ",
				},
			],
			region: "AU/SEQ",
			timezone: "Australia/Brisbane",
			preloadStopTimes: false,
			realtime: {
				realtimeAlerts: [
					{
						url: "https://gtfsrt.api.translink.com.au/api/realtime/SEQ/alerts",
						feed_id: "SEQ-RTA",
					},
				],
				realtimeTripUpdates: [
					{
						url: "https://gtfsrt.api.translink.com.au/api/realtime/SEQ/TripUpdates",
						feed_id: "SEQ-RTTU",
					},
				],
				realtimeVehiclePositions: [
					{
						url: "https://gtfsrt.api.translink.com.au/api/realtime/SEQ/VehiclePositions",
						feed_id: "SEQ-RTVP",
					},
				],
			},
		}) as TraxConfigOptions,
	CA: () =>
		({
			urls: [
				{
					url: "https://www.viarail.ca/sites/all/files/gtfs/viarail.zip",
					feed_id: "VIA",
				},
			],
			region: "CA",
			timezone: "America/Toronto",
			preloadStopTimes: false,
			realtime: null,
			mergeStops: VIA_MERGE_STOPS,
			updateStopActions: VIA_UPDATE_STOPS,
		}) as TraxConfigOptions,
	"CA/GTHA": (apiKey) =>
		({
			urls: [
				{
					url: "https://assets.metrolinx.com/raw/upload/Documents/Metrolinx/Open%20Data/UP-GTFS.zip",
					feed_id: "UP",
				},
				{
					url: "https://assets.metrolinx.com/raw/upload/Documents/Metrolinx/Open%20Data/GO-GTFS.zip",
					feed_id: "GO",
				},
				{
					url: "https://www.viarail.ca/sites/all/files/gtfs/viarail.zip",
					feed_id: "VIA",
				},
			],
			region: "CA/GTHA",
			timezone: "America/Toronto",
			preloadStopTimes: false,
			realtime: {
				realtimeAlerts: [
					{
						url: "https://api.openmetrolinx.com/OpenDataAPI/api/V1/UP/Gtfs.proto/Feed/Alerts?key=" + apiKey,
						feed_id: "UP-RTA",
					},
					{
						url: "https://api.openmetrolinx.com/OpenDataAPI/api/V1/Gtfs.proto/Feed/Alerts?key=" + apiKey,
						feed_id: "GO-RTA",
					},
				],
				realtimeTripUpdates: [
					{
						url:
							"https://api.openmetrolinx.com/OpenDataAPI/api/V1/UP/Gtfs.proto/Feed/TripUpdates?key=" +
							apiKey,
						feed_id: "UP-RTTU",
					},
					{
						url:
							"https://api.openmetrolinx.com/OpenDataAPI/api/V1/Gtfs.proto/Feed/TripUpdates?key=" +
							apiKey,
						feed_id: "GO-RTTU",
					},
				],
				realtimeVehiclePositions: [
					{
						url:
							"https://api.openmetrolinx.com/OpenDataAPI/api/V1/UP/Gtfs.proto/Feed/VehiclePosition?key=" +
							apiKey,
						feed_id: "UP-RTVP",
					},
					{
						url:
							"https://api.openmetrolinx.com/OpenDataAPI/api/V1/Gtfs.proto/Feed/VehiclePosition?key=" +
							apiKey,
						feed_id: "GO-RTVP",
					},
				],
			},
			mergeStops: VIA_MERGE_STOPS,
			updateStopActions: VIA_UPDATE_STOPS,
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
		disableTimers: true,
		preloadStopTimes: false,
		realtime: {
			realtimeAlerts: ["https://gtfsrt.api.translink.com.au/api/realtime/SEQ/alerts"],
			realtimeTripUpdates: ["https://gtfsrt.api.translink.com.au/api/realtime/SEQ/TripUpdates"],
			realtimeVehiclePositions: ["https://gtfsrt.api.translink.com.au/api/realtime/SEQ/VehiclePositions"],
		},
		mergeStops: [],
		updateStopActions: [],
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
