import type { TraxConfig } from "../../../../config.js";
import { hasDataFile, loadDataFile } from "../../../../utils/fs.js";
import logger from "../../../../utils/logger.js";
import type { QRTStationDetails, QRTStations } from "./types.js";
import ensureQRTEnabled from "./enabled.js";

const QRT_STATIONS_DATA_PATH = "region-specific/AU/QRT-stations.json";

const QRT_STATION_ALIASES: Record<string, string[]> = {
	"brisbane central": ["central", "central station", "brisbane central station"],
	"townsville": ["townsville - charters towers road", "townsville stn.", "townsville stn"],
	"mt larcom": ["mount larcom", "mount larcom station", "mt. larcom", "mt larcom"],
};

function stripQRTDisplayPhrases(value: string): string {
	return value
		.replace(/\brailway station\b/g, " ")
		.replace(/\btravel centre\b/g, " ")
		.replace(/[?]/g, " ");
}

export function normalizeQRTStationLookupKey(value: string): string {
	return value
		.toLowerCase()
		.replace(/\bmount\b/g, "mt")
		.replace(/[()]/g, " ")
		.replace(/[.&]/g, " ")
		.replace(/-/g, " ")
		.replace(/\btravel centre\b/g, " ")
		.replace(/\brailway\b/g, " ")
		.replace(/\bstation\b/g, " ")
		.replace(/\broad\b/g, "rd")
		.replace(/\brd\.?\b/g, "rd")
		.replace(/\s+/g, " ")
		.trim();
}

export function getQRTStationCode(station: QRTStationDetails): string {
	if (station.qrt_PlaceCode) return station.qrt_PlaceCode;
	const stopCode = station.stops?.find((stop) => stop.startsWith("place_"));
	if (stopCode) return stopCode;
	return normalizeQRTStationLookupKey(station.Title).replace(/\s+/g, "-");
}

export function getQRTStationDisplayTitle(station: Pick<QRTStationDetails, "Title">): string {
	return stripQRTDisplayPhrases(station.Title)
		.replace(/^brisbane\s+-\s+/i, "")
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
	add(stripQRTDisplayPhrases(station.Title));
	add(station.Title.replace(/\s*\([^)]*\)\s*/g, " "));
	add(station.sub);
	add(station.al);
	add(station.zn);
	add(getQRTStationDisplayTitle(station));
	add(getQRTStationCode(station));

	for (const match of station.Title.matchAll(/\(([^)]+)\)/g)) {
		add(match[1]);
	}

	for (const alias of QRT_STATION_ALIASES[normalizeQRTStationLookupKey(station.Title)] ?? []) {
		add(alias);
	}

	return [...keys];
}

export function buildQRTStationLookupMap(stations: QRTStations): Map<string, QRTStationDetails> {
	const lookup = new Map<string, QRTStationDetails>();

	for (const station of Object.values(stations)) {
		for (const stopId of station.stops ?? []) {
			if (stopId && !lookup.has(stopId)) lookup.set(stopId, station);
		}
		for (const key of getQRTStationLookupKeys(station)) {
			if (!lookup.has(key)) lookup.set(key, station);
		}
	}

	return lookup;
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
