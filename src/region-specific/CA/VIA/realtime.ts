import {
	type CacheContext,
	replaceInjectedTripUpdates,
	replaceInjectedVehiclePositions,
} from "../../../cache/index.js";
import { MergeAction } from "../../../config.js";
import logger from "../../../utils/logger.js";
import * as qdf from "qdf-gtfs";
import { getPluginState } from "../../../plugins/types.js";
import { entityKey } from "../../../identity.js";
import {
	buildCisBoardingAssignments,
	collectCisStationCandidates,
	refreshCisStationBoards,
	viaTrainKey,
	type CisBoardSnapshot,
	type ViaTripMatch,
} from "./station-board.js";

const VIA_STATIC_FEED_ID = "via";
const VIA_INJECTED_SOURCE_ID = "via-supplemental";

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
	cancelled?: boolean;
	replaced?: { mode: string; services: string[] };
}

export interface ArrivalDepartureInfo {
	// 'estimated' can be an ISO date string, null (explicitly null in some future trains), or omitted entirely
	estimated?: string | null;
	scheduled: string; // ISO 8601 Date String
}

type ViaRealtimeState = {
	codeIdMap: Map<string, string> | null;
	prevTrainData: AllTrainData | null;
	lastUpdateMs: number;
	mobileEtag: string | null;
	cisBoards: Map<string, CisBoardSnapshot>;
	tripMatches: Map<string, ViaTripMatch>;
};

function getState(ctx: CacheContext): ViaRealtimeState {
	return getPluginState(ctx, "ca-via:realtime", () => ({
		codeIdMap: null,
		prevTrainData: null,
		lastUpdateMs: 0,
		mobileEtag: null,
		cisBoards: new Map(),
		tripMatches: new Map(),
	}));
}

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
	{ to: VIA_CODE_SWAP["TRTO"], from: ["UN"], feedId: VIA_STATIC_FEED_ID },
	{ to: VIA_CODE_SWAP["OSHA"], from: ["OS"], feedId: VIA_STATIC_FEED_ID },
	{ to: VIA_CODE_SWAP["KITC"], from: ["KI"], feedId: VIA_STATIC_FEED_ID },
	{ to: VIA_CODE_SWAP["ALDR"], from: ["AL"], feedId: VIA_STATIC_FEED_ID },
	{ to: VIA_CODE_SWAP["OAKV"], from: ["OA"], feedId: VIA_STATIC_FEED_ID },
	{ to: VIA_CODE_SWAP["GUIL"], from: ["GU"], feedId: VIA_STATIC_FEED_ID },
	{ to: VIA_CODE_SWAP["BRMP"], from: ["BR"], feedId: VIA_STATIC_FEED_ID },
	{ to: VIA_CODE_SWAP["GEOR"], from: ["GE"], feedId: VIA_STATIC_FEED_ID },
	{ to: VIA_CODE_SWAP["MALT"], from: ["MA"], feedId: VIA_STATIC_FEED_ID },
	{ to: VIA_CODE_SWAP["NIAG"], from: ["NI"], feedId: VIA_STATIC_FEED_ID },
	{ to: VIA_CODE_SWAP["SCAT"], from: ["SCTH"], feedId: VIA_STATIC_FEED_ID },
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

export function getPrevTrainData(ctx: CacheContext): AllTrainData | null {
	return getState(ctx).prevTrainData;
}

const MOBILE_DATA_URL = "https://tsimobile.viarail.ca/data/allData.json";
const MOBILE_FETCH_TIMEOUT_MS = 10_000;
const UPDATE_THROTTLE_MS = 30_000;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertTrainData(value: unknown): asserts value is AllTrainData {
	if (!isRecord(value)) throw new TypeError("VIA mobile data must be an object");
	for (const [trainNumber, train] of Object.entries(value)) {
		if (!isRecord(train)) throw new TypeError(`VIA train '${trainNumber}' must be an object`);
		if (typeof train.departed !== "boolean" || typeof train.arrived !== "boolean") {
			throw new TypeError(`VIA train '${trainNumber}' has invalid state flags`);
		}
		if (typeof train.instance !== "string" || typeof train.from !== "string" || typeof train.to !== "string") {
			throw new TypeError(`VIA train '${trainNumber}' has invalid identity fields`);
		}
		if (!Array.isArray(train.times)) throw new TypeError(`VIA train '${trainNumber}' has no stop-time array`);
		for (const time of train.times) {
			if (
				!isRecord(time) ||
				typeof time.station !== "string" ||
				typeof time.code !== "string" ||
				typeof time.scheduled !== "string"
			) {
				throw new TypeError(`VIA train '${trainNumber}' has an invalid stop time`);
			}
		}
	}
}

