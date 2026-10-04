import { GTFS, type FetchedRealtimeSource, type GTFSFeedConfig, type GTFSRealtimeFeedConfig } from "qdf-gtfs";
import type { TraxConfig } from "./config.js";
import logger from "./utils/logger.js";
import { getRealtimeOwner } from "./cache/snapshot.js";
import { YieldBudget } from "./utils/cooperative.js";

type WireField = { field: number; wire: number; start: number; end: number; body: Buffer; number?: number };
type RetainedRealtimeSource = { source: GTFSRealtimeFeedConfig; header: Buffer; entities: Map<string, Buffer> };
// A materialized full wire snapshot per source, including differential merges.
// Retain only current entities, never an accumulating history of wire payloads.
const retainedRealtime = new WeakMap<GTFS, Map<string, RetainedRealtimeSource>>();

function wireFields(data: Buffer): WireField[] {
	let position = 0;
	const varint = () => {
		let value = 0n;
		for (let shift = 0n; shift < 70n && position < data.length; shift += 7n) {
			const byte = data[position++];
			value |= BigInt(byte & 127) << shift;
			if (!(byte & 128)) return Number(value);
		}
		throw new Error("Invalid retained GTFS-RT varint");
	};
	const fields: WireField[] = [];
	while (position < data.length) {
		const start = position,
			tag = varint(),
			field = tag >>> 3,
			wire = tag & 7;
		let body: Buffer, number: number | undefined;
		if (wire === 0) {
			const from = position;
			number = varint();
			body = data.subarray(from, position);
		} else if (wire === 2) {
			const length = varint(),
				from = position;
			position += length;
			body = data.subarray(from, position);
		} else if (wire === 1 || wire === 5) {
			const from = position;
			position += wire === 1 ? 8 : 4;
			body = data.subarray(from, position);
		} else throw new Error(`Unsupported retained GTFS-RT wire type ${wire}`);
		if (!field || position > data.length) throw new Error("Invalid retained GTFS-RT field length");
		fields.push({ field, wire, start, end: position, body, number });
	}
	return fields;
}

function lengthDelimited(field: number, body: Buffer): Buffer {
	const encode = (input: number) => {
		let value = input;
		const output = [];
		do {
			const byte = value % 128;
			value = Math.floor(value / 128);
			output.push(byte | (value ? 128 : 0));
		} while (value);
		return Buffer.from(output);
	};
	return Buffer.concat([encode(field * 8 + 2), encode(body.length), body]);
}

async function retainRealtimePayload(
	previous: RetainedRealtimeSource | undefined,
	entry: FetchedRealtimeSource,
): Promise<RetainedRealtimeSource> {
	const fields = wireFields(entry.data!);
	const header = fields.find((field) => field.field === 1 && field.wire === 2)?.body;
	if (!header) throw new Error("Retained GTFS-RT payload has no header");
	const headerFields = wireFields(header);
	const differential = headerFields.find((field) => field.field === 2 && field.wire === 0)?.number === 1;
	// Omission means FULL_DATASET. Preserve all other header fields verbatim.
	const fullHeader = Buffer.concat(
		headerFields.filter((field) => field.field !== 2).map((field) => header.subarray(field.start, field.end)),
	);
	const entities = differential ? new Map(previous?.entities ?? []) : new Map<string, Buffer>();
	const budget = new YieldBudget();
	let count = 0;
	for (const field of fields) {
		if (field.field !== 2 || field.wire !== 2) continue;
		const entityFields = wireFields(field.body);
		const id = entityFields.find((value) => value.field === 1 && value.wire === 2)?.body.toString("utf8");
		if (id == null) continue;
		const deleted = entityFields.find((value) => value.field === 2 && value.wire === 0)?.number === 1;
		if (differential && deleted) entities.delete(id);
		else {
			entities.delete(id);
			entities.set(id, Buffer.from(field.body));
		}
		// Copy bodies so one retained entity cannot pin an old full download.
		if ((++count & 127) === 0) await budget.maybeYield();
	}
	return { source: entry.source, header: fullHeader, entities };
}

