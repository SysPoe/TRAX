import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { FeedDefinition, NetworkDefinition, PlaceDefinition } from "../../../config.js";
import { canonicalStationIdentity } from "../../../config.js";
import { entityKey } from "../../../identity.js";
import type { TransitPlugin } from "../../../plugins/types.js";
import type { ManualNetwork } from "../../../utils/corridor/types.js";
import { getDataFilePath } from "../../../utils/fs.js";

export const MTP_FEED_ID = "qr-mtp";

export interface MtpCall {
	stationId: string;
	arrival: number;
	departure: number;
	verified: boolean;
	confidence: number;
	planId: string;
	rowId: string;
	evidence: string;
}
export interface MtpService {
	id: string;
	runNumber: string;
	days: number[];
	effectiveDate: string | null;
	endDate: string;
	calendarStartDate: string;
	calendarEndDate: string;
	planIds: string[];
	calls: MtpCall[];
	issues: string[];
}
export interface MtpPlan {
	id: string;
	name: string;
	region: string;
	day: number;
	effectiveDate: string | null;
	endDate: string;
	url: string;
	sha256: string;
	reviewSha256: string;
	extractionVersion: string;
	unresolvedSegments: number;
	empty: boolean;
	importedRows: number;
	rejectedRows: number;
}
export interface MtpStation {
	id: string;
	code: string;
	name: string;
	latitude: number | null;
	longitude: number | null;
	seqStopId?: string;
	coordinateSource: string | null;
}
export interface MtpDataset {
	schemaVersion: 1;
	sourceUrl: string;
	gtfsSha256: string;
	calendarsIgnored: boolean;
	metrics: Record<string, number>;
	plans: MtpPlan[];
	stations: MtpStation[];
	services: MtpService[];
	graphEdges: { from: string; to: string; planIds: string[] }[];
	rejected: { planId: string; rowId?: string; reason: string }[];
}
export interface MtpServiceDetails {
	source: "mtp";
	status: "review" | "verified";
	weekdays: number[];
	effectiveDate: string | null;
	regions: string[];
	issues: string[];
	sources: { name: string; url: string; sha256: string; extractionVersion: string }[];
}

let loaded: { dataset: MtpDataset; buffer: Buffer; byTrip: Map<string, MtpService> } | undefined;
export function getMtpDataset(): MtpDataset {
	if (!loaded) {
		const dataset: MtpDataset = JSON.parse(
			readFileSync(getDataFilePath("region-specific/seq/mtp/weekly-services.json"), "utf8"),
		);
		const buffer = readFileSync(getDataFilePath("region-specific/seq/mtp/weekly-services.zip"));
		if (
			dataset.schemaVersion !== 1 ||
			!Array.isArray(dataset.services) ||
			createHash("sha256").update(buffer).digest("hex") !== dataset.gtfsSha256
		) {
			throw new Error("MTP dataset and GTFS archive do not match");
		}
		loaded = { dataset, buffer, byTrip: new Map(dataset.services.map((s) => [s.id, s])) };
	}
	return loaded.dataset;
}

export function getMtpServiceDetails(tripId: string): MtpServiceDetails | null {
	const dataset = getMtpDataset();
	const service = loaded!.byTrip.get(tripId);
	if (!service) return null;
	const plans = dataset.plans.filter((p) => service.planIds.includes(p.id));
	return {
		source: "mtp",
		status: service.calls.every((c) => c.verified) && !service.issues.length ? "verified" : "review",
		weekdays: service.days,
		effectiveDate: service.effectiveDate,
		regions: [...new Set(plans.map((p) => p.region))],
		issues: service.issues,
		sources: plans.map(({ name, url, sha256, extractionVersion }) => ({ name, url, sha256, extractionVersion })),
	};
}

/** Add one recurring operational feed and conservative physical topology. */
export function withMtpServices(network: NetworkDefinition): NetworkDefinition {
	const dataset = getMtpDataset();
	const places: PlaceDefinition[] = (network.places ?? []).map((p) => ({ ...p, members: [...p.members] }));
	for (const station of dataset.stations) {
		if (!station.seqStopId) continue;
		const seq = { feedId: "translink-seq", localId: station.seqStopId };
		const mtp = { feedId: MTP_FEED_ID, localId: station.id };
		const existing = places.find((p) =>
			p.members.some((m) => m.feedId === seq.feedId && m.localId === seq.localId),
		);
		if (existing) existing.members.push(mtp);
		else places.push({ id: `mtp-${station.id}`, name: station.name, members: [seq, mtp] });
	}
	const canonicalNode = (station: MtpStation) => {
		const member = places.find((p) => p.members.some((m) => m.feedId === MTP_FEED_ID && m.localId === station.id))
			?.members[0];
		return entityKey(member ?? { feedId: MTP_FEED_ID, localId: station.id });
	};
	const manual: ManualNetwork = {
		id: "mtp-passing-points",
		feedId: MTP_FEED_ID,
		version: dataset.gtfsSha256,
		priority: "fallback",
		pathSelection: "unique",
		nodes: dataset.stations.map((s) => ({
			id: s.id,
			stationId: canonicalNode(s),
			name: s.name,
			kind: "station",
			classification: s.seqStopId ? "passenger" : "passing",
			...(s.latitude != null && s.longitude != null ? { lat: s.latitude, lon: s.longitude } : {}),
		})),
		edges: dataset.graphEdges.map((e) => ({ from: e.from, to: e.to, bidirectional: true })),
	};
	const plugin: TransitPlugin = {
		id: MTP_FEED_ID,
		feedIds: [MTP_FEED_ID],
		capabilities: [],
		isNonRevenueRoute: () => true,
		// Partial review journeys must never create express-skip edges in the
		// passenger graph. Only independently adjacent chart rows contribute.
		considerTopologyTrip: () => false,
		enrichTrip(trip) {
			trip.plannedService = getMtpServiceDetails(trip.trip_id) ?? undefined;
		},
		enrichTrackGraph(matrix, adjacency, ctx) {
			const key = (localId: string) =>
				entityKey(canonicalStationIdentity(ctx.config, { feedId: MTP_FEED_ID, localId }));
			for (const edge of dataset.graphEdges) {
				const from = key(edge.from),
					to = key(edge.to);
				if (from === to) continue;
				for (const [a, b] of [
					[from, to],
					[to, from],
				]) {
					const neighbors = (adjacency[a] ??= []);
					if (!neighbors.includes(b)) neighbors.push(b);
					(matrix[a] ??= {})[b] ??= 1;
				}
			}
		},
		api: () => ({ getDataset: getMtpDataset }),
	};
	const feed: FeedDefinition = {
		id: MTP_FEED_ID,
		staticSource: { url: dataset.sourceUrl, buffer: loaded!.buffer },
		realtimeSources: [],
		tripNumber: (trip) => trip.trip_short_name ?? undefined,
	};
	return {
		...network,
		feeds: [...network.feeds, feed],
		plugins: [...network.plugins, plugin],
		places,
		corridor: {
			...network.corridor,
			geometrySources: [
				...(network.corridor?.geometrySources ?? []),
				{ feedId: MTP_FEED_ID, borrowFromFeedIds: ["translink-seq"] },
			],
			manualNetworks: [
				...(network.corridor?.manualNetworks ?? []),
				manual,
				{ ...manual, feedId: "translink-seq" },
			],
		},
	};
}
