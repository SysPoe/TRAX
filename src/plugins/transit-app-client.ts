import { decode } from "@msgpack/msgpack";

export type TransitFeedMapping = { feedId: string; transitFeedId: number; latitude: number; longitude: number };
export type TransitRouteMapping = {
	feedId: string;
	transitFeedId: number;
	routeId: string;
	globalRouteId: number;
	recipeId: number;
	stops: Map<number, string>;
};
export type TransitCrowding = {
	level: "not-crowded" | "some-crowding" | "crowded";
	source: "transit-app";
	observedAt: string;
	expiresAt: string;
};
export type TransitVehicle = {
	id: string;
	transitFeedId: number;
	globalRouteId: number;
	tripIds: string[];
	latitude: number;
	longitude: number;
	observedAt: number;
	riderCount: number;
	positionType: "rider" | "agency";
	crowding: TransitCrowding | null;
};
export type TransitPrediction = {
	tripId: string;
	departureAt: number;
	scheduledDepartureAt: number | null;
	observedAt: number;
};

type RecordValue = Record<string, unknown>;
export function transitRecord(value: unknown): RecordValue | null {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : null;
}
export function transitArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}
export function transitString(value: unknown): string | null {
	return typeof value === "string" && value ? value : null;
}
export function transitNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const TRANSIT_EPOCH_SECONDS = 946684800; // Native DateTime uses 2000-01-01, not the Unix epoch.

export function decodeTransitMessagePack(bytes: Uint8Array): unknown {
	if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new Error("Transit response exceeds the size limit");
	return decode(bytes, {
		maxStrLength: MAX_RESPONSE_BYTES,
		maxBinLength: MAX_RESPONSE_BYTES,
		maxArrayLength: 250_000,
		maxMapLength: 100_000,
		// Fare tables use array keys. They are discarded after route discovery.
		mapKeyConverter: (key) => (typeof key === "string" || typeof key === "number" ? key : JSON.stringify(key)),
	});
}

/** Read only explicit reports; an absent or unknown level is not an empty train. */
export function parseTransitCrowding(
	value: unknown,
	updatedAt: unknown,
	now: number,
	ttlMs: number,
): TransitCrowding | null {
	const levels: Record<string, TransitCrowding["level"]> = {
		"0": "not-crowded",
		"1": "some-crowding",
		"2": "crowded",
		EMPTY: "not-crowded",
		MANY_SEATS: "not-crowded",
		FEW_SEATS: "some-crowding",
		STAND_ONLY: "crowded",
		FULL: "crowded",
		VERY_CROWDED: "crowded",
		NOT_ACCEPT_PASSENGERS: "crowded",
	};
	const level = typeof value === "number" || typeof value === "string" ? levels[String(value)] : undefined;
	const timestamp = transitNumber(updatedAt);
	if (!level || timestamp === null) return null;
	const observedAt = timestamp * 1000;
	if (observedAt > now + 30_000 || observedAt + ttlMs <= now) return null;
	return {
		level,
		source: "transit-app",
		observedAt: new Date(observedAt).toISOString(),
		expiresAt: new Date(observedAt + ttlMs).toISOString(),
	};
}

/** Drop rider profiles and keep only the aggregate vehicle observation. */
export function parseTransitVehicle(value: unknown, now: number, maxAgeMs: number): TransitVehicle | null {
	const row = transitRecord(value);
	if (!row) return null;
	const id = transitString(row.uuid);
	const transitFeedId = transitNumber(row.feed_id),
		globalRouteId = transitNumber(row.global_route_id);
	const latitude = transitNumber(row.lat),
		longitude = transitNumber(row.lng),
		timestamp = transitNumber(row.updated_at);
	if (
		!id ||
		transitFeedId === null ||
		globalRouteId === null ||
		latitude === null ||
		longitude === null ||
		timestamp === null
	)
		return null;
	const observedAt = timestamp * 1000;
	if (
		Math.abs(latitude) > 90 ||
		Math.abs(longitude) > 180 ||
		observedAt > now + 30_000 ||
		observedAt + maxAgeMs <= now
	)
		return null;
	return {
		id,
		transitFeedId,
		globalRouteId,
		latitude,
		longitude,
		observedAt,
		tripIds: transitArray(row.assigned_rt_trip_ids)
			.map(transitString)
			.filter((id): id is string => id !== null),
		riderCount: transitArray(row.avatars).length,
		positionType: row.is_unmerged_crowd === true ? "rider" : "agency",
		crowding: parseTransitCrowding(
			row.occupancy,
			row.occupancy_updated_at ?? (row.is_unmerged_crowd === false ? row.updated_at : undefined),
			now,
			5 * 60_000,
		),
	};
}