function retainedPayload(value: RetainedRealtimeSource): FetchedRealtimeSource {
	return {
		source: value.source,
		ok: true,
		data: Buffer.concat([
			lengthDelimited(1, value.header),
			...Array.from(value.entities.values(), (body) => lengthDelimited(2, body)),
		]),
	};
}

async function fetchAndApplyRealtime(gtfs: GTFS, sources: GTFSRealtimeFeedConfig[]) {
	// Keep transport-only fixture adapters usable at the same interface.
	if (!gtfs.fetchRealtimeSources || !gtfs.applyRealtimePayloads) return gtfs.updateRealtimeFromUrl(sources);
	const fetched = await gtfs.fetchRealtimeSources(sources);
	const results = gtfs.applyRealtimePayloads(fetched);
	let retained = retainedRealtime.get(gtfs);
	if (!retained) retainedRealtime.set(gtfs, (retained = new Map()));
	for (const entry of fetched) {
		if (entry.ok && entry.data && results.some((result) => result.id === entry.source.id && result.ok)) {
			retained.set(entry.source.id, await retainRealtimePayload(retained.get(entry.source.id), entry));
		}
	}
	return results;
}

/** Carry last successful sources into a new static native snapshot. */
export function replayRetainedRealtime(previous: GTFS, next: GTFS): void {
	const retained = retainedRealtime.get(getRealtimeOwner(previous));
	if (!retained?.size) return;
	const entries = Array.from(retained.values(), retainedPayload);
	const results = next.applyRealtimePayloads(entries);
	const failed = results.find((result) => !result.ok);
	if (failed) throw new Error(`Cannot retain realtime source '${failed.id}' through static refresh: ${failed.error}`);
	retainedRealtime.set(next, new Map(retained));
}

export type SourceReport = {
	id: string;
	feedId: string;
	kind: "static" | "trip-updates" | "vehicles" | "alerts";
	state: "loading" | "healthy" | "stale" | "error";
	error?: string;
	transport?: "network" | "fresh-cache" | "stale-cache";
};
export type SourceReporter = (report: SourceReport) => void;

export async function loadStatic(gtfs: GTFS, config: TraxConfig, report?: SourceReporter): Promise<void> {
	logger.info(`Loading static GTFS data for ${config.network.id}...`);
	// Delegate per-feed fallbacks to QDF in a single loadStatic call. QDF tries
	// each source's primary then its fallbacks independently, so a failing feed
	// never forces a healthy feed to reload. Never mutate the configured sources.
	const feeds: GTFSFeedConfig[] = config.network.feeds.map((feed) => {
		const seen = new Set<string>([feed.staticSource.url]);
		const fallbackUrls: string[] = [];
		for (const url of feed.staticSource.fallbackUrls ?? []) {
			if (typeof url !== "string") continue;
			// Config validation rejects empty URLs; skip blanks defensively so a
			// misconfigured fallback can never become a silent empty fetch.
			if (url.trim().length === 0 || seen.has(url)) continue;
			seen.add(url);
			fallbackUrls.push(url);
		}
		return {
			id: feed.id,
			url: feed.staticSource.url,
			headers: feed.staticSource.headers,
			archiveEntry: feed.staticSource.archiveEntry,
			...(fallbackUrls.length > 0 ? { fallbackUrls } : {}),
		};
	});
	for (const feed of config.network.feeds)
		report?.({ id: `${feed.id}:static`, feedId: feed.id, kind: "static", state: "loading" });
	try {
		const results = await gtfs.loadStatic(feeds);
		for (const result of results)
			report?.({
				id: `${result.id}:static`,
				feedId: result.id,
				kind: "static",
				state: result.source === "stale-cache" ? "stale" : "healthy",
				transport: result.source,
			});
		for (const action of config.mergeStops) gtfs.actions.mergeStops(action.to, action.from, action.feedId);
		for (const action of config.updateStopActions) {
			gtfs.actions.updateStop(action.stop_id, action.new, action.feedId);
		}
		logger.info(`Static GTFS data loaded for ${config.network.id}.`);
		return;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		for (const feed of config.network.feeds)
			report?.({ id: `${feed.id}:static`, feedId: feed.id, kind: "static", state: "error", error: message });
		throw error;
	}
}

