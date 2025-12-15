import fs from "fs";
import path from "path";
import logger from "./logger.js";
import { AugmentedStopTime } from "./augmentedStopTime.js";
import { AugmentedTrip } from "./augmentedTrip.js";
import { getRawRoutes } from "../cache.js";
import zlib from "zlib";
import { pipeline } from "stream";
import { promisify } from "util";
import { getCacheFilePath, getDataFilePath } from "./fs.js";
import { TRAX_CONFIG } from "../config.js";

const pipe = promisify(pipeline);

const FILE_PATH = getCacheFilePath("service_capacity.csv");

export type ServiceCapacityData = {
	_id: string;
	route: string;
	direction: string;
	day_type: string;
	stop: string;
	stop_quarter_hour: string;
	availability: string;
};

type CapacityIndex = Map<string, Map<string, Map<string, Map<string, Map<string, string>>>>>;

let capacityIndex: CapacityIndex = new Map();
let loaded = false;

function getMap<K, V>(map: Map<K, V>, key: K, factory: () => V): V {
	let val = map.get(key);
	if (!val) {
		val = factory();
		map.set(key, val);
	}
	return val;
}

export async function ensureServiceCapacityData(): Promise<void> {
	if (!fs.existsSync(TRAX_CONFIG.cacheDir)) {
		fs.mkdirSync(TRAX_CONFIG.cacheDir, { recursive: true });
	}

	// If file doesn't exist, extract from embedded archive
	if (!fs.existsSync(FILE_PATH)) {
		logger.info("Extracting service capacity data from local archive...", { module: "serviceCapacity" });
		try {
			const zipPath = getDataFilePath("service_capacity.csv.gz");

			await pipe(fs.createReadStream(zipPath), zlib.createGunzip(), fs.createWriteStream(FILE_PATH));
			logger.info("Service capacity data extracted.", { module: "serviceCapacity" });
		} catch (e) {
			logger.error(`Failed to extract service capacity data: ${e}`, { module: "serviceCapacity" });
		}
	}

	loadServiceCapacityData();
}