/** The batch response contains positional native prediction records. */
export function parseTransitPrediction(value: unknown, now: number): TransitPrediction | null {
	if (!Array.isArray(value) || value.length !== 17) return null;
	// Records without a GTFS trip identity cannot safely join an existing service.
	const tripId = transitString(value[10]);
	const departure = transitNumber(value[5]),
		scheduled = transitNumber(value[16]);
	if (!tripId || departure === null) return null;
	const departureAt = (departure + TRANSIT_EPOCH_SECONDS) * 1000;
	// Slot 16 is the scheduled departure, not the observation timestamp.
	const scheduledDepartureAt =
		scheduled !== null && scheduled > 0 ? (scheduled + TRANSIT_EPOCH_SECONDS) * 1000 : null;
	if (departureAt < now - 60_000 || departureAt > now + 6 * 60 * 60_000) return null;
	return { tripId, departureAt, scheduledDepartureAt, observedAt: now };
}

export interface TransitAppClientOptions {
	/** Anonymous installation UUID, distinct from a person's Transit account. */
	installationId: string;
	apiKey: string;
	requestTimeoutMs?: number;
	snapshotWindowMs?: number;
	fetch?: typeof globalThis.fetch;
	webSocket?: (url: string) => WebSocket;
}

/** Android read-only contracts. Credentials stay in this server-side adapter. */
export class TransitAppClient {
	private readonly authorization: string;
	private readonly fetch: typeof globalThis.fetch;
	constructor(private readonly options: TransitAppClientOptions) {
		if (!options.apiKey || !/^[0-9a-f-]{36}$/i.test(options.installationId))
			throw new Error("Transit requires an API key and installation UUID");
		this.authorization = `Basic ${Buffer.from(`${options.installationId}:${options.apiKey}`).toString("base64")}`;
		this.fetch = options.fetch ?? globalThis.fetch;
	}

