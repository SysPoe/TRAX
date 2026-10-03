import { createHash } from "node:crypto";
import {
	StopTimeScheduleRelationship,
	TripScheduleRelationship,
	type RealtimeTripUpdate,
	type RealtimeVehiclePosition,
	type Trip,
	type Route,
} from "qdf-gtfs";
import type { CacheContext } from "../cache/types.js";
import {
	canonicalizeRealtimeVehiclePosition,
	canonicalizeRealtimeTripUpdates,
	replaceInjectedTripUpdates,
	replaceInjectedVehiclePositions,
} from "../cache/realtime.js";
import { entityKey } from "../identity.js";
import { getFeedTimeZone } from "../config.js";
import { isConsideredRoute } from "../utils/considered.js";
import { getServiceDatesByTrip } from "../utils/calendar.js";
import { addDaysToServiceDate, getServiceDate, getServiceDayStart } from "../utils/time.js";
import { getPluginState, type TransitPlugin } from "./types.js";
import {
	TransitAppClient,
	transitRecord,
	transitArray,
	transitNumber,
	transitString,
	type TransitAppClientOptions,
	type TransitFeedMapping,
	type TransitRouteMapping,
	type TransitCrowding,
	type TransitVehicle,
} from "./transit-app-client.js";

export const TRANSIT_APP_PLUGIN_ID = "transit-app";
const MAX_AGE_MS = 180_000;
export type TransitTripObservation = {
	source: "transit-app";
	positionType: "rider" | "agency";
	observedAt: string;
	expiresAt: string;
	riderCount: number;
	crowding: TransitCrowding | null;
};
export type TransitAppDiagnostics = {
	lastAttemptAt: string | null;
	lastSuccessAt: string | null;
	routes: number;
	staticRoutes: number;
	positions: number;
	tripUpdates: number;
	unmatchedVehicles: number;
	errors: string[];
};
export type TransitAppPluginApi = {
	getDiagnostics(): TransitAppDiagnostics;
	getRevision(): string;
	getTripObservation(feedId: string, tripId: string, serviceDate: string): TransitTripObservation | null;
};
export type TransitAppPluginOptions = TransitAppClientOptions & {
	feeds: readonly TransitFeedMapping[];
	/** Inject a client for fixture tests without making upstream requests. */
	client?: Pick<TransitAppClient, "searchRoutes" | "predictions" | "vehicles"> &
		Partial<Pick<TransitAppClient, "nearbyRoutes">>;
};
type State = {
	routes: TransitRouteMapping[];
	discoveryAt: number;
	positions: RealtimeVehiclePosition[];
	updates: RealtimeTripUpdate[];
	observations: Map<string, TransitTripObservation>;
	diagnostics: TransitAppDiagnostics;
};
function stateFor(ctx: CacheContext): State {
	return getPluginState(ctx, TRANSIT_APP_PLUGIN_ID, () => ({
		routes: [],
		discoveryAt: 0,
		positions: [],
		updates: [],
		observations: new Map(),
		diagnostics: {
			lastAttemptAt: null,
			lastSuccessAt: null,
			routes: 0,
			staticRoutes: 0,
			positions: 0,
			tripUpdates: 0,
			unmatchedVehicles: 0,
			errors: [],
		},
	}));
}
function tripKey(feedId: string, tripId: string, date: string): string {
	return JSON.stringify([feedId, tripId, date]);
}

