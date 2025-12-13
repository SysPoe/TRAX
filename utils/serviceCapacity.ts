import fs from "fs";
import path from "path";
import https from "https";
import { TRAX_CONFIG } from "../config.js";
import logger from "./logger.js";
import { AugmentedStopTime } from "./augmentedStopTime.js";
import { AugmentedTrip } from "./augmentedTrip.js";
import { getRawRoutes } from "../cache.js";

const CACHE_DIR = ".TRAXCACHE";
const FILE_NAME = "service_capacity.csv";
const FILE_PATH = path.join(CACHE_DIR, FILE_NAME);
const MAX_AGE_MS = 28 * 24 * 60 * 60 * 1000; // 28 days

// Data Structures
export type ServiceCapacityData = {
	_id: string; // May be empty if file doesn't have it
	route: string;
	direction: string;
	day_type: string;
	stop: string;
	stop_quarter_hour: string;
	availability: string;
};

// Map<Route, Map<Direction, Map<DayType, Map<StopName, Map<Time, Availability>>>>>
type CapacityIndex = Map<string, Map<string, Map<string, Map<string, Map<string, string>>>>>;

let capacityIndex: CapacityIndex = new Map();
let loaded = false;

// Helpers
function getMap<K, V>(map: Map<K, V>, key: K, factory: () => V): V {
	let val = map.get(key);
	if (!val) {
		val = factory();
		map.set(key, val);
	}
	return val;
}

export async function ensureServiceCapacityData(): Promise<void> {
	if (!fs.existsSync(CACHE_DIR)) {
		fs.mkdirSync(CACHE_DIR, { recursive: true });
	}

	let shouldDownload = true;

	if (fs.existsSync(FILE_PATH)) {
		const stats = fs.statSync(FILE_PATH);
		const age = Date.now() - stats.mtimeMs;
		if (age < MAX_AGE_MS) {
			shouldDownload = false;
		} else {
			logger.info("Service capacity data expired, downloading new file...", { module: "serviceCapacity" });
		}
	} else {
		logger.info("Service capacity data missing, downloading...", { module: "serviceCapacity" });
	}

	if (shouldDownload) {
		try {
			await downloadFile(TRAX_CONFIG.serviceCapacityUrl, FILE_PATH);
			logger.info("Service capacity data downloaded.", { module: "serviceCapacity" });
		} catch (e) {
			logger.error(`Failed to download service capacity data: ${e}`, { module: "serviceCapacity" });
		}
	}

	loadServiceCapacityData();
}

function downloadFile(url: string, dest: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const file = fs.createWriteStream(dest);
		https
			.get(url, (response) => {
				if (response.statusCode !== 200) {
					reject(new Error(`Failed to download file: status code ${response.statusCode}`));
					return;
				}
				response.pipe(file);
				file.on("finish", () => {
					file.close(() => resolve());
				});
			})
			.on("error", (err) => {
				fs.unlink(dest, () => {});
				reject(err);
			});
	});
}

