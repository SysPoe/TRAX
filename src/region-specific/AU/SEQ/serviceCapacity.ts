import fs from "fs";
import path from "path";
import logger from "../../../utils/logger.js";
import { AugmentedStopTime } from "../../../utils/augmentedStopTime.js";
import { AugmentedTripInstance, AugmentedTrip } from "../../../utils/augmentedTrip.js";
import { CacheContext, getAugmentedStops, getRawRoutes } from "../../../cache/index.js";
import zlib from "zlib";
import { pipeline } from "stream";
import { promisify } from "util";
import { getCacheFilePath, getDataFilePath } from "../../../utils/fs.js";
import { TraxConfig } from "../../../config.js";
import { ServiceCapacity } from "../../../utils/serviceCapacity.js";

const pipe = promisify(pipeline);

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

export async function ensureServiceCapacityData(config: TraxConfig): Promise<void> {
	const cacheDir = config.cacheDir;
	const FILE_PATH = getCacheFilePath("region-specific/seq/service_capacity.csv", cacheDir);
	const fileDir = path.dirname(FILE_PATH);

	if (!fs.existsSync(cacheDir)) {
		fs.mkdirSync(cacheDir, { recursive: true });
	}
	if (!fs.existsSync(fileDir)) {
		fs.mkdirSync(fileDir, { recursive: true });
	}

	// If file doesn't exist, extract from embedded archive
	if (!fs.existsSync(FILE_PATH)) {
		logger.debug("Extracting service capacity data from local archive...", { module: "serviceCapacity" });
		try {
			const zipPath = getDataFilePath("region-specific/seq/service_capacity.csv.gz");

			await pipe(fs.createReadStream(zipPath), zlib.createGunzip(), fs.createWriteStream(FILE_PATH));
			logger.debug("Service capacity data extracted.", { module: "serviceCapacity" });
		} catch (e) {
			logger.error(`Failed to extract service capacity data: ${e}`, { module: "serviceCapacity" });
		}
	}

	loadServiceCapacityData(cacheDir);
}