	private async request(path: string, params: Record<string, string>): Promise<unknown> {
		let url = new URL(path, "https://bgtfs.transitapp.com/v3/");
		for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
		const signal = AbortSignal.timeout(this.options.requestTimeoutMs ?? 8000);
		let response: Response;
		for (let redirects = 0; ; redirects++) {
			response = await this.fetch(url, {
				headers: { Authorization: this.authorization, Accept: "application/octet-stream" },
				signal,
				redirect: "manual",
			});
			const location = response.headers.get("location");
			if (![301, 302, 303, 307, 308].includes(response.status) || !location) break;
			await response.body?.cancel();
			const destination = new URL(location, url);
			// Transit moves realtime requests between these hosts. Preserve Basic auth
			// explicitly, without forwarding it to an arbitrary redirect target.
			if (
				redirects >= 3 ||
				destination.protocol !== "https:" ||
				destination.port ||
				destination.username ||
				destination.password ||
				!["bgtfs.transitapp.com", "api.transitapp.com", "realtime-data-api.transitapp.com"].includes(
					destination.hostname,
				)
			) {
				throw new Error("Transit returned an unsupported redirect");
			}
			url = destination;
		}
		if (!response.ok) {
			await response.body?.cancel();
			throw new Error(`Transit ${path} returned HTTP ${response.status}`);
		}
		if (!response.body) throw new Error(`Transit ${path} returned no body`);
		const chunks: Uint8Array[] = [];
		let size = 0;
		const reader = response.body.getReader();
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				size += value.byteLength;
				if (size > MAX_RESPONSE_BYTES) {
					await reader.cancel();
					throw new Error("Transit response exceeds the size limit");
				}
				chunks.push(value);
			}
		} finally {
			reader.releaseLock();
		}
		return decodeTransitMessagePack(Buffer.concat(chunks, size));
	}

	searchRoutes(feed: TransitFeedMapping, query: string): Promise<unknown> {
		return this.request("search_for_routes", { lat: String(feed.latitude), lng: String(feed.longitude), query });
	}

	async nearbyRoutes(feed: TransitFeedMapping, inactive = false): Promise<unknown> {
		const payload = transitRecord(
			await this.request("nearby_services", {
				lat: String(feed.latitude),
				lng: String(feed.longitude),
				distance: "500",
				...(inactive ? { inactive: "1" } : {}),
			}),
		);
		if (!payload || !Array.isArray(payload.route))
			throw new Error("Transit nearby discovery returned an invalid response");
		return { routes: payload.route };
	}

	async predictions(
		routes: readonly TransitRouteMapping[],
	): Promise<{ route: TransitRouteMapping; stopId: string; prediction: TransitPrediction }[]> {
		if (!routes.length) return [];
		const first = routes[0];
		if (routes.some((r) => r.transitFeedId !== first.transitFeedId || r.recipeId !== first.recipeId))
			throw new Error("Transit prediction batch mixes feeds or recipes");
		const pairs = new Map<string, { route: TransitRouteMapping; stopId: string }[]>();
		for (const route of routes)
			for (const [stableId, stopId] of route.stops) {
				const key = `${route.globalRouteId}:${stableId}`;
				pairs.set(key, [...(pairs.get(key) ?? []), { route, stopId }]);
			}
		const keys = [...pairs.keys()];
		const results: { route: TransitRouteMapping; stopId: string; prediction: TransitPrediction }[] = [];
		let next = 0;
		let failed = false;
		// Ten pairs work on the native endpoint; larger batches can return 422.
		const batches = await Promise.allSettled(
			Array.from({ length: Math.min(3, Math.ceil(keys.length / 10)) }, async () => {
				while (!failed && next < keys.length) {
					const offset = next;
					next += 10;
					const batch = keys.slice(offset, offset + 10);
					const payload = transitRecord(
						await this.request("https://api.transitapp.com/v3/real_time/gtfsrt_predictions_batch", {
							feed_id: String(first.transitFeedId),
							global_recipe_id: String(first.recipeId),
							route_stop_pairs: batch.join(","),
						}),
					);
					if (!payload) throw new Error("Transit prediction response is not a map");
					for (const key of batch)
						for (const value of transitArray(payload[key])) {
							const prediction = parseTransitPrediction(value, Date.now());
							if (prediction)
								for (const pair of pairs.get(key)!)
									results.push({ route: pair.route, stopId: pair.stopId, prediction });
						}
				}
			}).map((worker) =>
				worker.catch((cause) => {
					failed = true;
					throw cause;
				}),
			),
		);
		const failure = batches.find((batch) => batch.status === "rejected");
		if (failure?.status === "rejected") throw failure.reason;
		return results;
	}

	/** Take a bounded snapshot so static reloads never leave orphaned sockets. */
	vehicles(routes: readonly TransitRouteMapping[]): Promise<TransitVehicle[]> {
		if (!routes.length) return Promise.resolve([]);
		return new Promise((resolve, reject) => {
			const socket = (this.options.webSocket ?? ((url) => new WebSocket(url)))("wss://crowd.transitapp.com/ws");
			const vehicles = new Map<string, TransitVehicle>();
			let received = false,
				settled = false;
			let snapshotTimer: ReturnType<typeof setTimeout> | undefined;
			const finish = (error?: Error) => {
				if (settled) return;
				settled = true;
				clearTimeout(connectTimer);
				clearTimeout(snapshotTimer);
				socket.close();
				if (error) reject(error);
				else resolve([...vehicles.values()]);
			};
			const connectTimer = setTimeout(
				() => finish(new Error("Transit vehicle connection timed out")),
				this.options.requestTimeoutMs ?? 8000,
			);
			socket.onopen = () => {
				clearTimeout(connectTimer);
				socket.send(JSON.stringify({ uuid: this.options.installationId, device_time: Date.now() }));
				const subscriptions = new Set<string>();
				for (const route of routes) {
					const key = `${route.transitFeedId}:${route.globalRouteId}`;
					if (subscriptions.has(key)) continue;
					subscriptions.add(key);
					socket.send(
						JSON.stringify({
							subscribe: "vehicle",
							languages: ["en"],
							feed_id: route.transitFeedId,
							global_route_id: route.globalRouteId,
							global_recipe_id: route.recipeId,
						}),
					);
				}
				snapshotTimer = setTimeout(
					() => finish(received ? undefined : new Error("Transit returned no vehicle snapshot")),
					this.options.snapshotWindowMs ?? 6000,
				);
			};
			socket.onmessage = (event) => {
				if (settled || typeof event.data !== "string") return;
				if (event.data.length > MAX_RESPONSE_BYTES) {
					finish(new Error("Transit vehicle response exceeds the size limit"));
					return;
				}
				try {
					const payload = transitRecord(JSON.parse(event.data));
					if (payload?.type !== "vehicle") return;
					// Empty route snapshots can encode the vehicle list as JSON null.
					if (payload.vehicles === null) {
						received = true;
						return;
					}
					if (!Array.isArray(payload.vehicles)) throw new Error("Invalid vehicle snapshot");
					received = true;
					for (const value of payload.vehicles) {
						const vehicle = parseTransitVehicle(value, Date.now(), 180_000);
						if (vehicle) vehicles.set(vehicle.id, vehicle);
					}
				} catch (cause) {
					finish(new Error("Transit returned an invalid vehicle message", { cause }));
				}
			};
			socket.onerror = () => finish(new Error("Transit vehicle connection failed"));
			socket.onclose = () => finish(new Error("Transit vehicle connection closed before the snapshot finished"));
		});
	}
}