export async function fetchTrainData(ctx: CacheContext) {
	const state = getState(ctx);
	logger.debug("Fetching VIA Rail realtime data...", {
		module: "VIA",
		function: "fetchTrainData",
	});
	const response = await fetch(MOBILE_DATA_URL, {
		headers: {
			accept: "application/json",
			...(state.mobileEtag ? { "if-none-match": state.mobileEtag } : {}),
		},
		signal: AbortSignal.timeout(MOBILE_FETCH_TIMEOUT_MS),
	});
	if (response.status === 304) {
		if (!state.prevTrainData) throw new Error("VIA mobile feed returned 304 before an initial snapshot");
		return state.prevTrainData;
	}
	if (!response.ok) throw new Error(`VIA mobile feed returned HTTP ${response.status}`);
	const data: unknown = await response.json();
	assertTrainData(data);
	state.mobileEtag = response.headers.get("etag");
	state.prevTrainData = data;
	logger.debug("Done!", {
		module: "VIA",
		function: "fetchTrainData",
	});
	return data;
}

function ensureCodeIdMap(ctx: CacheContext, state: ViaRealtimeState): Map<string, string> {
	if (state.codeIdMap) return state.codeIdMap;
	const codeToId = new Map<string, string>();
	for (const stop of ctx.gtfs?.getStops() ?? []) {
		if (stop.stop_code) codeToId.set(stop.stop_code, stop.stop_id);
	}
	state.codeIdMap = new Map();
	for (const [viaCode, gtfsCodeOrId] of Object.entries(VIA_CODE_SWAP)) {
		const mergeTarget = ctx.config.mergeStops.find((merge) => merge.from.includes(gtfsCodeOrId))?.to;
		state.codeIdMap.set(viaCode, mergeTarget ?? codeToId.get(gtfsCodeOrId) ?? gtfsCodeOrId);
	}
	for (const [code, id] of codeToId) {
		const mergeTarget = ctx.config.mergeStops.find((merge) => merge.from.includes(id))?.to;
		if (!state.codeIdMap.has(code)) state.codeIdMap.set(code, mergeTarget ?? id);
	}
	return state.codeIdMap;
}

function estimatedEpochSeconds(value: string | null | undefined): number | null {
	if (!value) return null;
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? timestamp / 1000 : null;
}

function selectMatchingTrip(
	ctx: CacheContext,
	trips: qdf.Trip[],
	train: TrainData,
	codeIdMap: ReadonlyMap<string, string>,
): qdf.Trip | null {
	if (trips.length <= 1) return trips[0] ?? null;
	const realtimeStops = new Set(train.times.map((time) => codeIdMap.get(time.code) ?? time.code));
	let best: qdf.Trip | null = null;
	let bestOverlap = -1;
	for (const trip of trips) {
		const overlap = (ctx.gtfs?.getStopTimes({ feed_id: VIA_STATIC_FEED_ID, trip_id: trip.trip_id }) ?? []).filter(
			(stopTime) => realtimeStops.has(stopTime.stop_id),
		).length;
		if (overlap > bestOverlap) {
			best = trip;
			bestOverlap = overlap;
		}
	}
	return best;
}

