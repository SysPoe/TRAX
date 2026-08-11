import type { BoardingLocation, BoardingLocationKind } from "../../../utils/augmentedStopTime.js";
import type { AllTrainData, StationTime } from "./realtime.js";

const CIS_BASE_URL = "https://viarailcis.ca/api/station/kiosk";
const CIS_FETCH_TIMEOUT_MS = 8_000;
const CIS_ASSIGNED_REFRESH_MS = 35_000;
const CIS_UNASSIGNED_REFRESH_MS = 60_000;
const CIS_EMPTY_REFRESH_MS = 5 * 60_000;
const CIS_STALE_MS = 10 * 60_000;
const CIS_MAX_CONCURRENCY = 6;
const CIS_PAST_WINDOW_MS = 30 * 60_000;
const CIS_FUTURE_WINDOW_MS = 2 * 60 * 60_000;

const BOARDING_FIELDS = [
	["Track", "track"],
	["Platform", "platform"],
	["Gate", "gate"],
	["Door", "door"],
	["Letter", "letter"],
] as const satisfies readonly (readonly [CisBoardingField, BoardingLocationKind])[];

export type CisBoardingField = "Track" | "Platform" | "Gate" | "Door" | "Letter";

export type CisService = {
	Train: string;
	ScheduleDate: string;
	Scheduled: string;
	Revised: string;
	Destinations: string[];
	Originations: string[];
} & Record<CisBoardingField, string>;

export type CisStationBoard = {
	DisplayTimeZone: string;
	ActiveBoardingLocations: CisBoardingField[];
	Arrivals: CisService[];
	Departures: CisService[];
	LanguagePriorityCode: string;
};

export type CisBoardSnapshot = {
	stationCode: string;
	stationName: string;
	fetchedAt: number;
	board: CisStationBoard;
};

export type ViaTripMatch = {
	tripId: string;
	serviceDate: string;
};

export type ViaBoardingAssignment = {
	stationCode: string;
	tripId: string;
	serviceDate: string;
	event: "arrival" | "departure";
	locations: BoardingLocation[];
};

type FetchLike = typeof globalThis.fetch;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, field: string): string {
	const value = record[field];
	if (typeof value !== "string") throw new TypeError(`VIA CIS field '${field}' must be a string`);
	return value;
}

function stringArray(record: Record<string, unknown>, field: string): string[] {
	const value = record[field];
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		throw new TypeError(`VIA CIS field '${field}' must be an array of strings`);
	}
	return value;
}

function parseService(value: unknown): CisService {
	if (!isRecord(value)) throw new TypeError("VIA CIS service must be an object");
	return {
		Train: requiredString(value, "Train"),
		ScheduleDate: requiredString(value, "ScheduleDate"),
		Scheduled: requiredString(value, "Scheduled"),
		Revised: requiredString(value, "Revised"),
		Destinations: stringArray(value, "Destinations"),
		Originations: stringArray(value, "Originations"),
		Track: requiredString(value, "Track"),
		Platform: requiredString(value, "Platform"),
		Gate: requiredString(value, "Gate"),
		Door: requiredString(value, "Door"),
		Letter: requiredString(value, "Letter"),
	};
}

/** Validate the undocumented CIS payload before it reaches the runtime cache. */
export function parseCisStationBoard(value: unknown): CisStationBoard {
	if (!isRecord(value)) throw new TypeError("VIA CIS station board must be an object");
	const active = stringArray(value, "ActiveBoardingLocations");
	const activeFields = active.map((field) => {
		if (!BOARDING_FIELDS.some(([candidate]) => candidate === field)) {
			throw new TypeError(`Unknown VIA CIS boarding location '${field}'`);
		}
		return field as CisBoardingField;
	});
	if (!Array.isArray(value.Arrivals) || !Array.isArray(value.Departures)) {
		throw new TypeError("VIA CIS arrivals and departures must be arrays");
	}
	return {
		DisplayTimeZone: requiredString(value, "DisplayTimeZone"),
		ActiveBoardingLocations: activeFields,
		Arrivals: value.Arrivals.map(parseService),
		Departures: value.Departures.map(parseService),
		LanguagePriorityCode: requiredString(value, "LanguagePriorityCode"),
	};
}

function parseTimestamp(value: string | null | undefined): number | null {
	if (!value) return null;
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? timestamp : null;
}

function stationEventTimestamps(time: StationTime): number[] {
	return [
		parseTimestamp(time.arrival?.estimated),
		parseTimestamp(time.arrival?.scheduled),
		parseTimestamp(time.departure?.estimated),
		parseTimestamp(time.departure?.scheduled),
		parseTimestamp(time.estimated),
		parseTimestamp(time.scheduled),
	].filter((timestamp): timestamp is number => timestamp !== null);
}