function loadServiceCapacityData() {
	if (!fs.existsSync(FILE_PATH)) {
		logger.warn("Service capacity file not found.", { module: "serviceCapacity" });
		return;
	}
	const content = fs.readFileSync(FILE_PATH, "utf-8");
	const lines = content.split("\n");

	const headers = lines[0].split(",").map((h) => h.trim().toLowerCase().replace(/"/g, ""));
	const hasId = headers[0] === "_id";

	capacityIndex = new Map();
	let count = 0;

	for (let i = 1; i < lines.length; i++) {
		const line = lines[i].trim();
		if (!line) continue;

		const parts = parseCSVLine(line);
		if (parts.length < (hasId ? 7 : 6)) continue;

		const row: ServiceCapacityData = {
			_id: hasId ? parts[0] : "",
			route: hasId ? parts[1] : parts[0],
			direction: hasId ? parts[2] : parts[1],
			day_type: hasId ? parts[3] : parts[2],
			stop: hasId ? parts[4] : parts[3],
			stop_quarter_hour: hasId ? parts[5] : parts[4],
			availability: hasId ? parts[6] : parts[5],
		};

		if (isFerryOrTram(row.route)) continue;

		const routeMap = getMap(capacityIndex, row.route, () => new Map());
		const dirMap = getMap(routeMap, row.direction, () => new Map());
		const dayMap = getMap(dirMap, row.day_type, () => new Map());

		const normalizedStopName = normalizeStopName(row.stop);
		const stopMap = getMap(dayMap, normalizedStopName, () => new Map());

		stopMap.set(row.stop_quarter_hour, row.availability);
		count++;
	}
	loaded = true;
	logger.info(`Loaded ${count} service capacity entries.`, { module: "serviceCapacity" });
}

function parseCSVLine(line: string): string[] {
	const result: string[] = [];
	let current = "";
	let inQuotes = false;

	for (let i = 0; i < line.length; i++) {
		const char = line[i];
		if (char === '"') {
			inQuotes = !inQuotes;
		} else if (char === "," && !inQuotes) {
			result.push(current.trim());
			current = "";
		} else {
			current += char;
		}
	}
	result.push(current.trim());
	return result;
}

function isFerryOrTram(route: string): boolean {
	const r = route.toLowerCase();
	return r.includes("ferry") || r.includes("tram") || r.includes("g link") || r.includes("island");
}

function normalizeStopName(csvStop: string): string {
	const parts = csvStop.split(" - ");
	if (parts.length > 1) {
		return parts.slice(1).join(" - ").toLowerCase().trim();
	}
	return csvStop.toLowerCase().trim();
}

const CITY_STATIONS = [
	"place_censta", // Central
	"place_romsta", // Roma Street
	"place_forsta", // Fortitude Valley
	"place_bowsta", // Bowen Hills
	"place_sousta", // South Brisbane
	"place_sbasta", // South Bank
];

function getDayType(dateStr: string): string {
	const y = parseInt(dateStr.slice(0, 4));
	const m = parseInt(dateStr.slice(4, 6)) - 1;
	const d = parseInt(dateStr.slice(6, 8));
	const date = new Date(y, m, d);
	const day = date.getDay();

	if (day === 0) return "Sunday/Public Holiday";
	if (day === 6) return "Saturday";

	const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
	return days[day];
}

function formatTimeBucket(seconds: number): string {
	const minutesTotal = Math.round(seconds / 60);
	const remainder = minutesTotal % 15;
	let roundedMinutes = minutesTotal;
	if (remainder < 8) {
		roundedMinutes = minutesTotal - remainder;
	} else {
		roundedMinutes = minutesTotal + (15 - remainder);
	}

	let h = Math.floor(roundedMinutes / 60) % 24;
	let m = roundedMinutes % 60;

	const ampm = h >= 12 ? "PM" : "AM";
	let h12 = h % 12;
	if (h12 === 0) h12 = 12;

	const mStr = m.toString().padStart(2, "0");
	return `${h12}:${mStr} ${ampm}`;
}

function getTripDirection(trip: AugmentedTrip, currentStopSequence: number, currentStopTime: AugmentedStopTime): "Inbound" | "Outbound" | null {
	const instance = trip.instances.find(i => i.stopTimes.includes(currentStopTime));
	const stopTimes = instance ? instance.stopTimes : [];

	if (stopTimes.length === 0) {
		return null;
	}

	let firstCityIndex = -1;
	let lastCityIndex = -1;

	for (let i = 0; i < stopTimes.length; i++) {
		const st = stopTimes[i];
		const stopId = st.scheduled_parent_station?.stop_id || st.scheduled_stop?.stop_id;
		if (stopId && CITY_STATIONS.includes(stopId)) {
			if (firstCityIndex === -1) firstCityIndex = i;
			lastCityIndex = i;
		}
	}

	if (firstCityIndex === -1) {
		const dirId = trip.direction_id;
		if (dirId === 0) return "Inbound";
		if (dirId === 1) return "Outbound";
		return null;
	}

	const centralIndex = stopTimes.findIndex(
		(st) =>
			st.scheduled_parent_station?.stop_id === "place_censta" || st.scheduled_stop?.stop_id === "place_censta",
	);

	if (centralIndex !== -1) {
		if (currentStopSequence < stopTimes[centralIndex]._stopTime?.stop_sequence!) {
			const firstStopId =
				stopTimes[0]?.scheduled_parent_station?.stop_id || stopTimes[0]?.scheduled_stop?.stop_id;
			if (firstStopId && CITY_STATIONS.includes(firstStopId)) {
				return "Outbound";
			}
			return "Inbound";
		}
		return "Outbound";
	}

	const romaIndex = stopTimes.findIndex(
		(st) =>
			st.scheduled_parent_station?.stop_id === "place_romsta" || st.scheduled_stop?.stop_id === "place_romsta",
	);
	if (romaIndex !== -1) {
		if (currentStopSequence < stopTimes[romaIndex]._stopTime?.stop_sequence!) {
			const firstStopId =
				stopTimes[0]?.scheduled_parent_station?.stop_id || stopTimes[0]?.scheduled_stop?.stop_id;
			if (firstStopId && CITY_STATIONS.includes(firstStopId)) {
				return "Outbound";
			}
			return "Inbound";
		}
		return "Outbound";
	}

	const dirId = trip.direction_id;
	if (dirId === 0) return "Inbound";
	if (dirId === 1) return "Outbound";
	return "Inbound";
}

const ROUTE_KEYWORD_MAP: Record<string, string> = {
	Airport: "Airport Line",
	Beenleigh: "Beenleigh Line",
	Caboolture: "Caboolture Line",
	Cleveland: "Cleveland Line",
	Doomben: "Doomben Line",
	"Ferny Grove": "Ferny Grove Line",
	"Varsity Lakes": "Gold Coast Line",
	"Gold Coast": "Gold Coast Line",
	Ipswich: "Ipswich/Rosewood Lines",
	Rosewood: "Ipswich/Rosewood Lines",
	"Redcliffe Peninsula": "Redcliffe Peninsula Line",
	Shorncliffe: "Shorncliffe Line",
	Springfield: "Springfield Line",
	Nambour: "Sunshine Coast Line",
	Gympie: "Sunshine Coast Line",
	"Gympie North": "Sunshine Coast Line",
	"Sunshine Coast": "Sunshine Coast Line",
};

export function getServiceCapacity(
	trip: AugmentedTrip,
	stopTime: AugmentedStopTime,
	dateStr: string,
	_dirOverride?: string,
): string | null {
	if (!loaded) return null;

	const route = getRawRoutes(trip.route_id)[0];
	const routeName = route?.route_long_name;
	if (!routeName) return null;

	const seq = stopTime._stopTime?.stop_sequence ?? 0;
	const direction = _dirOverride ?? getTripDirection(trip, seq, stopTime);
	if (!direction) return null;

	const dayType = getDayType(dateStr);

	let stopName = stopTime.scheduled_parent_station?.stop_name ?? stopTime.scheduled_stop?.stop_name;
	if (!stopName) return null;
	if (stopName.trim().toLowerCase().startsWith("boggo")) stopName = "Park Road";
	if (stopName.trim().toLowerCase().startsWith("international")) stopName = "International Terminal";
	if (stopName.trim().toLowerCase().startsWith("domestic")) stopName = "Domestic Terminal";

	const normStopName = stopName.toLowerCase().trim();

	const departureTime = stopTime.scheduled_departure_time;
	if (departureTime === null) return null;

	const timeBucket = formatTimeBucket(departureTime);

	// Map routeName (e.g. "Brisbane City - Ferny Grove") to potential lines (e.g. "Ferny Grove Line")
	const routeParts = routeName.split(" - ");
	const candidateLines = new Set<string>();

	for (const part of routeParts) {
		const trimmed = part.trim();
		if (ROUTE_KEYWORD_MAP[trimmed]) {
			candidateLines.add(ROUTE_KEYWORD_MAP[trimmed]);
		}
	}

	if (candidateLines.size === 0) return null;

	for (const lineName of candidateLines) {
		const rMap = capacityIndex.get(lineName);
		if (!rMap) continue;

		const dMap = rMap.get(direction);
		if (!dMap) continue;

		const dayMap = dMap.get(dayType);
		if (!dayMap) continue;

		// Try exact match
		let sMap = dayMap.get(normStopName);

		// Try clean match
		if (!sMap) {
			const cleanName = normStopName.replace(" station", "").replace(" platform", "").trim();
			sMap = dayMap.get(cleanName);
		}

		if (sMap) {
			const val = sMap.get(timeBucket);
			if (val) return val;
		}
	}

	// If we loop through all candidates and find nothing, we return null.
	return null;
}

export const _test = {
	getDayType,
	formatTimeBucket,
	getTripDirection,
	loadServiceCapacityData,
	capacityIndex,
};
