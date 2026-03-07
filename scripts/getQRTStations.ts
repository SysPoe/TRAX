import fs from "fs";
import type { GTFS, Stop } from "qdf-gtfs";
import { PRESETS, resolveConfig } from "../src/config.js";
import { createGtfs } from "../src/gtfsInterfaceLayer.js";
import {
	getQRTStationLookupKeys,
	normalizeQRTStationLookupKey,
} from "../src/region-specific/AU/SEQ/qr-travel/stations.js";
import type { QRTStationDetails, QRTStations } from "../src/region-specific/AU/SEQ/qr-travel/types.js";

const OUTPUT_DIR = "data/region-specific/AU";
const OUTPUT_PATH = `${OUTPUT_DIR}/QRT-stations.json`;

function loadExistingStations(): QRTStations {
	if (!fs.existsSync(OUTPUT_PATH)) return {};
	return JSON.parse(fs.readFileSync(OUTPUT_PATH, "utf-8")) as QRTStations;
}

function getConsideredRailStations(gtfs: GTFS): Stop[] {
	const stations: Stop[] = [];
	const stationIds = new Set<string>();
	const seenPatterns = new Set<string>();

	for (const trip of gtfs.getTrips()) {
		if (gtfs.getRoutes({ route_id: trip.route_id })[0]?.route_type !== 2) continue;

		const stopTimes = gtfs.getStopTimes({ trip_id: trip.trip_id });
		const pattern = stopTimes.map((stopTime) => stopTime.stop_id).join("|");
		if (seenPatterns.has(pattern)) continue;
		seenPatterns.add(pattern);

		for (const stopTime of stopTimes) {
			const stop = gtfs.getStops({ stop_id: stopTime.stop_id })[0];
			if (!stop) continue;
			const stationId = stop.parent_station ?? stop.stop_id;
			if (stationIds.has(stationId)) continue;
			stationIds.add(stationId);

			const station = gtfs.getStops({ stop_id: stationId })[0];
			if (station) stations.push(station);
		}
	}

	return stations;
}

function buildStationLookup(gtfs: GTFS): {
	lookup: Map<string, Stop[]>;
	childrenByParent: Map<string, string[]>;
} {
	const lookup = new Map<string, Stop[]>();
	const childrenByParent = new Map<string, string[]>();

	for (const stop of gtfs.getStops()) {
		if (!stop.parent_station) continue;
		const children = childrenByParent.get(stop.parent_station) ?? [];
		children.push(stop.stop_id);
		childrenByParent.set(stop.parent_station, children);
	}

	for (const station of getConsideredRailStations(gtfs)) {
		const key = normalizeQRTStationLookupKey(station.stop_name ?? "");
		if (!key) continue;
		const matches = lookup.get(key) ?? [];
		matches.push(station);
		lookup.set(key, matches);
	}

	return { lookup, childrenByParent };
}

function getStationStopIds(station: Stop, childrenByParent: Map<string, string[]>): string[] {
	const stopIds = [
		station.stop_id,
		...(childrenByParent.get(station.stop_id) ?? []).sort((a, b) => a.localeCompare(b)),
	];
	return [...new Set(stopIds)];
}

function matchStationStopIds(
	station: QRTStationDetails,
	lookup: Map<string, Stop[]>,
	childrenByParent: Map<string, string[]>,
): string[] {
	for (const key of getQRTStationLookupKeys(station)) {
		const matches = lookup.get(key);
		if (!matches?.length) continue;
		return getStationStopIds(matches[0], childrenByParent);
	}

	return [];
}

async function loadSEQGTFS(): Promise<GTFS> {
	const config = resolveConfig({
		...PRESETS["AU/SEQ"](),
		realtime: null,
		disableTimers: true,
	});
	return createGtfs(config, false);
}

(async function () {
	const existingStations = loadExistingStations();
	const gtfsPromise = loadSEQGTFS();

	const namesRes = await fetch("https://www.queenslandrailtravel.com.au/SPWebApp/api/sd/GetStationNames", {
		headers: {
			"Content-Type": "application/json",
		},
	});
	const names = (await namesRes.json()) as string[];
	console.log("Got", names.length, "stations");
	let i = 0;
	const e = names.length;
	process.stdout.write(`Fetching station details: ${i}/${e}`);
	const stations: QRTStations = {};
	const promises = names.map(async (name: string) => {
		try {
			const res = await fetch(
				`https://www.queenslandrailtravel.com.au/SPWebApp/api/sd/GetStationDetails?id=${encodeURIComponent(name)}`,
				{
					headers: {
						"Content-Type": "application/json",
					},
				},
			);
			const details = (await res.json()) as QRTStationDetails;
			details.ln = Array.isArray(details.ln)
				? details.ln
				: String(details.ln)
						.split(",")
						.map((line) => line.trim())
						.filter(Boolean);
			stations[name] = details;
			i++;
			process.stdout.write(`Fetching station details: ${i}/${e}\r`);
		} catch (e) {
			console.log("\n\n");
			console.error(e);
			process.exit(1);
		}
	});
	await Promise.all(promises);
	console.log("\nDone fetching station details");

	const gtfs = await gtfsPromise;
	const { lookup, childrenByParent } = buildStationLookup(gtfs);
	let matched = 0;
	let preserved = 0;
	let unmatched = 0;

	for (const [name, details] of Object.entries(stations)) {
		const matchedStops = matchStationStopIds(details, lookup, childrenByParent);
		if (matchedStops.length > 0) {
			details.stops = matchedStops;
			matched++;
			continue;
		}

		const existingStops = existingStations[name]?.stops ?? [];
		if (existingStops.length > 0) {
			details.stops = existingStops;
			preserved++;
		} else {
			details.stops = [];
			unmatched++;
		}
	}

	fs.mkdirSync(OUTPUT_DIR, { recursive: true });
	fs.writeFileSync(OUTPUT_PATH, JSON.stringify(stations, null, 2));
	console.log(`Matched ${matched} stations to GTFS stops; preserved ${preserved}; unmatched ${unmatched}.`);
})();