export type RealtimeLoadOutcome = { successfulSourceIds: string[]; failedSourceIds: string[] };

export async function loadRealtime(
	gtfs: GTFS,
	config: TraxConfig,
	report?: SourceReporter,
): Promise<RealtimeLoadOutcome> {
	gtfs = getRealtimeOwner(gtfs);
	const definitions = config.network.feeds.flatMap((feed) => feed.realtimeSources);
	const sources: GTFSRealtimeFeedConfig[] = definitions.map((realtime) => ({
		id: realtime.id,
		targetFeedId: realtime.targetFeedId,
		kind: realtime.kind,
		url: realtime.source.url,
		headers: realtime.source.headers,
	}));
	const outcome: RealtimeLoadOutcome = { successfulSourceIds: [], failedSourceIds: [] };
	if (sources.length === 0) return outcome;
	logger.info(`Loading realtime data for ${config.network.id}...`);
	for (const source of sources)
		report?.({ id: source.id, feedId: source.targetFeedId, kind: source.kind, state: "loading" });
	let results: Awaited<ReturnType<GTFS["updateRealtimeFromUrl"]>>;
	try {
		results = await fetchAndApplyRealtime(gtfs, sources);
	} catch (error) {
		// A transport-level throw must still try per-source fallbacks safely
		// instead of aborting the whole realtime cycle.
		const message = error instanceof Error ? error.message : String(error);
		results = sources.map((source) => ({ id: source.id, ok: false as const, error: message }));
	}
	for (let result of results) {
		const source = sources.find((candidate) => candidate.id === result.id)!;
		const definition = definitions.find((candidate) => candidate.id === result.id)!;
		if (!result.ok) {
			const seen = new Set([source.url]);
			for (const fallbackUrl of definition.source.fallbackUrls ?? []) {
				if (typeof fallbackUrl !== "string" || fallbackUrl.trim().length === 0 || seen.has(fallbackUrl))
					continue;
				seen.add(fallbackUrl);
				try {
					const [fallbackResult] = await fetchAndApplyRealtime(gtfs, [{ ...source, url: fallbackUrl }]);
					result = fallbackResult;
					if (result.ok) break;
				} catch (error) {
					result = {
						id: source.id,
						ok: false as const,
						error: error instanceof Error ? error.message : String(error),
					};
				}
			}
		}
		report?.({
			id: result.id,
			feedId: source.targetFeedId,
			kind: source.kind,
			state: result.ok ? "healthy" : "error",
			error: result.error,
		});
		(result.ok ? outcome.successfulSourceIds : outcome.failedSourceIds).push(result.id);
	}
	logger.info(`Realtime data loaded for ${config.network.id}.`);
	return outcome;
}

export async function createGtfs(config: TraxConfig, doRealtime = true, report?: SourceReporter): Promise<GTFS> {
	const gtfs = new GTFS({
		ansi: false,
		logger: config.logFunction,
		progress: config.progressLog,
		cache: true,
		compiledCache: true,
		cacheDir: config.cacheDir,
		cacheMaxAgeMs: config.cacheMaxAgeMs,
		requestTimeoutMs: config.requestTimeoutMs,
		maxDownloadBytes: config.maxDownloadBytes,
		maxExtractedEntryBytes: config.maxExtractedEntryBytes,
	});
	await loadStatic(gtfs, config, report);
	if (doRealtime) {
		await loadRealtime(gtfs, config, report).catch((error) => {
			logger.error(
				`Initial realtime load failed for ${config.network.id}: ${error instanceof Error ? error.message : String(error)}`,
			);
		});
	}
	return gtfs;
}
