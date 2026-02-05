import { CacheContext } from "../../../cache.js";
import { MergeAction } from "../../../config.js";
import logger from "../../../utils/logger.js";
import * as qdf from "qdf-gtfs";

const VIA_INJECTED_FEED_ID = "VIA-INJECTED";

// Root type for the JSON structure
export type AllTrainData = Record<string, TrainData>;

export interface TrainData {
	// Tracking information is optional (e.g., missing for some regional trains or future departures)
	lat?: number;
	lng?: number;
	speed?: number;
	direction?: number;
	poll?: string; // ISO 8601 Date String (e.g., "2026-01-20T18:34:43Z")

	// Alerts are optional
	alerts?: Alert[];

	departed: boolean;
	arrived: boolean;
	from: string; // Station name except all caps - not reliable
	to: string; // Station name except all caps - not reliable
	instance: string; // Date String (YYYY-MM-DD), matches augmentedTripinstance except remove - from date

	pollMin?: number;
	pollRadius?: number;

	times: StationTime[];
}

export interface Alert {
	header: LocalizedText;
	description: LocalizedText;
	url: LocalizedText;
}

export interface LocalizedText {
	en: string;
	fr: string;
}

export interface StationTime {
	station: string; // Station name
	code: string; // stop.stop_code (not stop_id)

	// 'estimated' at the root of the time object is always a string,
	// either an ISO date or the entity code "&mdash;"
	estimated: string;

	scheduled: string; // ISO 8601 Date String

	// ETA formats include "ARR", relative time (e.g., "37 mins", "1h10", "< 1 min"), or "&mdash;"
	eta: string;

	// 'diff' and 'diffMin' are optional (e.g., missing for future stations or undetermined status)
	diff?: "goo" | "med" | "bad";
	diffMin?: number; // Can be negative (e.g., -7)

	arrival?: ArrivalDepartureInfo;
	departure?: ArrivalDepartureInfo;
}

export interface ArrivalDepartureInfo {
	// 'estimated' can be an ISO date string, null (explicitly null in some future trains), or omitted entirely
	estimated?: string | null;
	scheduled: string; // ISO 8601 Date String
}

let codeIdMap: Map<string, string> | null = null;

// Converts from VIA GTFS stop_code to VIA GTFS stop_id
const VIA_CODE_SWAP: Record<string, string> = {
	TRTO: "119",
	OSHA: "367",
	KITC: "114",
	GUIL: "450",
	OAKV: "436",
	BRMP: "322",
	ALDR: "600",
	GEOR: "6",
	MALT: "34",
	NIAG: "346",
	SCAT: "185",
	"119": "TRTO",
	"367": "OSHA",
	"114": "KITC",
	"450": "GUIL",
	"436": "OAKV",
	"322": "BRMP",
	"600": "ALDR",
	"6": "GEOR",
	"34": "MALT",
	"346": "NIAG",
	"185": "SCAT",
};

export const VIA_MERGE_STOPS: MergeAction[] = [
	{ to: VIA_CODE_SWAP["TRTO"], from: ["UN"] },
	{ to: VIA_CODE_SWAP["OSHA"], from: ["OS"] },
	{ to: VIA_CODE_SWAP["KITC"], from: ["KI"] },
	{ to: VIA_CODE_SWAP["ALDR"], from: ["AL"] },
	{ to: VIA_CODE_SWAP["OAKV"], from: ["OA"] },
	{ to: VIA_CODE_SWAP["GUIL"], from: ["GU"] },
	{ to: VIA_CODE_SWAP["BRMP"], from: ["BR"] },
	{ to: VIA_CODE_SWAP["GEOR"], from: ["GE"] },
	{ to: VIA_CODE_SWAP["MALT"], from: ["MA"] },
	{ to: VIA_CODE_SWAP["NIAG"], from: ["NI"] },
	{ to: VIA_CODE_SWAP["SCAT"], from: ["SCTH"] },
];

export const VIA_UPDATE_STOPS: {
	stop_id: string;
	new: Partial<qdf.Stop>;
}[] = [
	{
		stop_id: VIA_CODE_SWAP["TRTO"],
		new: {
			stop_name: "Toronto Union",
		},
	},
];

let prevTrainData: AllTrainData | null = null;
export function getPrevTrainData(): AllTrainData | null {
	return prevTrainData;
}

let lastUpdateMs = 0;
const UPDATE_THROTTLE_MS = 2 * 60 * 1000;

export async function fetchTrainData() {
	logger.debug("Fetching VIA Rail realtime data...", {
		module: "VIA",
		function: "fetchTrainData",
	});
	let res = await fetch("https://tsimobile.viarail.ca/data/allData.json");
	const data: AllTrainData = await res.json();
	prevTrainData = data;
	logger.debug("Done!", {
		module: "VIA",
		function: "fetchTrainData",
	});
	return data;
}