/** Match feed-qualified original route IDs, then an unambiguous display-name pair. */
export function mapTransitRoutes(
	payload: unknown,
	feed: TransitFeedMapping,
	staticRoutes: readonly Route[],
	stopIds: ReadonlySet<string>,
): TransitRouteMapping[] {
	const root = transitRecord(payload);
	if (!root || !Array.isArray(root.routes)) throw new Error("Transit route discovery returned an invalid response");
	const result: TransitRouteMapping[] = [];
	for (const value of root.routes) {
		const route = transitRecord(value);
		if (!route || route.feed_id !== feed.transitFeedId) continue;
		const globalRouteId = transitNumber(route.global_route_id),
			recipeId = transitNumber(route.realtime_recipe_id);
		if (globalRouteId === null || recipeId === null) continue;
		const groups = transitArray(route.itineraries)
			.map(transitRecord)
			.filter((group) => group !== null);
		const rawRouteIds = new Set(
			groups.flatMap((group) =>
				transitArray(group.itineraries).flatMap((itinerary) =>
					transitArray(transitRecord(itinerary)?.realTimeRouteIds)
						.map(transitString)
						.filter((id) => id !== null),
				),
			),
		);
		let candidates = staticRoutes.filter((r) => r.feed_id === feed.feedId && rawRouteIds.has(r.route_id));
		if (!candidates.length) {
			candidates = staticRoutes.filter(
				(r) =>
					r.feed_id === feed.feedId &&
					r.route_short_name === route.short_name &&
					r.route_long_name === route.long_name,
			);
			if (candidates.length !== 1) continue;
		}
		const stops = new Map<number, string>();
		const ambiguousStops = new Set<number>();
		for (const group of groups) {
			const stopsByItinerary = transitRecord(group.stops_by_itinerary_id_map);
			for (const value of Object.values(stopsByItinerary ?? {}).flatMap(transitArray)) {
				const stop = transitRecord(value);
				const stableId = transitNumber(stop?.stop_stable_id),
					rawId = transitString(stop?.raw_stop_id);
				if (stableId === null || !rawId || !stopIds.has(rawId)) continue;
				if (stops.has(stableId) && stops.get(stableId) !== rawId) ambiguousStops.add(stableId);
				stops.set(stableId, rawId);
			}
		}
		for (const id of ambiguousStops) stops.delete(id);
		for (const candidate of candidates)
			result.push({
				feedId: feed.feedId,
				transitFeedId: feed.transitFeedId,
				routeId: candidate.route_id,
				globalRouteId,
				recipeId,
				stops,
			});
	}
	return result;
}

async function concurrent<T>(values: readonly T[], action: (value: T) => Promise<void>): Promise<void> {
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(3, values.length) }, async () => {
			while (next < values.length) await action(values[next++]);
		}),
	);
}

/** Require a unique, operating GTFS service window, including after-midnight service. */
function serviceDateFor(ctx: CacheContext, trip: Trip, timestamp: number): string | null {
	const bounds = ctx.raw.tripStopTimeBoundsByKey.get(entityKey({ feedId: trip.feed_id, localId: trip.trip_id }));
	if (
		!bounds ||
		(ctx.raw.frequenciesByTripKey.get(entityKey({ feedId: trip.feed_id, localId: trip.trip_id }))?.length ?? 0) > 0
	)
		return null;
	const timezone = getFeedTimeZone(ctx.config, trip.feed_id);
	const day = getServiceDate(new Date(timestamp), timezone);
	const operating = new Set(getServiceDatesByTrip({ feedId: trip.feed_id, localId: trip.trip_id }, ctx));
	const candidates = [day, addDaysToServiceDate(day, -1), addDaysToServiceDate(day, -2)].filter((date) => {
		const start = getServiceDayStart(date, timezone);
		return (
			operating.has(date) &&
			timestamp / 1000 >= start + bounds.start_time - 1800 &&
			timestamp / 1000 <= start + bounds.end_time + 1800
		);
	});
	return candidates.length === 1 ? candidates[0] : null;
}

function descriptor(feedId: string, tripId: string, routeId: string, date: string | null) {
	return {
		feed_id: feedId,
		trip_id: tripId,
		route_id: routeId,
		direction_id: null,
		start_time: "",
		start_date: date,
		schedule_relationship: TripScheduleRelationship.SCHEDULED,
	};
}

function positionFor(
	ctx: CacheContext,
	route: TransitRouteMapping,
	row: TransitVehicle,
): RealtimeVehiclePosition | null {
	const candidates = [...new Set(row.tripIds)]
		.map((tripId) => {
			const position = canonicalizeRealtimeVehiclePosition(
				{
					update_id: "",
					is_deleted: false,
					trip: descriptor(route.feedId, tripId, route.routeId, null),
					vehicle: { id: "", label: "", license_plate: "" },
					position: null,
					current_stop_sequence: null,
					stop_id: "",
					current_status: null,
					timestamp: row.observedAt / 1000,
					congestion_level: null,
					occupancy_status: null,
					occupancy_percentage: null,
					multi_carriage_details: [],
					feed_id: route.feedId,
					source_id: TRANSIT_APP_PLUGIN_ID,
				},
				ctx,
			);
			const trip = ctx.raw.tripsByKey.get(entityKey({ feedId: route.feedId, localId: position.trip.trip_id }));
			const date = trip?.route_id === route.routeId ? serviceDateFor(ctx, trip, row.observedAt) : null;
			return date ? { position, date } : null;
		})
		.filter((candidate) => candidate !== null);
	if (candidates.length !== 1) return null;
	const { position, date } = candidates[0];
	// Public marker identity belongs to the service, not a rider or upstream UUID.
	const id = `transit-${createHash("sha256")
		.update(tripKey(route.feedId, position.trip.trip_id, date))
		.digest("hex")
		.slice(0, 24)}`;
	return {
		...position,
		update_id: id,
		vehicle: { id, label: "", license_plate: "" },
		trip: { ...position.trip, start_date: date },
		position: { latitude: row.latitude, longitude: row.longitude, bearing: null, odometer: null, speed: null },
	};
}

