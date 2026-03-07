import type { TraxConfig } from "../../../../config.js";
import { hasDataFile, loadDataFile } from "../../../../utils/fs.js";
import logger from "../../../../utils/logger.js";
import type { QRTStationDetails, QRTStations } from "./types.js";
import ensureQRTEnabled from "./enabled.js";

const QRT_STATIONS_DATA_PATH = "region-specific/AU/QRT-stations.json";

export function normalizeQRTStationLookupKey(value: string): string {
	return value
		.toLowerCase()
		.replace(/[()]/g, " ")
		.replace(/\brailway\b/g, " ")
		.replace(/\bstation\b/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

export function getQRTStationLookupKeys(station: QRTStationDetails): string[] {
	const keys = new Set<string>();
	const add = (candidate?: string) => {
		if (!candidate) return;
		const normalized = normalizeQRTStationLookupKey(candidate);
		if (normalized) keys.add(normalized);
	};

	add(station.Title);
	add(station.Title.replace(/\s*\([^)]*\)\s*/g, " "));
	add(station.sub);

	for (const match of station.Title.matchAll(/\(([^)]+)\)/g)) {
		add(match[1]);
	}

	return [...keys];
}

export async function getQRTStations(config: TraxConfig): Promise<QRTStations> {
	ensureQRTEnabled(config);

	try {
		if (!hasDataFile(QRT_STATIONS_DATA_PATH)) {
			logger.warn(`QRT stations file not found at ${QRT_STATIONS_DATA_PATH}`, {
				module: "QRT-stations",
			});
			return {};
		}

		const data = loadDataFile(QRT_STATIONS_DATA_PATH);
		return JSON.parse(data) as QRTStations;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logger.error(`Failed to load QRT stations: ${message}`, {
			module: "QRT-stations",
		});
		return {};
	}
}