export async function updateRealtime(ctx: CacheContext) {
	const now = Date.now();
	if (now - lastUpdateMs < UPDATE_THROTTLE_MS) return;

	if (!ctx.gtfs) {
		logger.error("Attempted to update VIA realtime before GTFS initialization!!", {
			module: "VIA",
			function: "updateRealtime",
		});
		return;
	}

	lastUpdateMs = now;

	if (!codeIdMap) {
		codeIdMap = new Map();
		const stops = ctx.gtfs.getStops();
		const codeToId = new Map<string, string>();
		for (const stop of stops) {
			if (!stop.stop_code) continue;
			codeToId.set(stop.stop_code, stop.stop_id);
		}

		// Map VIA codes (e.g., TRTO) -> internal IDs (e.g., 119) -> Final Merge Targets (e.g., UN)
		for (const [viaCode, gtfsCodeOrId] of Object.entries(VIA_CODE_SWAP)) {
			// Find if this VIA ID/code is redirected to a canonical ID (like Union -> UN)
			const mergeTarget = ctx.config.mergeStops.find((m) => m.from.includes(gtfsCodeOrId))?.to;
			const finalId = mergeTarget || codeToId.get(gtfsCodeOrId) || gtfsCodeOrId;

			codeIdMap.set(viaCode, finalId);
		}

		// Fill in any missing stop_codes from the GTFS directly
		for (const [code, id] of codeToId.entries()) {
			const mergeTarget = ctx.config.mergeStops.find((m) => m.from.includes(id))?.to;
			if (!codeIdMap.has(code)) codeIdMap.set(code, mergeTarget || id);
		}
	}

	try {
		logger.debug("Fetching VIA Rail realtime data...", {
			module: "VIA",
			function: "updateRealtime",
		});
		let res = await fetch("https://tsimobile.viarail.ca/data/allData.json");
		const data: AllTrainData = await res.json();

		prevTrainData = data;

		const tripUpdates: qdf.RealtimeTripUpdate[] = [];
		const vehiclePositions: qdf.RealtimeVehiclePosition[] = [];

		for (const [tripNumber, train] of Object.entries(data)) {
			// Find matching trip_id in GTFS. Check trip_id and trip_short_name.
			const matchingTrips = ctx.gtfs.getTrips({
				trip_short_name: tripNumber,
				feed_id: "VIA",
			});
			if (matchingTrips.length === 0) continue;

			// For now, take the first one OR try to find a better match if needed
			// Usually there's only one trip ending with that number in the current slice
			const gtfsTrip = matchingTrips[0];
			const startDate = train.instance.replace(/-/g, "");

			const stopTimeUpdates: qdf.RealtimeStopTimeUpdate[] = [];

			for (const time of train.times) {
				const stopId = codeIdMap.get(time.code) || time.code;
				if (!stopId) continue;

				const arrivalTime = time.arrival?.estimated ? new Date(time.arrival.estimated).getTime() / 1000 : null;
				const departureTime = time.departure?.estimated
					? new Date(time.departure.estimated).getTime() / 1000
					: null;

				const stu: qdf.RealtimeStopTimeUpdate = {
					stop_sequence: null,
					stop_id: stopId,
					trip_id: gtfsTrip.trip_id,
					start_date: startDate,
					start_time: null,
					arrival_delay: time.diffMin !== undefined ? time.diffMin * 60 : null,
					arrival_time: arrivalTime,
					arrival_uncertainty: null,
					departure_delay: time.diffMin !== undefined ? time.diffMin * 60 : null,
					departure_time: departureTime,
					departure_uncertainty: null,
					schedule_relationship: qdf.StopTimeScheduleRelationship.SCHEDULED,
					feed_id: VIA_INJECTED_FEED_ID,
				};
				stopTimeUpdates.push(stu);
			}

			const tripInfo: qdf.RealtimeUpdateTripInfo = {
				trip_id: gtfsTrip.trip_id,
				route_id: gtfsTrip.route_id,
				direction_id: gtfsTrip.direction_id,
				start_time: "", // We don't have this easily but it's not strictly necessary if trip_id is fixed
				start_date: startDate,
				schedule_relationship: qdf.TripScheduleRelationship.SCHEDULED,
				feed_id: VIA_INJECTED_FEED_ID,
			};

			tripUpdates.push({
				update_id: `VIA_${tripNumber}_${startDate}`,
				is_deleted: false,
				trip: tripInfo,
				vehicle: {
					id: tripNumber,
					label: tripNumber,
					license_plate: "",
				},
				stop_time_updates: stopTimeUpdates,
				timestamp: Math.floor(now / 1000),
				delay: train.times[0]?.diffMin !== undefined ? train.times[0].diffMin * 60 : null,
				feed_id: VIA_INJECTED_FEED_ID,
			});

			if (train.lat !== undefined && train.lng !== undefined) {
				vehiclePositions.push({
					update_id: `VIA_POS_${tripNumber}_${startDate}`,
					is_deleted: false,
					trip: tripInfo,
					vehicle: {
						id: tripNumber,
						label: tripNumber,
						license_plate: "",
					},
					position: {
						latitude: train.lat,
						longitude: train.lng,
						bearing: train.direction || null,
						odometer: null,
						speed: (train.speed || 0) / 3.6, // km/h to m/s
					},
					current_stop_sequence: null,
					stop_id: "",
					current_status: null,
					timestamp: train.poll ? new Date(train.poll).getTime() / 1000 : Math.floor(now / 1000),
					congestion_level: null,
					occupancy_status: null,
					occupancy_percentage: null,
				});
			}
		}

		ctx.raw.injectedTripUpdates = tripUpdates;
		ctx.raw.injectedVehiclePositions = vehiclePositions;

		logger.debug(`VIA realtime updated: ${tripUpdates.length} trips, ${vehiclePositions.length} positions.`, {
			module: "VIA",
			function: "updateRealtime",
		});
	} catch (e) {
		logger.error(`Failed to perform VIA realtime updates! ${(e as any).message ?? e}`, {
			module: "VIA",
			function: "updateRealtime",
		});
		console.error(e);
	}
}