export async function updateRealtime(ctx: CacheContext) {
	const state = getState(ctx);
	const now = Date.now();
	if (now - state.lastUpdateMs < UPDATE_THROTTLE_MS) return;
	if (!ctx.gtfs) throw new Error("Attempted to update VIA realtime before GTFS initialization");

	const codeIdMap = ensureCodeIdMap(ctx, state);
	const data = await fetchTrainData(ctx);
	const tripUpdates: qdf.RealtimeTripUpdate[] = [];
	const vehiclePositions: qdf.RealtimeVehiclePosition[] = [];
	const tripMatches = new Map<string, ViaTripMatch>();
	const tripsByDateAndNumber = new Map<string, Map<string, qdf.Trip[]>>();

	for (const [tripNumber, train] of Object.entries(data)) {
		const startDate = train.instance.replaceAll("-", "");
		const canonicalTripNumber = tripNumber.match(/^\d+/)?.[0] ?? tripNumber;
		let tripsByNumber = tripsByDateAndNumber.get(startDate);
		if (!tripsByNumber) {
			tripsByNumber = new Map();
			for (const trip of ctx.gtfs.getTrips({ feed_id: VIA_STATIC_FEED_ID, date: startDate })) {
				const trips = tripsByNumber.get(trip.trip_short_name ?? "");
				if (trips) trips.push(trip);
				else tripsByNumber.set(trip.trip_short_name ?? "", [trip]);
			}
			tripsByDateAndNumber.set(startDate, tripsByNumber);
		}
		const matchingTrips = tripsByNumber.get(canonicalTripNumber) ?? [];
		const gtfsTrip = selectMatchingTrip(ctx, matchingTrips, train, codeIdMap);
		if (!gtfsTrip) continue;
		tripMatches.set(viaTrainKey(canonicalTripNumber, startDate), {
			tripId: gtfsTrip.trip_id,
			serviceDate: startDate,
		});

		const stopTimeUpdates: qdf.RealtimeStopTimeUpdate[] = train.times.map((time) => ({
			stop_sequence: null,
			stop_id: codeIdMap.get(time.code) ?? time.code,
			trip_id: gtfsTrip.trip_id,
			start_date: startDate,
			start_time: null,
			arrival_delay: time.diffMin !== undefined ? time.diffMin * 60 : null,
			arrival_time: estimatedEpochSeconds(time.arrival?.estimated),
			arrival_uncertainty: null,
			departure_delay: time.diffMin !== undefined ? time.diffMin * 60 : null,
			departure_time: estimatedEpochSeconds(time.departure?.estimated),
			departure_uncertainty: null,
			schedule_relationship: time.cancelled
				? qdf.StopTimeScheduleRelationship.SKIPPED
				: qdf.StopTimeScheduleRelationship.SCHEDULED,
			feed_id: VIA_STATIC_FEED_ID,
			source_id: VIA_INJECTED_SOURCE_ID,
		}));

		const tripInfo: qdf.RealtimeUpdateTripInfo = {
			trip_id: gtfsTrip.trip_id,
			route_id: gtfsTrip.route_id,
			direction_id: gtfsTrip.direction_id,
			start_time: "",
			start_date: startDate,
			schedule_relationship:
				train.times.length > 0 && train.times.every((time) => time.cancelled)
					? qdf.TripScheduleRelationship.CANCELED
					: qdf.TripScheduleRelationship.SCHEDULED,
			feed_id: VIA_STATIC_FEED_ID,
		};
		const sourceTimestamp = estimatedEpochSeconds(train.poll) ?? Math.floor(now / 1000);

		tripUpdates.push({
			update_id: `VIA_${tripNumber}_${startDate}`,
			is_deleted: false,
			trip: tripInfo,
			vehicle: { id: tripNumber, label: tripNumber, license_plate: "" },
			stop_time_updates: stopTimeUpdates,
			timestamp: sourceTimestamp,
			delay: train.times[0]?.diffMin !== undefined ? train.times[0].diffMin * 60 : null,
			feed_id: VIA_STATIC_FEED_ID,
			source_id: VIA_INJECTED_SOURCE_ID,
		});

		if (train.lat !== undefined && train.lng !== undefined) {
			vehiclePositions.push({
				update_id: `VIA_POS_${tripNumber}_${startDate}`,
				is_deleted: false,
				trip: tripInfo,
				vehicle: { id: tripNumber, label: tripNumber, license_plate: "" },
				position: {
					latitude: train.lat,
					longitude: train.lng,
					bearing: train.direction ?? null,
					odometer: null,
					speed: train.speed === undefined ? null : train.speed / 3.6,
				},
				current_stop_sequence: null,
				stop_id: "",
				current_status: null,
				timestamp: sourceTimestamp,
				congestion_level: null,
				occupancy_status: null,
				occupancy_percentage: null,
				multi_carriage_details: [],
				feed_id: VIA_STATIC_FEED_ID,
				source_id: VIA_INJECTED_SOURCE_ID,
			});
		}
	}

	const cisResult = await refreshCisStationBoards(collectCisStationCandidates(data, now), state.cisBoards, now);
	state.cisBoards = cisResult.boards;
	state.tripMatches = tripMatches;
	for (const error of cisResult.errors) {
		logger.warn(`VIA CIS board ${error.stationCode} could not be refreshed: ${error.message}`, {
			module: "VIA",
			function: "updateRealtime",
		});
	}

	replaceInjectedTripUpdates(ctx, VIA_INJECTED_SOURCE_ID, tripUpdates);
	replaceInjectedVehiclePositions(ctx, VIA_INJECTED_SOURCE_ID, vehiclePositions);
	state.lastUpdateMs = now;
	logger.debug(
		`VIA realtime updated: ${tripUpdates.length} trips, ${vehiclePositions.length} positions, ${state.cisBoards.size} station boards.`,
		{ module: "VIA", function: "updateRealtime" },
	);
}