function loadServiceCapacityData() {
	if (!fs.existsSync(FILE_PATH)) {
		logger.warn("Service capacity file not found.", { module: "serviceCapacity" });
		return;
	}
	const content = fs.readFileSync(FILE_PATH, "utf-8");
	const lines = content.split("\n");

	// Determine format by headers
	// Expected: _id,route,direction,day_type,stop,stop_quarter_hour,availability
	// Or: route,direction,day_type,stop,stop_quarter_hour,availability
	const headers = lines[0]
		.split(",")
		.map((h) => h.trim().toLowerCase().replace(/"/g, ""));
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

		// Indexing
		// Route -> Direction -> Day -> StopName -> Time -> Availability
		const routeMap = getMap(capacityIndex, row.route, () => new Map());
		const dirMap = getMap(routeMap, row.direction, () => new Map());
		const dayMap = getMap(dirMap, row.day_type, () => new Map());

		// Normalize stop name: "1 - Domestic Terminal" -> "Domestic Terminal"
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
    // Format "ID - Name" or just "Name"
    // e.g. "1 - Domestic Terminal" -> "domestic terminal"
    const parts = csvStop.split(' - ');
    if (parts.length > 1) {
        // Return everything after the first " - "
        return parts.slice(1).join(' - ').toLowerCase().trim();
    }
    return csvStop.toLowerCase().trim();
}

// --- Lookup Logic ---

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
	const day = date.getDay(); // 0 = Sunday, 1 = Monday, ...

	if (day === 0) return "Sunday/Public Holiday"; // Simple Assumption. Real logic needs holiday calendar.
	if (day === 6) return "Saturday";

    // Map number to string
    const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    return days[day];
    // Note: CSV uses "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday/Public Holiday"
    // Does it have distinct Sunday? "Sunday/Public Holiday" implies grouped.
}

function formatTimeBucket(seconds: number): string {
    // Round to nearest 15 mins
    // 5:00 AM -> 5:00 AM
    // 5:07 AM -> 5:00 AM or 5:15 AM?
    // User said: "if your service comes more frequently, services inside that time period will be grouped together"
    // Sample: "5:00 AM", "5:15 AM".

    // Let's use standard rounding.
    const minutesTotal = Math.round(seconds / 60);
    const remainder = minutesTotal % 15;
    let roundedMinutes = minutesTotal;
    if (remainder < 8) {
        roundedMinutes = minutesTotal - remainder;
    } else {
        roundedMinutes = minutesTotal + (15 - remainder);
    }

    // Normalize to 24h then convert to 12h AM/PM
    // Handle overflow (next day)
    let h = Math.floor(roundedMinutes / 60) % 24;
    let m = roundedMinutes % 60;

    const ampm = h >= 12 ? "PM" : "AM";
    let h12 = h % 12;
    if (h12 === 0) h12 = 12;

    const mStr = m.toString().padStart(2, '0');
    return `${h12}:${mStr} ${ampm}`;
}

function getTripDirection(trip: AugmentedTrip, currentStopSequence: number): "Inbound" | "Outbound" | null {
    // Heuristic:
    // "Inbound" = Heading towards City.
    // "Outbound" = Heading away from City.

    // Check where City Stations are in the trip sequence.
    // If we haven't reached them yet -> Inbound.
    // If we have passed them -> Outbound.

    // Find index of last city station in trip
    let firstCityIndex = -1;
    let lastCityIndex = -1;

    const stopTimes = trip.stopTimes;
    for (let i = 0; i < stopTimes.length; i++) {
        const st = stopTimes[i];
        const stopId = st.scheduled_parent_station?.stop_id || st.scheduled_stop?.stop_id;
        if (stopId && CITY_STATIONS.includes(stopId)) {
            if (firstCityIndex === -1) firstCityIndex = i;
            lastCityIndex = i;
        }
    }

    if (firstCityIndex === -1) {
        // Trip does not touch city.
        // Fallback to direction_id if available?
        // Or assume "Outbound" if it's not going to city?
        // Usually Interurban lines.
        // If direction_id is available:
        // 0: Generally Inbound (Towards Brisbane)
        // 1: Generally Outbound (Away from Brisbane)
        const dirId = trip._trip.direction_id;
        if (dirId === 0) return "Inbound";
        if (dirId === 1) return "Outbound";
        return null;
    }

    // If current stop is before the LAST city station -> Inbound (or Cross-City which counts as Inbound until it leaves)
    // Wait, "Outbound" usually starts at the City.
    // If a trip is Gold Coast -> Airport.
    // It is Inbound until Central.
    // Then Outbound from Central to Airport.

    // So if current stop index <= lastCityIndex -> Inbound?
    // No, if it's *at* Central, heading to Airport, is it Outbound?
    // Usually "Outbound" services depart from City.
    // So if current stop is a City Station, and we are not at the end of the trip...
    // Let's look at the sample:
    // "Airport Line, Inbound, ... Domestic Terminal". This is heading to City.
    // "Airport Line, Outbound, ... Central". This is heading to Airport.

    // So:
    // If we are heading TO the city (current index < firstCityIndex) -> Inbound.
    // If we are AT the city (first <= current <= last) -> ?
    //    Usually considered Outbound if departing? Or Inbound arriving?
    //    If I check capacity at Central for an Airport train, I want "Outbound" capacity.
    //    If I check capacity at Central for a Gold Coast train (which came from Airport), I want "Outbound" capacity.
    //    So if we are AT city, we usually look for Outbound capacity?
    //    Unless it terminates at City. Then it's Inbound capacity (arriving).

    // Refined Logic:
    // If current stop is *after* the start of the city zone -> Outbound.
    // If current stop is *before* the start of the city zone -> Inbound.
    // What about *within* the city zone?
    // e.g. Roma St -> Central.
    // It's part of the Inbound journey usually?
    // Let's assume:
    // If we are BEFORE the "main" city station (Central), it is Inbound.
    // If we are AT or AFTER Central, it is Outbound.

    // Let's simplify:
    // If the trip is going TO Central (and hasn't reached it), it is Inbound.
    // If the trip has passed Central (or is at Central), it is Outbound.

    const centralIndex = stopTimes.findIndex(st =>
        (st.scheduled_parent_station?.stop_id === "place_censta" || st.scheduled_stop?.stop_id === "place_censta")
    );

    if (centralIndex !== -1) {
        if (currentStopSequence < stopTimes[centralIndex].stop_sequence) return "Inbound";
        return "Outbound";
    }

    // No Central. Try Roma St.
    const romaIndex = stopTimes.findIndex(st =>
        (st.scheduled_parent_station?.stop_id === "place_romsta" || st.scheduled_stop?.stop_id === "place_romsta")
    );
     if (romaIndex !== -1) {
        if (currentStopSequence < stopTimes[romaIndex].stop_sequence) return "Inbound";
        return "Outbound";
    }

    // Fallback to direction_id
    const dirId = trip._trip.direction_id;
    if (dirId === 0) return "Inbound";
    if (dirId === 1) return "Outbound";
    return "Inbound"; // Default
}

export function getServiceCapacity(
    trip: AugmentedTrip,
    stopTime: AugmentedStopTime,
    dateStr: string
): string | null {
    if (!loaded) return null;

    // 1. Get Route Name
    // GTFS Route Name: "Airport Line".
    const route = getRawRoutes(trip._trip.route_id)[0];
    const routeName = route?.route_long_name;
    if (!routeName) return null;

    // 2. Get Direction
    // We need the stop sequence. In AugmentedStopTime, it's not directly exposed but we can find it in the trip's stop times
    // or cast if we know the internal structure.
    // Let's rely on finding the stopTime object in the trip's stopTimes array to be safe and use that index if needed,
    // OR just cast since we know it's there at runtime.
    // Ideally we should update AugmentedStopTime to include stop_sequence.
    // For now, let's just cast to any to avoid the error without @ts-ignore.
    const seq = (stopTime as any)._stopTime?.stop_sequence ?? 0;
    const direction = getTripDirection(trip, seq);
    if (!direction) return null;

    // 3. Get Day Type
    const dayType = getDayType(dateStr);

    // 4. Get Stop Name
    const stopName = stopTime.scheduled_parent_station?.stop_name || stopTime.scheduled_stop?.stop_name;
    if (!stopName) return null;
    const normStopName = stopName.toLowerCase().trim();

    // 5. Get Time
    const departureTime = stopTime.scheduled_departure_time;
    if (departureTime === null) return null;
    const timeBucket = formatTimeBucket(departureTime);

    // Lookup
    // Route -> Direction -> Day -> Stop -> Time
    const rMap = capacityIndex.get(routeName);
    if (!rMap) return null;

    const dMap = rMap.get(direction);
    if (!dMap) return null;

    const dayMap = dMap.get(dayType);
    if (!dayMap) {
        // Try fallback? "Monday" -> "Weekday"? CSV doesn't seem to have Weekday.
        // It has specific days.
        // If "Public Holiday", we map Sunday.
        return null;
    }

    const sMap = dayMap.get(normStopName);
    if (!sMap) {
        // Try fuzzy match?
        // "1 - Domestic Terminal" -> "domestic terminal" matched "Domestic Terminal Station"?
        // Remove "Station" suffix
        const cleanName = normStopName.replace(" station", "").replace(" platform", "").trim();
        const sMap2 = dayMap.get(cleanName);
        if (sMap2) return sMap2.get(timeBucket) || null;

        return null;
    }

    return sMap.get(timeBucket) || null;
}

export const _test = {
    getDayType,
    formatTimeBucket,
    getTripDirection,
    loadServiceCapacityData,
    capacityIndex
};
