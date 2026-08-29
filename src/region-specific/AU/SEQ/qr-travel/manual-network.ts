import { hasDataFile, loadDataFile } from "../../../../utils/fs.js";
import { normalizeStationName } from "../../../../utils/corridor/geometry.js";
import type { ManualNetwork } from "../../../../utils/corridor/types.js";
import { getQRTStationLookupKeys } from "./stations.js";
import type { QRTStationDetails } from "./types.js";

export type SRTEntry = { from: string; to: string; travelTrain: number };

export const QRT_MANUAL_NETWORK_ID = "qrt-srt";
export const QRT_MANUAL_FEED_ID = "QRT";
export const QRT_SOURCE_ID = "qrt";

const OPERATIONAL_POINT_NAMES = new Set([
	"normanby",
	"campbell street",
	"mayne junction",
	"mayne",
	"electric depot junction",
	"airport junction",
	"townsville fork points",
	"townsville new station",
]);

const MANUAL_NAME_ALIASES = new Map([["glasshouse mountains", "Glass House Mountains"]]);

function canonicalManualName(name: string): string {
	return MANUAL_NAME_ALIASES.get(normalizeStationName(name)) ?? name;
}

function manualNameAliases(name: string): string[] {
	const canonical = canonicalManualName(name);
	return [...new Set([normalizeStationName(name), normalizeStationName(canonical)])];
}

function numberIsFinite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function loadSrtEntries(): SRTEntry[] {
	if (!hasDataFile("region-specific/seq/SRT_qrt.json")) return [];
	try {
		const value = JSON.parse(loadDataFile("region-specific/seq/SRT_qrt.json")) as unknown;
		if (!Array.isArray(value)) return [];
		return value.filter((entry): entry is SRTEntry => {
			if (typeof entry !== "object" || entry === null) return false;
			const candidate = entry as Partial<SRTEntry>;
			return (
				typeof candidate.from === "string" &&
				typeof candidate.to === "string" &&
				numberIsFinite(candidate.travelTrain)
			);
		});
	} catch {
		return [];
	}
}

function manualNodeClassification(
	name: string,
	passengerNames: ReadonlySet<string>,
): { kind: "station" | "waypoint"; classification: "passenger" | "operational" | "unknown" } {
	const normalized = normalizeStationName(name);
	if (passengerNames.has(normalized)) return { kind: "station", classification: "passenger" };
	if (
		OPERATIONAL_POINT_NAMES.has(normalized) ||
		/yard|siding|fork points|depot|new leg|old leg|marshall|coal siding|^qnip|qr.?x|^off$|^wyr$/i.test(name)
	)
		return { kind: "waypoint", classification: "operational" };
	return { kind: "waypoint", classification: "unknown" };
}

export function manualNodeKind(name: string, passengerNames: ReadonlySet<string>): "station" | "waypoint" {
	return manualNodeClassification(name, passengerNames).kind;
}

function qrtPassengerNames(): Set<string> {
	if (!hasDataFile("region-specific/AU/QRT-stations.json")) return new Set();
	try {
		const data = JSON.parse(loadDataFile("region-specific/AU/QRT-stations.json")) as Record<
			string,
			QRTStationDetails
		>;
		const names = new Set<string>();
		for (const station of Object.values(data)) {
			for (const value of getQRTStationLookupKeys(station)) names.add(normalizeStationName(value));
		}
		return names;
	} catch {
		return new Set();
	}
}

function nodeId(name: string): string {
	return `node:${normalizeStationName(name)
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")}`;
}

/** Convert QRT's legacy SRT data into provider-neutral declarative topology. */
export function getQrtManualNetwork(): ManualNetwork {
	const entries = loadSrtEntries();
	const passengerNames = qrtPassengerNames();
	const names = new Map<string, string>();
	for (const entry of entries) {
		for (const name of [entry.from, entry.to]) {
			const normalized = normalizeStationName(name);
			if (normalized && !names.has(normalized)) names.set(normalized, name);
		}
	}
	const nodes = [...names.entries()].map(([, name]) => {
		const displayName = canonicalManualName(name);
		const classification = manualNodeClassification(displayName, passengerNames);
		return {
			id: nodeId(displayName),
			name: displayName,
			aliases: manualNameAliases(name),
			...classification,
		} satisfies ManualNetwork["nodes"][number];
	});
	const nodeIdByName = new Map(
		[...names.keys()].map((normalized) => [normalized, nodeId(canonicalManualName(names.get(normalized)!))]),
	);
	const edgeMap = new Map<string, SRTEntry>();
	for (const entry of entries) {
		const from = nodeIdByName.get(normalizeStationName(entry.from));
		const to = nodeIdByName.get(normalizeStationName(entry.to));
		if (!from || !to || from === to) continue;
		const key = `${from}|${to}`;
		const current = edgeMap.get(key);
		if (!current || entry.travelTrain < current.travelTrain) edgeMap.set(key, { ...entry, from, to });
	}
	return {
		id: QRT_MANUAL_NETWORK_ID,
		feedId: QRT_MANUAL_FEED_ID,
		pathSelection: "shortest",
		nodes,
		edges: [...edgeMap.values()].map((edge) => ({
			from: edge.from,
			to: edge.to,
			minutes: edge.travelTrain,
			bidirectional: true,
		})),
		priority: "fallback",
		sourceIds: [QRT_SOURCE_ID],
		version: "srt-2",
	};
}