/** Fresh agency observations take precedence. Transit fills missing trips and stop calls. */
function inject(ctx: CacheContext, state: State, now: number): void {
	const fresh = (timestamp: number | null) => timestamp === null || timestamp * 1000 + MAX_AGE_MS > now;
	const otherPositions = (ctx.gtfs?.getRealtimeVehiclePositions() ?? [])
		.concat((ctx.raw.injectedVehiclePositions ?? []).filter((v) => v.source_id !== TRANSIT_APP_PLUGIN_ID))
		.filter((v) => v.position && fresh(v.timestamp))
		.map((v) => canonicalizeRealtimeVehiclePosition(v, ctx));
	state.positions = state.positions.filter((v) => v.timestamp !== null && fresh(v.timestamp));
	const positions = state.positions.filter(
		(v) =>
			!otherPositions.some(
				(other) =>
					other.feed_id === v.feed_id &&
					other.trip.trip_id === v.trip.trip_id &&
					(!other.trip.start_date || other.trip.start_date === v.trip.start_date),
			),
	);
	const others = canonicalizeRealtimeTripUpdates(
		(ctx.gtfs?.getRealtimeTripUpdates() ?? []).concat(
			(ctx.raw.injectedTripUpdates ?? []).filter((v) => v.source_id !== TRANSIT_APP_PLUGIN_ID),
		),
		ctx,
	).filter((v) => fresh(v.timestamp));
	state.updates = state.updates.filter((u) => u.timestamp !== null && fresh(u.timestamp));
	const updates = state.updates.flatMap((update) => {
		const existing = others.filter(
			(other) =>
				other.feed_id === update.feed_id &&
				other.trip.trip_id === update.trip.trip_id &&
				(!other.trip.start_date || other.trip.start_date === update.trip.start_date),
		);
		if (existing.some((other) => other.trip.schedule_relationship !== TripScheduleRelationship.SCHEDULED))
			return [];
		const stop_time_updates = update.stop_time_updates.filter(
			(stop) =>
				!existing.some((other) =>
					other.stop_time_updates.some(
						(s) =>
							s.stop_id === stop.stop_id &&
							(s.departure_time !== null ||
								s.departure_delay !== null ||
								s.schedule_relationship !== StopTimeScheduleRelationship.SCHEDULED),
					),
				),
		);
		return stop_time_updates.length ? [{ ...update, stop_time_updates }] : [];
	});
	replaceInjectedVehiclePositions(ctx, TRANSIT_APP_PLUGIN_ID, positions);
	replaceInjectedTripUpdates(ctx, TRANSIT_APP_PLUGIN_ID, updates);
	state.diagnostics.positions = positions.length;
	state.diagnostics.tripUpdates = updates.length;
	for (const [key, value] of state.observations)
		if (Date.parse(value.expiresAt) <= now) state.observations.delete(key);
}