function loadServiceCapacityData(cacheDir: string) {
	const FILE_PATH = getCacheFilePath("region-specific/seq/service_capacity.csv", cacheDir);

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
	logger.debug(`Loaded ${count} service capacity entries.`, { module: "serviceCapacity" });
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

const dayTypeCache = new Map<string, string>();

function getDayType(dateStr: string): string {
	if (dayTypeCache.has(dateStr)) return dayTypeCache.get(dateStr)!;

	const y = parseInt(dateStr.slice(0, 4));
	const m = parseInt(dateStr.slice(4, 6)) - 1;
	const d = parseInt(dateStr.slice(6, 8));
	const date = new Date(y, m, d);
	const day = date.getDay();

	let res = "";
	if (day === 0) res = "Sunday/Public Holiday";
	else if (day === 6) res = "Saturday";
	else {
		const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
		res = days[day];
	}

	dayTypeCache.set(dateStr, res);
	return res;
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

function getTripDirection(inst: AugmentedTripInstance, currentStopSequence: number): "Inbound" | "Outbound" | null {
	const stopTimes = inst.stopTimes;

	if (stopTimes.length === 0) return null;

	const cache = inst._seq_direction_data ?? null;

	let centralIndex = -1;
	let romaIndex = -1;
	let firstCityIndex = -1;

	if (cache) {
		({ centralIndex, romaIndex, firstCityIndex } = cache);
	} else {
		for (let i = 0; i < stopTimes.length; i++) {
			const st = stopTimes[i];
			const stopId = st.scheduled_parent_station_id ?? st.scheduled_stop_id;
			if (stopId && CITY_STATIONS.includes(stopId)) {
				if (firstCityIndex === -1) firstCityIndex = i;
				if (stopId === "place_censta") centralIndex = i;
				if (stopId === "place_romsta") romaIndex = i;
			}
		}
		inst._seq_direction_data = { centralIndex, romaIndex, firstCityIndex };
	}

	if (firstCityIndex === -1) {
		const dirId = inst.direction_id;
		if (dirId === 0) {
			return "Inbound";
		}
		if (dirId === 1) {
			return "Outbound";
		}
		return null;
	}

	if (centralIndex !== -1) {
		if (currentStopSequence < stopTimes[centralIndex]._stopTime?.stop_sequence!) {
			const firstStopId = stopTimes[0]?.scheduled_parent_station_id ?? stopTimes[0]?.scheduled_stop_id;
			if (firstStopId && CITY_STATIONS.includes(firstStopId)) {
				return "Outbound";
			}
			return "Inbound";
		}
		return "Outbound";
	}

	if (romaIndex !== -1) {
		if (currentStopSequence < stopTimes[romaIndex]._stopTime?.stop_sequence!) {
			const firstStopId = stopTimes[0]?.scheduled_parent_station_id ?? stopTimes[0]?.scheduled_stop_id;
			if (firstStopId && CITY_STATIONS.includes(firstStopId)) {
				return "Outbound";
			}
			return "Inbound";
		}
		return "Outbound";
	}

	const dirId = inst.direction_id;
	if (dirId === 0) {
		return "Inbound";
	}
	if (dirId === 1) {
		return "Outbound";
	}
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
	inst: AugmentedTripInstance,
	stopTime: AugmentedStopTime,
	dateStr: string,
	_dirOverride: string | undefined,
	ctx: CacheContext,
): ServiceCapacity {
	if (!loaded || stopTime.passing) return ServiceCapacity.UNKNOWN;

	const route = getRawRoutes(ctx, inst.route_id)[0];
	const routeName = route?.route_long_name;
	if (!routeName) return ServiceCapacity.UNKNOWN;

	const seq = stopTime._stopTime?.stop_sequence ?? 0;
	const direction = _dirOverride ?? getTripDirection(inst, seq);
	if (!direction) return ServiceCapacity.UNKNOWN;

	const dayType = getDayType(dateStr);

	const stopLookupId = stopTime.scheduled_parent_station_id ?? stopTime.scheduled_stop_id;
	let stopName = stopLookupId ? getAugmentedStops(ctx, stopLookupId)[0]?.stop_name : undefined;
	if (!stopName) return ServiceCapacity.UNKNOWN;
	if (stopName.trim().toLowerCase().startsWith("boggo")) stopName = "Park Road";
	if (stopName.trim().toLowerCase().startsWith("international")) stopName = "International Terminal";
	if (stopName.trim().toLowerCase().startsWith("domestic")) stopName = "Domestic Terminal";

	const normStopName = stopName.toLowerCase().trim();

	const departureTime =
		stopTime.actual_departure_time ??
		stopTime.actual_arrival_time ??
		stopTime.scheduled_departure_time ??
		stopTime.scheduled_arrival_time;
	if (departureTime === null) return ServiceCapacity.UNKNOWN;

	const timeBucket = formatTimeBucket(departureTime);

	// Map routeName (e.g. "Brisbane City - Ferny Grove") to potential lines (e.g. "Ferny Grove Line")
	const routeParts = routeName.split(" - ");
	const candidateLines = new Set<string>();

	for (const part of routeParts) {
		const trimmed = part.trim();
		if (ROUTE_KEYWORD_MAP[trimmed]) candidateLines.add(ROUTE_KEYWORD_MAP[trimmed]);
	}

	if (candidateLines.size === 0) return ServiceCapacity.UNKNOWN;

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
			if (val)
				switch (val.trim()) {
					case "Space available":
						return ServiceCapacity.MANY_SEATS_AVAILABLE;
					case "Some space available":
						return ServiceCapacity.STANDING_ROOM_ONLY;
					case "Limited space available":
						return ServiceCapacity.FULL;
					default:
						return ServiceCapacity.UNKNOWN;
				}
		}
	}

	// If we loop through all candidates and find nothing, we return "unknown".
	return ServiceCapacity.UNKNOWN;
}

export function addSCI(inst: AugmentedTripInstance, ctx: CacheContext, config: TraxConfig): AugmentedTripInstance {
	let prevSC: ServiceCapacity = ServiceCapacity.UNKNOWN;
	inst.stopTimes.forEach((st) => {
		if (st.passing || st.service_capacity !== ServiceCapacity.NOT_CALCULATED) return;
		st.service_capacity = getServiceCapacity(inst, st, inst.serviceDate, undefined, ctx);
		if (st.service_capacity !== ServiceCapacity.NOT_CALCULATED) prevSC = st.service_capacity;
		else st.service_capacity = prevSC;
	});
	return inst;
}

export function addSC(trip: AugmentedTrip, ctx: CacheContext, config: TraxConfig): AugmentedTrip {
	trip.instances = trip.instances.map((v) => addSCI(v, ctx, config));
	return trip;
}

export const _test = {
	getDayType,
	formatTimeBucket,
	getTripDirection,
	loadServiceCapacityData,
	capacityIndex,
};
