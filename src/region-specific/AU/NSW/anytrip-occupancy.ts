import type { OccupancyStatus } from "qdf-gtfs";
import type { AugmentedTripInstance } from "../../../utils/augmentedTrip.js";

type JsonRecord = Record<string, unknown>;
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type AnyTripNswOccupancyCall = {
	stopSequence: number;
	statuses: OccupancyStatus[];
	scope: "vehicle" | "carriage";
	confidence: "historical" | "reported";
	observedAt: string;
};

export type AnyTripNswOccupancyClientOptions = {
	baseUrl?: string;
	cacheTtlMs?: number;
	missingCacheTtlMs?: number;
	requestTimeoutMs?: number;
};

/** Fill only stop rows that do not already have official occupancy data. */
export function applyAnyTripNswOccupancy(
	trip: AugmentedTripInstance,
	calls: readonly AnyTripNswOccupancyCall[],
	expiresAt: string,
): number {
	const callsBySequence = new Map(calls.map((call) => [call.stopSequence, call]));
	let applied = 0;
	for (const stopTime of trip.stopTimes) {
		if (stopTime.occupancy) continue;
		const sequence = stopTime._stopTime?.stop_sequence;
		const call = sequence == null ? null : callsBySequence.get(sequence);
		if (!call) continue;
		stopTime.occupancy = {
			statuses: call.statuses,
			scope: call.scope,
			source: "anytrip-nsw",
			confidence: call.confidence,
			observed_at: call.observedAt,
			expires_at: expiresAt,
		};
		applied++;
	}
	return applied;
}

const DEFAULT_BASE_URL = "https://api.anytrip.com.au/api/v3/region/au2";
const DEFAULT_CACHE_TTL_MS = 2 * 60_000;
const DEFAULT_MISSING_CACHE_TTL_MS = 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;

function record(value: unknown): JsonRecord | null {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function nested(value: unknown, ...keys: string[]): unknown {
	let current = value;
	for (const key of keys) {
		const object = record(current);
		if (!object) return undefined;
		current = object[key];
	}
	return current;
}

function string(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function number(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseStatuses(value: unknown): OccupancyStatus[] {
	if (!Array.isArray(value)) return [];
	return value.filter((status): status is OccupancyStatus => Number.isInteger(status) && status >= 0 && status <= 6);
}

export function parseAnyTripNswOccupancy(
	payloadValue: unknown,
	expected: { feedId: string; tripId: string; serviceDate: string },
): AnyTripNswOccupancyCall[] {
	const payload = record(payloadValue);
	const tripInstance = record(nested(payload, "response", "tripInstance"));
	if (!payload || !tripInstance) return [];
	const prefix =
		expected.feedId === "nsw-sydney-trains" ? "au2:st:" : expected.feedId === "nsw-trainlink" ? "au2:nt:" : null;
	if (!prefix || string(nested(tripInstance, "trip", "id")) !== prefix + expected.tripId) return [];
	if (string(tripInstance.startDate) !== expected.serviceDate) return [];

	const timestamp = number(nested(payload, "header", "timestamp"));
	const observedAt = new Date((timestamp ?? Math.floor(Date.now() / 1000)) * 1000).toISOString();
	const pattern = nested(payload, "response", "realtimePattern");
	if (!Array.isArray(pattern)) return [];
	return pattern.flatMap((value) => {
		const stop = record(value);
		const stopSequence = number(stop?.stopSequence);
		const statuses = parseStatuses(nested(stop, "departure", "occupancy"));
		if (stopSequence === null || statuses.length === 0) return [];
		return [
			{
				stopSequence,
				statuses,
				scope: statuses.length > 1 ? ("carriage" as const) : ("vehicle" as const),
				confidence: statuses.length > 1 ? ("reported" as const) : ("historical" as const),
				observedAt,
			},
		];
	});
}

export class AnyTripNswOccupancyClient {
	private readonly baseUrl: string;
	private readonly cacheTtlMs: number;
	private readonly missingCacheTtlMs: number;
	private readonly requestTimeoutMs: number;
	private readonly cache = new Map<string, { expiresAt: number; calls: AnyTripNswOccupancyCall[] }>();
	private readonly inFlight = new Map<string, Promise<AnyTripNswOccupancyCall[]>>();

	constructor(
		options: AnyTripNswOccupancyClientOptions = {},
		private readonly fetchImpl: FetchLike = fetch,
	) {
		this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
		this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
		this.missingCacheTtlMs = options.missingCacheTtlMs ?? DEFAULT_MISSING_CACHE_TTL_MS;
		this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
	}

	async getTripOccupancy(trip: AugmentedTripInstance): Promise<AnyTripNswOccupancyCall[]> {
		const prefix = trip.feed_id === "nsw-sydney-trains" ? "st" : trip.feed_id === "nsw-trainlink" ? "nt" : null;
		if (!prefix) return [];
		const runNumber = trip.trip_number?.trim();
		if (!runNumber) return [];
		const key = `${trip.feed_id}\0${trip.serviceDate}\0${trip.trip_id}`;
		const cached = this.cache.get(key);
		if (cached && cached.expiresAt > Date.now()) return cached.calls;
		const pending = this.inFlight.get(key);
		if (pending) return pending;

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
		const request = this.fetchImpl(
			`${this.baseUrl}/tripInstance/${trip.serviceDate}/${encodeURIComponent(`au2:${prefix}:${runNumber}`)}/0`,
			{ signal: controller.signal },
		)
			.then(async (response) => {
				if (response.status === 404) return [];
				if (!response.ok) throw new Error(`AnyTrip NSW trip occupancy HTTP ${response.status}`);
				return parseAnyTripNswOccupancy(await response.json(), {
					feedId: trip.feed_id,
					tripId: trip.trip_id,
					serviceDate: trip.serviceDate,
				});
			})
			.then((calls) => {
				this.cache.set(key, {
					calls,
					expiresAt: Date.now() + (calls.length > 0 ? this.cacheTtlMs : this.missingCacheTtlMs),
				});
				return calls;
			})
			.finally(() => {
				clearTimeout(timeout);
				this.inFlight.delete(key);
			});
		this.inFlight.set(key, request);
		return request;
	}
}