export function createTransitAppPlugin(options: TransitAppPluginOptions): TransitPlugin {
	const client = options.client ?? new TransitAppClient(options);
	return {
		id: TRANSIT_APP_PLUGIN_ID,
		feedIds: [...new Set(options.feeds.map((f) => f.feedId))],
		capabilities: ["vehicles", "occupancy", "supplemental-realtime"],
		considerVehiclePosition: (vehicle) =>
			vehicle.source_id !== TRANSIT_APP_PLUGIN_ID ||
			(vehicle.timestamp !== null && vehicle.timestamp * 1000 + MAX_AGE_MS > Date.now()),
		async beforeRealtime(ctx) {
			const state = stateFor(ctx),
				now = Date.now();
			state.diagnostics.lastAttemptAt = new Date(now).toISOString();
			state.diagnostics.errors = [];
			inject(ctx, state, now);
			if (state.discoveryAt + 24 * 60 * 60_000 <= now) {
				const discovered = new Map<string, TransitRouteMapping>();
				const remember = (routes: TransitRouteMapping[]) => {
					for (const route of routes)
						discovered.set(JSON.stringify([route.feedId, route.globalRouteId, route.routeId]), route);
				};
				if (client.nearbyRoutes)
					await concurrent(options.feeds, async (feed) => {
						const routes = [...ctx.raw.routesByKey.values()].filter(
							(r) => r.feed_id === feed.feedId && isConsideredRoute(r, ctx),
						);
						const stopIds = new Set((ctx.raw.stopsByFeed.get(feed.feedId) ?? []).map((s) => s.stop_id));
						for (const inactive of [false, true]) {
							try {
								remember(
									mapTransitRoutes(await client.nearbyRoutes!(feed, inactive), feed, routes, stopIds),
								);
							} catch {
								state.diagnostics.errors.push(`Nearby discovery failed for ${feed.feedId}`);
							}
						}
					});
				const queries = options.feeds.flatMap((feed) => {
					const routes = [...ctx.raw.routesByKey.values()].filter(
						(r) => r.feed_id === feed.feedId && isConsideredRoute(r, ctx),
					);
					const stopIds = new Set((ctx.raw.stopsByFeed.get(feed.feedId) ?? []).map((s) => s.stop_id));
					const unmapped = routes.filter(
						(r) =>
							![...discovered.values()].some((m) => m.feedId === feed.feedId && m.routeId === r.route_id),
					);
					return [
						...new Set(
							unmapped
								.map((r) => r.route_short_name || r.route_long_name)
								.filter((name): name is string => Boolean(name)),
						),
					].map((query) => ({ feed, routes, stopIds, query }));
				});
				state.diagnostics.staticRoutes = [...ctx.raw.routesByKey.values()].filter(
					(r) => options.feeds.some((f) => f.feedId === r.feed_id) && isConsideredRoute(r, ctx),
				).length;
				await concurrent(queries, async ({ feed, routes, stopIds, query }) => {
					try {
						remember(mapTransitRoutes(await client.searchRoutes(feed, query), feed, routes, stopIds));
					} catch {
						state.diagnostics.errors.push(`Route discovery failed for ${feed.feedId}`);
					}
				});
				if (discovered.size) state.routes = [...discovered.values()];
				state.discoveryAt = state.diagnostics.errors.length ? now - 24 * 60 * 60_000 + 15 * 60_000 : now;
				state.diagnostics.routes = state.routes.length;
			}
			if (!state.routes.length)
				throw new Error("Transit has no matching rail routes in the current static feeds");
			const groups = new Map<string, TransitRouteMapping[]>();
			for (const route of state.routes) {
				const key = `${route.transitFeedId}:${route.recipeId}`;
				groups.set(key, [...(groups.get(key) ?? []), route]);
			}
			const [vehicleResults, predictionResults] = await Promise.all([
				Promise.all(
					[...groups.values()].map((routes) =>
						client
							.vehicles(routes)
							.then((rows) => ({ rows, error: false }))
							.catch(() => ({ rows: [] as TransitVehicle[], error: true })),
					),
				),
				Promise.all(
					[...groups.values()].map(async (routes) => {
						try {
							return { rows: await client.predictions(routes), error: false };
						} catch {
							state.diagnostics.errors.push(
								`Predictions failed for Transit feed ${routes[0].transitFeedId}`,
							);
							return { rows: [], error: true };
						}
					}),
				),
			]);
			const failedVehicleFeeds = new Set(
				[...groups.values()]
					.filter((routes, i) => {
						if (!vehicleResults[i].error) return false;
						state.diagnostics.errors.push(
							`Vehicle snapshot failed for Transit feed ${routes[0].transitFeedId}`,
						);
						return true;
					})
					.flatMap((routes) => routes.map((r) => r.feedId)),
			);
			{
				state.positions = state.positions.filter((position) => failedVehicleFeeds.has(position.feed_id));
				for (const key of state.observations.keys())
					if (!failedVehicleFeeds.has(JSON.parse(key)[0])) state.observations.delete(key);
				state.diagnostics.unmatchedVehicles = 0;
				for (const row of vehicleResults.flatMap((result) => result.rows)) {
					const matchingRoutes = state.routes.filter(
						(r) => r.transitFeedId === row.transitFeedId && r.globalRouteId === row.globalRouteId,
					);
					const matches = matchingRoutes
						.map((route) => positionFor(ctx, route, row))
						.filter((v) => v !== null);
					if (matches.length !== 1) {
						state.diagnostics.unmatchedVehicles++;
						continue;
					}
					const position = matches[0];
					const key = tripKey(position.feed_id, position.trip.trip_id, position.trip.start_date!);
					const previous = state.observations.get(key);
					if (previous && Date.parse(previous.observedAt) >= row.observedAt) continue;
					state.positions = state.positions.filter(
						(v) => tripKey(v.feed_id, v.trip.trip_id, v.trip.start_date!) !== key,
					);
					state.positions.push(position);
					state.observations.set(key, {
						source: "transit-app",
						positionType: row.positionType,
						observedAt: new Date(row.observedAt).toISOString(),
						expiresAt: new Date(row.observedAt + MAX_AGE_MS).toISOString(),
						riderCount: row.riderCount,
						crowding: row.crowding,
					});
				}
			}
			const failedFeeds = new Set(
				[...groups.values()]
					.filter((_, i) => predictionResults[i].error)
					.map((routes) => routes[0].transitFeedId),
			);
			state.updates = state.updates.filter((u) =>
				options.feeds.some((f) => f.feedId === u.feed_id && failedFeeds.has(f.transitFeedId)),
			);
			const updates = new Map<string, RealtimeTripUpdate>();
			for (const result of predictionResults)
				for (const { route, stopId, prediction } of result.rows) {
					const trip = ctx.raw.tripsByKey.get(
						entityKey({ feedId: route.feedId, localId: prediction.tripId }),
					);
					if (!trip || trip.route_id !== route.routeId) continue;
					const date = serviceDateFor(ctx, trip, prediction.scheduledDepartureAt ?? prediction.departureAt);
					if (!date) continue;
					const calls =
						ctx.gtfs?.getStopTimes({ feed_id: route.feedId, trip_id: trip.trip_id, stop_id: stopId }) ?? [];
					if (calls.length !== 1) continue;
					const scheduled = calls[0].departure_time ?? calls[0].arrival_time;
					if (
						prediction.scheduledDepartureAt !== null &&
						(scheduled === null ||
							Math.abs(
								(getServiceDayStart(date, getFeedTimeZone(ctx.config, route.feedId)) + scheduled) *
									1000 -
									prediction.scheduledDepartureAt,
							) > 60_000)
					)
						continue;
					const key = tripKey(route.feedId, trip.trip_id, date);
					let update = updates.get(key);
					if (!update) {
						update = {
							update_id: key,
							is_deleted: false,
							trip: descriptor(route.feedId, trip.trip_id, route.routeId, date),
							vehicle: { id: "", label: "", license_plate: "" },
							stop_time_updates: [],
							timestamp: prediction.observedAt / 1000,
							delay: null,
							feed_id: route.feedId,
							source_id: TRANSIT_APP_PLUGIN_ID,
						};
						updates.set(key, update);
					}
					update.stop_time_updates.push({
						stop_sequence: calls[0].stop_sequence,
						stop_id: stopId,
						trip_id: trip.trip_id,
						start_date: date,
						start_time: null,
						arrival_delay: null,
						arrival_time: null,
						arrival_uncertainty: null,
						departure_delay: null,
						departure_time: prediction.departureAt / 1000,
						departure_uncertainty: null,
						schedule_relationship: StopTimeScheduleRelationship.SCHEDULED,
						feed_id: route.feedId,
						source_id: TRANSIT_APP_PLUGIN_ID,
					});
				}
			state.updates.push(...updates.values());
			inject(ctx, state, Date.now());
			if (vehicleResults.every((result) => result.error) && predictionResults.every((result) => result.error))
				throw new Error("Transit supplemental sources failed");
			state.diagnostics.lastSuccessAt = new Date().toISOString();
		},
		api(ctx): TransitAppPluginApi {
			return {
				getDiagnostics: () => structuredClone(stateFor(ctx).diagnostics),
				getRevision: () => {
					const now = Date.now();
					return createHash("sha256")
						.update(
							JSON.stringify(
								[...stateFor(ctx).observations]
									.filter(([, observation]) => Date.parse(observation.expiresAt) > now)
									.map(([key, observation]) => [
										key,
										observation.observedAt,
										observation.crowding && Date.parse(observation.crowding.expiresAt) > now
											? observation.crowding
											: null,
									]),
							),
						)
						.digest("hex")
						.slice(0, 16);
				},
				getTripObservation: (feedId, tripId, date) => {
					const observation = stateFor(ctx).observations.get(tripKey(feedId, tripId, date));
					if (!observation || Date.parse(observation.expiresAt) <= Date.now()) return null;
					const crowding =
						observation.crowding && Date.parse(observation.crowding.expiresAt) > Date.now()
							? observation.crowding
							: null;
					return { ...observation, crowding };
				},
			};
		},
	};
}