/** Select only stations whose CIS board can currently add useful near-term information. */
export function collectCisStationCandidates(
	data: AllTrainData,
	nowMs = Date.now(),
	pastWindowMs = CIS_PAST_WINDOW_MS,
	futureWindowMs = CIS_FUTURE_WINDOW_MS,
): Map<string, string> {
	const candidates = new Map<string, string>();
	const windowStart = nowMs - pastWindowMs;
	const windowEnd = nowMs + futureWindowMs;
	for (const train of Object.values(data)) {
		for (const time of train.times) {
			if (!time.code || !time.station) continue;
			if (stationEventTimestamps(time).some((timestamp) => timestamp >= windowStart && timestamp <= windowEnd)) {
				candidates.set(time.code, time.station);
			}
		}
	}
	return candidates;
}

export async function refreshCisStationBoards(
	candidates: ReadonlyMap<string, string>,
	previous: ReadonlyMap<string, CisBoardSnapshot>,
	nowMs = Date.now(),
	fetchImpl: FetchLike = globalThis.fetch,
): Promise<{ boards: Map<string, CisBoardSnapshot>; errors: { stationCode: string; message: string }[] }> {
	const boards = new Map([...previous].filter(([, snapshot]) => nowMs - snapshot.fetchedAt <= CIS_STALE_MS));
	const pending = [...candidates].filter(([code]) => {
		const current = boards.get(code);
		if (!current) return true;
		const services = [...current.board.Arrivals, ...current.board.Departures];
		const hasAssignment = services.some((service) =>
			BOARDING_FIELDS.some(([field]) => service[field].trim().length > 0),
		);
		const refreshMs = hasAssignment
			? CIS_ASSIGNED_REFRESH_MS
			: services.length > 0
				? CIS_UNASSIGNED_REFRESH_MS
				: CIS_EMPTY_REFRESH_MS;
		return nowMs - current.fetchedAt >= refreshMs;
	});
	const errors: { stationCode: string; message: string }[] = [];
	let nextIndex = 0;

	async function worker(): Promise<void> {
		while (nextIndex < pending.length) {
			const [stationCode, stationName] = pending[nextIndex++];
			try {
				const response = await fetchImpl(`${CIS_BASE_URL}/${encodeURIComponent(stationName)}`, {
					headers: { accept: "application/json" },
					signal: AbortSignal.timeout(CIS_FETCH_TIMEOUT_MS),
				});
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				const board = parseCisStationBoard(await response.json());
				boards.set(stationCode, { stationCode, stationName, fetchedAt: nowMs, board });
			} catch (error) {
				errors.push({ stationCode, message: error instanceof Error ? error.message : String(error) });
			}
		}
	}

	await Promise.all(Array.from({ length: Math.min(CIS_MAX_CONCURRENCY, pending.length) }, () => worker()));
	return { boards, errors };
}

export function viaTrainKey(trainNumber: string, scheduleDate: string): string {
	const canonicalTrainNumber = trainNumber.match(/^\d+/)?.[0] ?? trainNumber.trim();
	return `${canonicalTrainNumber}|${scheduleDate.replaceAll("-", "")}`;
}

function serviceLocations(
	service: CisService,
	activeFields: readonly CisBoardingField[],
	observedAt: string,
): BoardingLocation[] {
	const orderedFields = activeFields.length > 0 ? activeFields : BOARDING_FIELDS.map(([field]) => field);
	const locations: BoardingLocation[] = [];
	for (const field of orderedFields) {
		const value = service[field].trim();
		if (!value) continue;
		const kind = BOARDING_FIELDS.find(([candidate]) => candidate === field)?.[1];
		if (!kind || locations.some((location) => location.kind === kind && location.value === value)) continue;
		locations.push({ kind, value, source: "via-cis", observed_at: observedAt });
	}
	return locations;
}

/** Correlate station-board rows with the exact GTFS trip selected from the mobile feed. */
export function buildCisBoardingAssignments(
	boards: ReadonlyMap<string, CisBoardSnapshot>,
	tripMatches: ReadonlyMap<string, ViaTripMatch>,
): ViaBoardingAssignment[] {
	const assignments: ViaBoardingAssignment[] = [];
	for (const snapshot of boards.values()) {
		const observedAt = new Date(snapshot.fetchedAt).toISOString();
		for (const [event, services] of [
			["arrival", snapshot.board.Arrivals],
			["departure", snapshot.board.Departures],
		] as const) {
			for (const service of services) {
				const match = tripMatches.get(viaTrainKey(service.Train, service.ScheduleDate));
				if (!match) continue;
				const locations = serviceLocations(service, snapshot.board.ActiveBoardingLocations, observedAt);
				if (locations.length === 0) continue;
				assignments.push({
					stationCode: snapshot.stationCode,
					tripId: match.tripId,
					serviceDate: match.serviceDate,
					event,
					locations,
				});
			}
		}
	}
	return assignments;
}
