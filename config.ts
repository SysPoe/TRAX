import { ProgressInfo } from "qdf-gtfs";
import logger from "./utils/logger.js";

export interface TraxConfig {
	url: string;
	headers?: { [key: string]: string } | null;
	verbose: boolean;
	cacheDir: string;
	logFunction: (message: string) => void;
	progressLog: (info: ProgressInfo) => void;
	region: "SEQ" | "none";
	realtime: {
		realtimeAlerts: { url: string; headers: { [key: string]: string } } | string | null;
		realtimeTripUpdates: { url: string; headers: { [key: string]: string } } | string | null;
		realtimeVehiclePositions: { url: string; headers: { [key: string]: string } } | string | null;
	} | null;
}

export type TraxConfigOptions = Partial<TraxConfig>;

export const PRESETS: Record<string, TraxConfigOptions> = {
	SEQ: {
		url: "https://gtfsrt.api.translink.com.au/GTFS/SEQ_GTFS.zip",
		region: "SEQ",
		realtime: {
			realtimeAlerts: "https://gtfsrt.api.translink.com.au/api/realtime/SEQ/alerts",
			realtimeTripUpdates: "https://gtfsrt.api.translink.com.au/api/realtime/SEQ/TripUpdates",
			realtimeVehiclePositions: "https://gtfsrt.api.translink.com.au/api/realtime/SEQ/VehiclePositions",
		},
	},
};

export function resolveConfig(options: TraxConfigOptions = {}): TraxConfig {
	const defaults: TraxConfig = {
		url: "https://gtfsrt.api.translink.com.au/GTFS/SEQ_GTFS.zip",
		headers: null,
		realtime: {
			realtimeAlerts: "https://gtfsrt.api.translink.com.au/api/realtime/SEQ/alerts",
			realtimeTripUpdates: "https://gtfsrt.api.translink.com.au/api/realtime/SEQ/TripUpdates",
			realtimeVehiclePositions: "https://gtfsrt.api.translink.com.au/api/realtime/SEQ/VehiclePositions",
		},
		verbose: true,
		cacheDir: ".TRAXCACHE",
		logFunction: (message: string) => logger.debug(message, { module: "gtfs" }),
		progressLog: (info: ProgressInfo) => logger.progress(info),
		region: "SEQ",
	};

	return {
		...defaults,
		...options,
		realtime: options.realtime || options.url ? options.realtime ?? null : defaults.realtime,
	};
}