function sameLocation(a: { kind: string; value: string }, b: { kind: string; value: string }): boolean {
	return a.kind === b.kind && a.value === b.value;
}

/** Attach CIS locations after the generic GTFS-RT cache has rebuilt the affected trip instances. */
export function applyCisBoardingLocations(ctx: CacheContext): void {
	const state = getState(ctx);
	const codeIdMap = state.codeIdMap;
	if (!codeIdMap) return;

	for (const trip of ctx.augmented.trips) {
		if (trip.feed_id !== VIA_STATIC_FEED_ID) continue;
		for (const instance of trip.instances) {
			for (const stopTime of instance.stopTimes) {
				const previousLocations = [
					...stopTime.actual_arrival_boarding_locations,
					...stopTime.actual_departure_boarding_locations,
				].filter((location) => location.source === "via-cis");
				const previousPlatform = previousLocations.find(
					(location) => location.kind === "track" || location.kind === "platform",
				);
				stopTime.actual_arrival_boarding_locations = stopTime.actual_arrival_boarding_locations.filter(
					(location) => location.source !== "via-cis",
				);
				stopTime.actual_departure_boarding_locations = stopTime.actual_departure_boarding_locations.filter(
					(location) => location.source !== "via-cis",
				);
				if (previousPlatform && stopTime.actual_platform_code === previousPlatform.value) {
					stopTime.actual_platform_code = stopTime.scheduled_platform_code;
					stopTime.rt_platform_code_updated = false;
				}
			}
		}
	}

	for (const assignment of buildCisBoardingAssignments(state.cisBoards, state.tripMatches)) {
		const trip = ctx.augmented.tripsRec.get(entityKey({ feedId: VIA_STATIC_FEED_ID, localId: assignment.tripId }));
		const instance = trip?.instances.find((candidate) => candidate.serviceDate === assignment.serviceDate);
		if (!instance) continue;
		const stopId = codeIdMap.get(assignment.stationCode) ?? assignment.stationCode;
		const stopTime = instance.stopTimes.find((candidate) => {
			const ids = [
				candidate.actual_stop_id,
				candidate.actual_parent_station_id,
				candidate.scheduled_stop_id,
				candidate.scheduled_parent_station_id,
			];
			return (
				ids.includes(stopId) ||
				[
					candidate.actual_stop?.stop_code,
					candidate.actual_parent_station?.stop_code,
					candidate.scheduled_stop?.stop_code,
					candidate.scheduled_parent_station?.stop_code,
				].includes(assignment.stationCode)
			);
		});
		if (!stopTime) continue;
		const target =
			assignment.event === "arrival"
				? stopTime.actual_arrival_boarding_locations
				: stopTime.actual_departure_boarding_locations;
		for (const location of assignment.locations) {
			if (!target.some((current) => sameLocation(current, location))) target.push(location);
		}
		const platform = [
			...stopTime.actual_departure_boarding_locations,
			...stopTime.actual_arrival_boarding_locations,
		].find((location) => location.kind === "track" || location.kind === "platform");
		if (platform) {
			stopTime.actual_platform_code = platform.value;
			stopTime.rt_platform_code_updated = true;
		}
	}
}
