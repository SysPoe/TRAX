export type AnyTripPlatformCall = {
	tdn: string;
	serviceDate: string;
	instanceNumber: number;
	scheduledStopId: string | null;
	parentStationId: string | null;
	stopSequence: number | null;
	arrivalEpoch: number | null;
	departureEpoch: number | null;
	platform: string;
	observedAt: string;
	rawIdentifier: string;
};

export type AnyTripPlatformClientOptions = {
	baseUrl?: string;
	stationCacheTtlMs?: number;
	tripCacheTtlMs?: number;
	requestTimeoutMs?: number;
};

export type AnyTripPlatformClientDiagnostics = {
	stationCacheEntries: number;
	tripCacheEntries: number;
	requestsInFlight: number;
};

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type JsonRecord = Record<string, unknown>;

const DEFAULT_BASE_URL = "https://api.anytrip.com.au/api/v3/region/au3";
const DEFAULT_STATION_CACHE_TTL_MS = 60_000;
const DEFAULT_TRIP_CACHE_TTL_MS = 2 * 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;

function record(value: unknown): JsonRecord | null {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function array(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function string(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function number(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function localId(value: unknown): string | null {
	const id = string(value);
	return id?.startsWith("au3:") ? id.slice(4) : id;
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

function parentStationId(stop: JsonRecord): string | null {
	const aliases = array(nested(stop, "parent", "aliases"));
	const ptvAlias = aliases.map(string).find((value) => value?.startsWith("au3:vic:rail:"));
	return localId(ptvAlias) ?? localId(nested(stop, "parent", "id"));
}

function platformName(stop: JsonRecord): string | null {
	return string(nested(stop, "disassembled", "platformName")) ?? string(nested(stop, "name", "platform_name"));
}

function parseCall(tripInstanceValue: unknown, stopTimeValue: unknown, observedAt: string): AnyTripPlatformCall | null {
	const tripInstance = record(tripInstanceValue);
	const stopTime = record(stopTimeValue);
	const stop = record(stopTime?.stop);
	if (!tripInstance || !stopTime || !stop) return null;
	const tdn = string(nested(tripInstance, "trip", "shortName"));
	const serviceDate = string(tripInstance.startDate);
	const platform = platformName(stop);
	if (!tdn || !/^\d{8}$/.test(serviceDate ?? "") || !platform) return null;
	if (string(nested(tripInstance, "trip", "route", "mode")) !== "au3:vlinetrains") return null;
	const scheduledStop = record(stopTime.scheduledStop);
	return {
		tdn,
		serviceDate: serviceDate!,
		instanceNumber: number(tripInstance.instanceNumber) ?? 0,
		scheduledStopId: localId(scheduledStop?.id) ?? localId(stop.id),
		parentStationId: parentStationId(stop),
		stopSequence: number(stopTime.stopSequence),
		arrivalEpoch: number(nested(stopTime, "arrival", "time")),
		departureEpoch: number(nested(stopTime, "departure", "time")),
		platform,
		observedAt,
		rawIdentifier: string(stopTime._path) ?? string(tripInstance._path) ?? `${serviceDate}/${tdn}`,
	};
}

function responseObservedAt(payload: JsonRecord): string {
	const timestamp = number(nested(payload, "header", "timestamp"));
	return new Date(timestamp === null ? Date.now() : timestamp * 1000).toISOString();
}

function parseTripResponse(payloadValue: unknown, expectedTdn: string, expectedDate: string): AnyTripPlatformCall[] {
	const payload = record(payloadValue);
	const tripInstance = record(nested(payload, "response", "tripInstance"));
	if (!payload || !tripInstance) return [];
	if (
		string(nested(tripInstance, "trip", "shortName")) !== expectedTdn ||
		string(tripInstance.startDate) !== expectedDate
	)
		return [];
	const observedAt = responseObservedAt(payload);
	return array(nested(payload, "response", "realtimePattern")).flatMap(
		(stopTime) => parseCall(tripInstance, stopTime, observedAt) ?? [],
	);
}

function parseStationResponse(payloadValue: unknown): AnyTripPlatformCall[] {
	const payload = record(payloadValue);
	if (!payload) return [];
	const observedAt = responseObservedAt(payload);
	return array(nested(payload, "response", "departures")).flatMap((departureValue) => {
		const departure = record(departureValue);
		return departure ? (parseCall(departure.tripInstance, departure.stopTimeInstance, observedAt) ?? []) : [];
	});
}

/** Demand-driven, cached adapter for AnyTrip's unauthenticated Victoria endpoints. */
export class AnyTripPlatformClient {
	private readonly baseUrl: string;
	private readonly stationCacheTtlMs: number;
	private readonly tripCacheTtlMs: number;
	private readonly requestTimeoutMs: number;
	private readonly stationCache = new Map<string, { expiresAt: number; calls: AnyTripPlatformCall[] }>();
	private readonly tripCache = new Map<string, { expiresAt: number; calls: AnyTripPlatformCall[] }>();
	private readonly inFlight = new Map<string, Promise<AnyTripPlatformCall[]>>();

	constructor(
		options: AnyTripPlatformClientOptions = {},
		private readonly fetchImpl: FetchLike = fetch,
	) {
		this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
		this.stationCacheTtlMs = options.stationCacheTtlMs ?? DEFAULT_STATION_CACHE_TTL_MS;
		this.tripCacheTtlMs = options.tripCacheTtlMs ?? DEFAULT_TRIP_CACHE_TTL_MS;
		this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
	}

	get diagnostics(): AnyTripPlatformClientDiagnostics {
		this.pruneExpired();
		return {
			stationCacheEntries: this.stationCache.size,
			tripCacheEntries: this.tripCache.size,
			requestsInFlight: this.inFlight.size,
		};
	}

	async getTripPlatforms(tdn: string, serviceDate: string): Promise<AnyTripPlatformCall[]> {
		this.pruneExpired();
		const key = `${serviceDate}\0${tdn}`;
		const cached = this.tripCache.get(key);
		if (cached && cached.expiresAt > Date.now()) return cached.calls;
		return this.request(
			`trip:${key}`,
			async (signal) => {
				const tripId = encodeURIComponent(`au3:aa:${tdn}`);
				const response = await this.fetchImpl(`${this.baseUrl}/tripInstance/${serviceDate}/${tripId}/0`, {
					signal,
				});
				if (response.status === 404) return [];
				if (!response.ok) throw new Error(`AnyTrip trip instance HTTP ${response.status}`);
				return parseTripResponse(await response.json(), tdn, serviceDate);
			},
			(calls) => this.tripCache.set(key, { calls, expiresAt: Date.now() + this.tripCacheTtlMs }),
		);
	}

	async getStationPlatforms(
		stationId: string,
		nowEpoch = Math.floor(Date.now() / 1000),
	): Promise<AnyTripPlatformCall[]> {
		this.pruneExpired();
		const normalized = stationId.startsWith("au3:") ? stationId : `au3:${stationId}`;
		const cached = this.stationCache.get(normalized);
		if (cached && cached.expiresAt > Date.now()) return cached.calls;
		return this.request(
			`station:${normalized}`,
			async (signal) => {
				const query = new URLSearchParams({
					limit: "200",
					modes: "au3:vlinetrains",
					offset: "-100",
					ts: String(nowEpoch),
					useRedis: "true",
				});
				const response = await this.fetchImpl(
					`${this.baseUrl}/departures/${encodeURIComponent(normalized)}?${query}`,
					{ signal },
				);
				if (response.status === 404) return [];
				if (!response.ok) throw new Error(`AnyTrip station departures HTTP ${response.status}`);
				return parseStationResponse(await response.json());
			},
			(calls) => this.stationCache.set(normalized, { calls, expiresAt: Date.now() + this.stationCacheTtlMs }),
		);
	}

	private request(
		key: string,
		load: (signal: AbortSignal) => Promise<AnyTripPlatformCall[]>,
		cache: (calls: AnyTripPlatformCall[]) => void,
	): Promise<AnyTripPlatformCall[]> {
		const existing = this.inFlight.get(key);
		if (existing) return existing;
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
		const request = load(controller.signal)
			.then((calls) => {
				cache(calls);
				return calls;
			})
			.finally(() => {
				clearTimeout(timeout);
				this.inFlight.delete(key);
			});
		this.inFlight.set(key, request);
		return request;
	}

	private pruneExpired(): void {
		const now = Date.now();
		for (const [key, entry] of this.stationCache) if (entry.expiresAt <= now) this.stationCache.delete(key);
		for (const [key, entry] of this.tripCache) if (entry.expiresAt <= now) this.tripCache.delete(key);
	}
}

export const _test = { parseTripResponse, parseStationResponse };
