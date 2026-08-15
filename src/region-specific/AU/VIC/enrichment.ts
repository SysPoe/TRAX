import type { RealtimeVehiclePosition } from "qdf-gtfs";
import { StopTimeScheduleRelationship, TripScheduleRelationship } from "qdf-gtfs";
import type { CacheContext } from "../../../cache/types.js";
import type { AugmentedTripInstance } from "../../../utils/augmentedTrip.js";
import {
	createVehicleFormation,
	type VehicleBookingAvailability,
	type VehicleFormation,
	type VehicleFormationUnit,
	type VehicleInfo,
} from "../../../utils/vehicleModel.js";
import { getVehiclePositions } from "../../../cache/gtfsReads.js";
import { getServiceDayStart, serviceTimeToInstant } from "../../../utils/time.js";
import { getVLineState } from "./state.js";
import { inferVLinePlatform } from "./platform-heuristics.js";
import {
	getVLineJourneys,
	getVLinePlatformDepartures,
	getVLineWebBookingAvailability,
} from "./journey-planner.js";
import { getVLineScsBoard } from "./scs-board.js";
import {
	normalizeVLineUnit,
	ptvVehicleDescriptorConsist,
	vlinePassengerCars,
	vlineTdn,
	vlineVehicleModel,
} from "./identifiers.js";
import type {
	Observation,
	VLineJourneyPlannerService,
	VLinePluginOptions,
	VLinePlatformObservation,
	VLineScsBoardRow,
	VLineTripDetails,
} from "./types.js";
import {
	getChronosDepartures,
	getChronosDirections,
	getChronosDirectionalDepartures,
	getChronosRunPattern,
	searchChronosStops,
	type ChronosDeparturesResponse,
	type ChronosPatternResponse,
} from "./chronos.js";
import {
	matchChronosRun,
	normalizeChronosName,
	vlineChronosRouteGtfsId,
} from "./chronos-match.js";

const DEFAULT_JP_LOCATIONS = [
	"Melbourne, Southern Cross", "Geelong Station", "South Geelong Station", "Marshall Station", "Waurn Ponds Station",
];
const DAY_MS = 86_400_000;
const LIVE_TTL_MS = 10 * 60_000;
const CHRONOS_PATTERN_TTL_MS = 7 * 60_000;
const CHRONOS_RETRY_MS = 5 * 60_000;
const CHRONOS_CONCURRENCY = 4;
const ON_DEMAND_JOURNEY_TTL_MS = 5 * 60_000;
const MISSING_BOOKING_TTL_MS = 2 * 60_000;

function observation<T>(
	value: T,
	source: Observation<T>["source"],
	confidence: Observation<T>["confidence"],
	observedAt: string,
	rawIdentifier?: string,
): Observation<T> {
	return { value, source, confidence, observedAt, expiresAt: new Date(Date.parse(observedAt) + LIVE_TTL_MS).toISOString(), rawIdentifier };
}

export function createEmptyVLineDetails(tdn: string): VLineTripDetails {
	return {
		tdn, chronosRunRef: null, leadingUnit: null, fullConsist: null, subtype: null, unitCount: null,
		passengerCars: null, accessibleSpaces: null, bicycleSpaces: null, isLiveConsistInfo: null,
		consistDescription: null, bookingAvailability: null,
		occupancyStatus: null, occupancyPercentage: null, carriageOccupancy: null,
		serviceStatus: null, chronosService: null, chronosCalls: [], scsService: null, platforms: [],
	};
}

function detailsFor(ctx: CacheContext, trip: AugmentedTripInstance): VLineTripDetails | null {
	const tdn = vlineTdn(trip.trip_id);
	if (!tdn) return null;
	const state = getVLineState(ctx);
	let details = state.detailsByInstanceId.get(trip.instance_id);
	if (!details) {
		const serviceKey = `${tdn}\0${trip.serviceDate}`;
		details = state.detailsByServiceKey.get(serviceKey) ?? createEmptyVLineDetails(tdn);
		state.detailsByServiceKey.set(serviceKey, details);
		state.detailsByInstanceId.set(trip.instance_id, details);
	}
	return details;
}

function normalizeStation(value: string | null | undefined): string {
	return value?.toLowerCase().replace(/^melbourne\s*,\s*/, "").replace(/\b(railway|station)\b/g, "").replace(/[^a-z0-9]/g, "") ?? "";
}

function scheduledInstant(trip: AugmentedTripInstance, seconds: number | null | undefined): number | null {
	if (seconds == null) return null;
	return Date.parse(serviceTimeToInstant(trip.serviceDate, seconds, "Australia/Melbourne"));
}

export function serviceMatchesTrip(service: VLineJourneyPlannerService, trip: AugmentedTripInstance): boolean {
	if (service.tdn !== vlineTdn(trip.trip_id)) return false;
	const first = trip.stopTimes.find((stop) => !stop.passing);
	const scheduled = first?.scheduled_departure_time ?? first?.scheduled_arrival_time;
	if (scheduled == null) return true;
	const serviceDate = service.scheduledDepartureTime.slice(0, 10).replaceAll("-", "");
	if (!/^\d{8}$/.test(serviceDate)) return true;
	return serviceDate === trip.serviceDate;
}

function findStop(trip: AugmentedTripInstance, service: VLineJourneyPlannerService) {
	const desired = normalizeStation(service.origin);
	return trip.stopTimes.find((stop) => {
		const stopName = stop.scheduled_parent_station?.stop_name ?? stop.scheduled_stop?.stop_name;
		return desired && normalizeStation(stopName) === desired;
	}) ?? (service.direction === "Down" ? trip.stopTimes[0] : trip.stopTimes.at(-1));
}

export function applyJourneyPlannerService(
	trip: AugmentedTripInstance,
	details: VLineTripDetails,
	service: VLineJourneyPlannerService,
	observedAt: string,
): void {
	const raw = service.tdn;
	if (service.consistSubtype) details.subtype = observation(service.consistSubtype, "vline-journey-planner", "reported", observedAt, raw);
	if (service.consistCount) details.unitCount = observation(service.consistCount, "vline-journey-planner", "reported", observedAt, raw);
	const cars = vlinePassengerCars(service.consistSubtype, service.consistCount);
	if (cars) details.passengerCars = observation(cars, "vline-journey-planner", "reported", observedAt, raw);
	if (service.consistVehicles?.length) details.fullConsist = observation(service.consistVehicles, "vline-journey-planner", "reported", observedAt, raw);
	if (service.accessibleSpaces != null) details.accessibleSpaces = observation(service.accessibleSpaces, "vline-journey-planner", "reported", observedAt, raw);
	if (service.bicycleSpaces != null) details.bicycleSpaces = observation(service.bicycleSpaces, "vline-journey-planner", "reported", observedAt, raw);
	details.isLiveConsistInfo = observation(service.isLiveConsistInfo, "vline-journey-planner", "reported", observedAt, raw);
	if (service.consistDescription) details.consistDescription = observation(service.consistDescription, "vline-journey-planner", "reported", observedAt, raw);
	if (service.serviceStatus) details.serviceStatus = observation(service.serviceStatus, "vline-journey-planner", "reported", observedAt, raw);
	if (service.platform) {
		const stop = findStop(trip, service);
		const stopId = stop?.scheduled_parent_station_id ?? stop?.scheduled_stop_id;
		if (stopId) details.platforms.push({ ...observation(service.platform, "vline-journey-planner", "confirmed", observedAt, raw), stopId, event: "both", kind: "platform" });
	}
}

function timeAt(stopTime: AugmentedTripInstance["stopTimes"][number]): string | null {
	const seconds = stopTime.scheduled_departure_time ?? stopTime.scheduled_arrival_time;
	if (seconds == null) return null;
	const local = ((seconds % 86_400) + 86_400) % 86_400;
	return `${Math.floor(local / 3600).toString().padStart(2, "0")}:${Math.floor((local % 3600) / 60).toString().padStart(2, "0")}`;
}

export function matchScsRows(
	trips: readonly AugmentedTripInstance[],
	rows: readonly VLineScsBoardRow[],
	observedAt: string,
): Map<string, VLinePlatformObservation> {
	const matches = new Map<string, VLinePlatformObservation>();
	for (const row of rows) {
		if (!row.platform) continue;
		const candidates = trips.filter((trip) => scsTripMatchesRow(trip, row));
		const trip = selectScsTrip(candidates, row, observedAt);
		if (!trip) continue;
		const first = trip.stopTimes[0];
		const stopId = first.scheduled_parent_station_id ?? first.scheduled_stop_id;
		if (!stopId) continue;
		matches.set(trip.instance_id, {
			...observation(row.platform, "vline-scs-html", "confirmed", observedAt, `${row.time} ${row.destination}`),
			stopId, event: "departure", kind: row.boardingKind ?? "platform",
		});
	}
	return matches;
}

function scsTripMatchesRow(trip: AugmentedTripInstance, row: VLineScsBoardRow): boolean {
	const first = trip.stopTimes[0];
	const firstName = first?.scheduled_parent_station?.stop_name ?? first?.scheduled_stop?.stop_name;
	if (normalizeStation(firstName) !== "southerncross" || timeAt(first) !== row.time) return false;
	if (normalizeStation(trip.trip_headsign) === normalizeStation(row.destination)) return true;
	const terminal = lastScheduledCall(trip);
	return Boolean(row.coachesFrom && terminal &&
		normalizeStation(callName(terminal)) === normalizeStation(row.coachesFrom));
}

function matchScsServices(
	trips: readonly AugmentedTripInstance[],
	rows: readonly VLineScsBoardRow[],
	observedAt: string,
): Map<string, VLineScsBoardRow> {
	const matches = new Map<string, VLineScsBoardRow>();
	for (const row of rows) {
		const candidates = trips.filter((trip) => scsTripMatchesRow(trip, row));
		const trip = selectScsTrip(candidates, row, observedAt);
		if (trip) matches.set(trip.instance_id, row);
	}
	return matches;
}

function selectScsTrip(
	candidates: readonly AugmentedTripInstance[],
	row: VLineScsBoardRow,
	observedAt: string,
): AugmentedTripInstance | null {
	if (candidates.length === 1) return candidates[0];
	if (candidates.length === 0 || row.departingInSeconds == null) return null;
	const expected = Date.parse(observedAt) + row.departingInSeconds * 1000;
	const ranked = candidates.flatMap((trip) => {
		const first = trip.stopTimes[0];
		const seconds = first?.scheduled_departure_time ?? first?.scheduled_arrival_time;
		const instant = scheduledInstant(trip, seconds);
		return instant == null ? [] : [{ trip, difference: Math.abs(instant - expected) }];
	}).sort((a, b) => a.difference - b.difference);
	if (!ranked[0] || ranked[0].difference > 10 * 60_000) return null;
	if (ranked[1]?.difference === ranked[0].difference) return null;
	return ranked[0].trip;
}

function applyPlatform(trip: AugmentedTripInstance, platform: VLinePlatformObservation): void {
	const stopTime = trip.stopTimes.find((stop) =>
		(stop.scheduled_parent_station_id ?? stop.scheduled_stop_id) === platform.stopId,
	);
	if (!stopTime) return;
	const location = {
		kind: platform.kind,
		value: platform.value,
		source: platform.source,
		observed_at: platform.observedAt,
		confidence: platform.confidence,
		expires_at: platform.expiresAt,
	};
	stopTime.actual_platform_code = platform.value;
	stopTime.rt_platform_code_updated = platform.confidence !== "inferred";
	if (platform.event !== "arrival") stopTime.actual_departure_boarding_locations = [location];
	if (platform.event !== "departure") stopTime.actual_arrival_boarding_locations = [location];
}

function currentInstances(ctx: CacheContext): AugmentedTripInstance[] {
	const earliest = Date.now() - DAY_MS, latest = Date.now() + DAY_MS * 2;
	return Array.from(ctx.augmented.instancesRec.values()).filter((trip) => {
		if (trip.feed_id !== "vic-vline" || !vlineTdn(trip.trip_id)) return false;
		const first = trip.stopTimes[0], seconds = first?.scheduled_departure_time ?? first?.scheduled_arrival_time;
		const instant = scheduledInstant(trip, seconds);
		return instant == null || (instant >= earliest && instant <= latest);
	});
}

async function mapConcurrent<T, R>(
	values: readonly T[],
	limit: number,
	worker: (value: T) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(values.length);
	let cursor = 0;
	await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
		while (cursor < values.length) {
			const index = cursor++;
			results[index] = await worker(values[index]);
		}
	}));
	return results;
}

function firstScheduledCall(trip: AugmentedTripInstance) {
	return trip.stopTimes.find((stop) => !stop.passing &&
		(stop.scheduled_departure_time != null || stop.scheduled_arrival_time != null));
}

function lastScheduledCall(trip: AugmentedTripInstance) {
	return [...trip.stopTimes].reverse().find((stop) => !stop.passing);
}

function scheduledCallInstant(trip: AugmentedTripInstance, call: AugmentedTripInstance["stopTimes"][number]): string | null {
	const seconds = call.scheduled_departure_time ?? call.scheduled_arrival_time;
	return seconds == null ? null : serviceTimeToInstant(trip.serviceDate, seconds, "Australia/Melbourne");
}

function gtfsStopKey(call: AugmentedTripInstance["stopTimes"][number]): string | null {
	return call.scheduled_parent_station_id ?? call.scheduled_stop_id;
}

function callName(call: AugmentedTripInstance["stopTimes"][number]): string | null {
	return call.scheduled_parent_station?.stop_name ?? call.scheduled_stop?.stop_name ?? null;
}

function chronosDirectionKey(stopId: number, routeGtfsId: string): string {
	return `${stopId}|${routeGtfsId.toUpperCase()}`;
}

async function resolveChronosStop(
	ctx: CacheContext,
	options: NonNullable<VLinePluginOptions["chronos"]>,
	trip: AugmentedTripInstance,
	timeoutMs: number,
): Promise<number | null> {
	const first = firstScheduledCall(trip), routeGtfsId = vlineChronosRouteGtfsId(trip);
	const key = first && gtfsStopKey(first), name = first && callName(first);
	if (!first || !key || !name || !routeGtfsId) return null;
	const state = getVLineState(ctx), cached = state.chronosStopByGtfsStopId.get(key);
	if (cached != null) return cached;
	const response = await searchChronosStops(options.baseUrl ?? "https://api.ptv.vic.gov.au/v3/", options.apiKey, name, timeoutMs);
	const expectedName = normalizeChronosName(name);
	const matches = response.stops.filter((stop) =>
		stop.stop_id !== 4529 && stop.route_type === 3 && normalizeChronosName(stop.stop_name) === expectedName &&
		(stop.routes ?? []).some((route) => route.route_gtfs_id?.toUpperCase() === routeGtfsId.toUpperCase()),
	);
	const ids = [...new Set(matches.map((stop) => stop.stop_id))];
	if (ids.length !== 1) return null;
	state.chronosStopByGtfsStopId.set(key, ids[0]);
	const routeIds = [...new Set(matches.flatMap((stop) => stop.routes ?? [])
		.filter((route) => route.route_gtfs_id?.toUpperCase() === routeGtfsId.toUpperCase())
		.map((route) => route.route_id))];
	if (routeIds.length === 1) state.chronosRouteByStopAndGtfs.set(chronosDirectionKey(ids[0], routeGtfsId), routeIds[0]);
	return ids[0];
}

function learnChronosDirections(
	ctx: CacheContext,
	stopId: number,
	response: ChronosDeparturesResponse,
): void {
	const state = getVLineState(ctx), values = new Map<string, Set<number>>();
	for (const departure of response.departures) {
		const route = response.routes[String(departure.route_id)];
		if (departure.stop_id !== stopId || departure.direction_id == null || !route?.route_gtfs_id?.startsWith("1-")) continue;
		const key = chronosDirectionKey(stopId, route.route_gtfs_id);
		let directions = values.get(key);
		if (!directions) values.set(key, directions = new Set());
		directions.add(departure.direction_id);
	}
	for (const [key, directions] of values) if (directions.size === 1) {
		state.chronosDirectionByStopAndRoute.set(key, directions.values().next().value!);
	}
}

async function resolveChronosDirections(
	ctx: CacheContext,
	options: NonNullable<VLinePluginOptions["chronos"]>,
	trip: AugmentedTripInstance,
	stopId: number,
	timeoutMs: number,
): Promise<number[]> {
	const state = getVLineState(ctx), routeGtfsId = vlineChronosRouteGtfsId(trip);
	if (!routeGtfsId) return [];
	const key = chronosDirectionKey(stopId, routeGtfsId), cached = state.chronosDirectionByStopAndRoute.get(key);
	if (cached != null) return [cached];
	const routeId = state.chronosRouteByStopAndGtfs.get(key);
	if (routeId == null) return [];
	let directions = state.chronosDirectionsByRouteId.get(routeId);
	if (!directions) {
		directions = (await getChronosDirections(
			options.baseUrl ?? "https://api.ptv.vic.gov.au/v3/", options.apiKey, routeId, timeoutMs,
		)).directions ?? [];
		state.chronosDirectionsByRouteId.set(routeId, directions);
	}
	if (directions.length === 1) {
		state.chronosDirectionByStopAndRoute.set(key, directions[0].direction_id);
		return [directions[0].direction_id];
	}
	const destination = normalizeChronosName(callName(lastScheduledCall(trip)!));
	const headsign = normalizeChronosName(trip.trip_headsign);
	const named = directions.filter((direction) => {
		const name = normalizeChronosName(direction.direction_name);
		return name && (name === destination || name === headsign);
	});
	if (named.length === 1) {
		state.chronosDirectionByStopAndRoute.set(key, named[0].direction_id);
		return [named[0].direction_id];
	}
	return [...new Set(directions.map((direction) => direction.direction_id))];
}

async function discoverChronosRuns(
	ctx: CacheContext,
	options: NonNullable<VLinePluginOptions["chronos"]>,
	trips: readonly AugmentedTripInstance[],
	timeoutMs: number,
): Promise<string[]> {
	const state = getVLineState(ctx), now = Date.now();
	const errors: string[] = [];
	const eligible = trips.filter((trip) => {
		if (options && state.chronosRunByInstanceId.has(trip.instance_id)) return false;
		if ((state.chronosDiscoveryRetryAt.get(trip.instance_id) ?? 0) > now) return false;
		const first = firstScheduledCall(trip), instant = first && scheduledCallInstant(trip, first);
		const time = instant ? Date.parse(instant) : Number.NaN;
		return Number.isFinite(time) && time >= now - 2 * 60 * 60_000 && time <= now + 24 * 60 * 60_000;
	});
	if (!eligible.length) return errors;

	const origins = new Map<string, AugmentedTripInstance[]>();
	for (const trip of eligible) {
		const first = firstScheduledCall(trip), key = first && gtfsStopKey(first);
		if (!key) continue;
		const grouped = origins.get(key);
		if (grouped) grouped.push(trip); else origins.set(key, [trip]);
	}
	await mapConcurrent([...origins.values()], CHRONOS_CONCURRENCY, async (originTrips) => {
		try {
			const stopId = await resolveChronosStop(ctx, options, originTrips[0], timeoutMs);
			if (stopId == null) return;
			let bootstrap: ChronosDeparturesResponse | null = null;
			try {
				bootstrap = await getChronosDepartures(
					options.baseUrl ?? "https://api.ptv.vic.gov.au/v3/", options.apiKey, stopId, 30, timeoutMs,
				);
				learnChronosDirections(ctx, stopId, bootstrap);
			} catch (error) {
				// Direction metadata below still permits bounded historical discovery.
				errors.push(error instanceof Error ? error.message : String(error));
			}
			for (const trip of originTrips) {
				const first = firstScheduledCall(trip), routeGtfsId = vlineChronosRouteGtfsId(trip);
				const instant = first && scheduledCallInstant(trip, first);
				if (!first || !routeGtfsId || !instant) continue;
				const destination = callName(lastScheduledCall(trip)!);
				const directionIds = await resolveChronosDirections(ctx, options, trip, stopId, timeoutMs);
				const directionId = directionIds.length === 1 ? directionIds[0] : null;
				const runRef = bootstrap && matchChronosRun(trip, bootstrap, {
					chronosStopId: stopId, scheduledFirstDepartureUtc: instant, routeGtfsId, destination, directionId,
				});
				if (runRef) state.chronosRunByInstanceId.set(trip.instance_id, runRef);
			}
		} catch (error) {
			// Supplemental discovery failure is isolated per origin and retried later.
			errors.push(error instanceof Error ? error.message : String(error));
		}
	});

	type Bucket = { stopId: number; directionId: number; dateUtc: string; trips: AugmentedTripInstance[] };
	const buckets = new Map<string, Bucket>();
	const candidateRefs = new Map<string, Set<string>>();
	for (const trip of eligible) {
		if (state.chronosRunByInstanceId.has(trip.instance_id)) continue;
		const first = firstScheduledCall(trip), stopKey = first && gtfsStopKey(first), routeGtfsId = vlineChronosRouteGtfsId(trip);
		const stopId = stopKey ? state.chronosStopByGtfsStopId.get(stopKey) : undefined;
		const directionIds = stopId != null && routeGtfsId
			? await resolveChronosDirections(ctx, options, trip, stopId, timeoutMs)
			: [];
		const instant = first && scheduledCallInstant(trip, first), time = instant ? Date.parse(instant) : Number.NaN;
		if (stopId == null || directionIds.length === 0 || !Number.isFinite(time)) {
			state.chronosDiscoveryRetryAt.set(trip.instance_id, now + CHRONOS_RETRY_MS);
			continue;
		}
		const bucketTime = Math.floor((time - 60_000) / (2 * 60 * 60_000)) * (2 * 60 * 60_000);
		for (const directionId of directionIds) {
			const key = `${stopId}|${directionId}|${bucketTime}`;
			const bucket = buckets.get(key);
			if (bucket) bucket.trips.push(trip);
			else buckets.set(key, { stopId, directionId, dateUtc: new Date(bucketTime).toISOString(), trips: [trip] });
		}
	}
	await mapConcurrent([...buckets.values()], CHRONOS_CONCURRENCY, async (bucket) => {
		try {
			const response = await getChronosDirectionalDepartures(
				options.baseUrl ?? "https://api.ptv.vic.gov.au/v3/", options.apiKey,
				bucket.stopId, bucket.directionId, bucket.dateUtc, 30, timeoutMs,
			);
			for (const trip of bucket.trips) {
				const first = firstScheduledCall(trip), routeGtfsId = vlineChronosRouteGtfsId(trip);
				const instant = first && scheduledCallInstant(trip, first);
				if (!routeGtfsId || !instant) continue;
				const runRef = matchChronosRun(trip, response, {
					chronosStopId: bucket.stopId,
					scheduledFirstDepartureUtc: instant,
					routeGtfsId,
					destination: callName(lastScheduledCall(trip)!),
					directionId: bucket.directionId,
				});
				if (runRef) {
					let refs = candidateRefs.get(trip.instance_id);
					if (!refs) candidateRefs.set(trip.instance_id, refs = new Set());
					refs.add(runRef);
				}
			}
		} catch (error) {
			for (const trip of bucket.trips) state.chronosDiscoveryRetryAt.set(trip.instance_id, now + CHRONOS_RETRY_MS);
			errors.push(error instanceof Error ? error.message : String(error));
		}
	});
	for (const trip of eligible) {
		if (state.chronosRunByInstanceId.has(trip.instance_id)) continue;
		const refs = candidateRefs.get(trip.instance_id);
		if (refs?.size === 1) state.chronosRunByInstanceId.set(trip.instance_id, refs.values().next().value!);
		else state.chronosDiscoveryRetryAt.set(trip.instance_id, now + CHRONOS_RETRY_MS);
	}
	return errors;
}

function patternStopForCall(
	ctx: CacheContext,
	trip: AugmentedTripInstance,
	response: ChronosPatternResponse,
	chronosStopId: number,
	scheduledUtc: string,
) {
	const state = getVLineState(ctx), scheduled = Date.parse(scheduledUtc);
	return trip.stopTimes.find((call) => {
		const key = gtfsStopKey(call), cached = key && state.chronosStopByGtfsStopId.get(key);
		if (cached != null && cached !== chronosStopId) return false;
		const stop = response.stops[String(chronosStopId)];
		if (!cached && normalizeChronosName(callName(call)) !== normalizeChronosName(stop?.stop_name)) return false;
		const instant = scheduledCallInstant(trip, call), corroborates = instant && Math.abs(Date.parse(instant) - scheduled) <= 60_000;
		if (corroborates && key) state.chronosStopByGtfsStopId.set(key, chronosStopId);
		return Boolean(corroborates);
	});
}

/** Apply Chronos estimates only when GTFS-RT did not report that call. */
export function applyChronosEstimate(
	trip: AugmentedTripInstance,
	call: AugmentedTripInstance["stopTimes"][number],
	estimatedDepartureUtc: string | null,
): void {
	if (!estimatedDepartureUtc || call.rt_departure_updated) return;
	const epoch = Date.parse(estimatedDepartureUtc) / 1000;
	if (!Number.isFinite(epoch)) return;
	const actual = Math.round(epoch - getServiceDayStart(trip.serviceDate, "Australia/Melbourne"));
	const scheduled = call.scheduled_departure_time ?? call.scheduled_arrival_time ?? actual;
	const delay = actual - scheduled;
	const delayClass = delay === 0 ? "on-time" : delay < 0 ? "early" : delay >= 600 ? "very-late" : "late";
	call.actual_departure_time = actual;
	Object.assign(call, {
		realtime: true,
		realtime_info: {
			delay_secs: delay,
			delay_string: delay === 0 ? "On time" : `${Math.abs(Math.round(delay / 60))} min ${delay < 0 ? "early" : "late"}`,
			delay_class: delayClass,
			schedule_relationship: StopTimeScheduleRelationship.SCHEDULED,
			propagated: false,
			rt_start_date: trip.rt_start_date ?? trip.serviceDate,
		},
	});
}

function applyChronosPattern(
	ctx: CacheContext,
	trip: AugmentedTripInstance,
	runRef: string,
	response: ChronosPatternResponse,
	observedAt: string,
): void {
	const details = detailsFor(ctx, trip);
	if (!details) return;
	const expiresAt = new Date(Date.parse(observedAt) + LIVE_TTL_MS).toISOString();
	details.chronosRunRef = observation(runRef, "ptv-chronos", "confirmed", observedAt, runRef);
	details.chronosCalls = [];
	const run = response.runs[runRef] ?? Object.values(response.runs).find((value) => value.run_ref === runRef);
	const firstDeparture = response.departures[0];
	const direction = firstDeparture?.direction_id == null ? null : response.directions[String(firstDeparture.direction_id)];
	details.chronosService = observation({
		status: run?.status ?? null,
		destination: run?.destination_name ?? null,
		direction: direction?.direction_name ?? null,
		scheduledDepartureUtc: firstDeparture?.scheduled_departure_utc ?? null,
		estimatedDepartureUtc: firstDeparture?.estimated_departure_utc ?? null,
		atPlatform: firstDeparture?.at_platform ?? false,
	}, "ptv-chronos", "reported", observedAt, runRef);
	if (run?.status && !details.serviceStatus) details.serviceStatus = observation(run.status, "ptv-chronos", "reported", observedAt, runRef);
	for (const departure of response.departures) {
		const call = patternStopForCall(ctx, trip, response, departure.stop_id, departure.scheduled_departure_utc);
		const stopId = call && gtfsStopKey(call);
		if (!call || !stopId) continue;
		const platform = departure.platform_number?.trim() || null;
		details.chronosCalls.push({
			stopId, chronosStopId: departure.stop_id,
			scheduledDepartureUtc: departure.scheduled_departure_utc,
			estimatedDepartureUtc: departure.estimated_departure_utc,
			atPlatform: departure.at_platform,
			platform, source: "ptv-chronos", observedAt, expiresAt,
		});
		if (platform) details.platforms.push({
			...observation(platform, "ptv-chronos", "reported", observedAt, runRef),
			stopId, event: "both", kind: "platform",
		});
	}
}

export async function refreshVLineOfficialSources(ctx: CacheContext, options: VLinePluginOptions): Promise<void> {
	const state = getVLineState(ctx), observedAt = new Date().toISOString(), trips = currentInstances(ctx);
	state.lastRefreshAt = observedAt;

	if (options.journeyPlanner) {
		const status = state.sources["journey-planner"];
		status.enabled = true; status.lastAttemptAt = observedAt;
		try {
			const locations = options.journeyPlanner.locations ?? DEFAULT_JP_LOCATIONS;
			const batches = await Promise.all(locations.map((location) => getVLinePlatformDepartures(
				options.journeyPlanner!, location, "B", options.journeyPlanner!.windowMinutes ?? 180,
				options.requestTimeoutMs,
			)));
			for (const service of batches.flat()) for (const trip of trips) if (serviceMatchesTrip(service, trip)) {
				const details = detailsFor(ctx, trip);
				if (details) applyJourneyPlannerService(trip, details, service, observedAt);
			}
			status.lastSuccessAt = observedAt; status.error = null;
		} catch (error) { status.error = error instanceof Error ? error.message : String(error); }
	}
	state.sources.chronos.enabled = Boolean(options.chronos);
	if (options.chronos) {
		const status = state.sources.chronos;
		status.lastAttemptAt = observedAt;
		try {
			const timeoutMs = options.requestTimeoutMs ?? 12_000;
			for (const trip of trips) {
				const override = options.chronosRunRefs?.[trip.instance_id];
				if (override) state.chronosRunByInstanceId.set(trip.instance_id, override);
			}
			const errors = await discoverChronosRuns(ctx, options.chronos, trips, timeoutMs);
			const patterns = new Map<string, { runRef: string; trip: AugmentedTripInstance; stopId: number; dateUtc: string }[]>();
			for (const trip of trips) {
				const runRef = state.chronosRunByInstanceId.get(trip.instance_id), first = firstScheduledCall(trip);
				const stopKey = first ? gtfsStopKey(first) : null;
				const stopId = stopKey ? state.chronosStopByGtfsStopId.get(stopKey) : undefined;
				const dateUtc = first && scheduledCallInstant(trip, first);
				if (!runRef || stopId == null || !dateUtc) continue;
				const key = `${runRef}|${trip.serviceDate}`;
				const grouped = patterns.get(key), value = { runRef, trip, stopId, dateUtc };
				if (grouped) grouped.push(value); else patterns.set(key, [value]);
			}
			await mapConcurrent([...patterns.entries()], CHRONOS_CONCURRENCY, async ([key, grouped]) => {
				try {
					let cached = state.chronosPatternCache.get(key);
					if (!cached || cached.expiresAt <= Date.now()) {
						const item = grouped[0];
						const response = await getChronosRunPattern(
							options.chronos!.baseUrl ?? "https://api.ptv.vic.gov.au/v3/", options.chronos!.apiKey,
							item.runRef, { dateUtc: item.dateUtc, stopId: item.stopId, expand: ["all"] }, timeoutMs,
						);
						cached = { response, expiresAt: Date.now() + CHRONOS_PATTERN_TTL_MS };
						state.chronosPatternCache.set(key, cached);
					}
					for (const item of grouped) applyChronosPattern(ctx, item.trip, item.runRef, cached.response, observedAt);
				} catch (error) {
					// A single run failure must not block other Chronos patterns or core realtime.
					errors.push(error instanceof Error ? error.message : String(error));
				}
			});
			status.lastSuccessAt = observedAt;
			status.error = errors.length ? [...new Set(errors)].join("; ") : null;
		} catch (error) { status.error = error instanceof Error ? error.message : String(error); }
	}

	if (options.scsBoard !== false) {
		const status = state.sources["scs-board"];
		status.enabled = true; status.lastAttemptAt = observedAt;
		try {
			const rows = await getVLineScsBoard(options.scsBoard?.url, options.requestTimeoutMs);
			const matches = matchScsRows(trips, rows, observedAt);
			const services = matchScsServices(trips, rows, observedAt);
			for (const [instanceId, platform] of matches) {
				const trip = ctx.augmented.instancesRec.get(instanceId), details = trip ? detailsFor(ctx, trip) : null;
				if (!details) continue;
				if (!details.platforms.some((value) => value.stopId === platform.stopId && value.confidence === "confirmed")) details.platforms.push(platform);
			}
			for (const [instanceId, row] of services) {
				const trip = ctx.augmented.instancesRec.get(instanceId), details = trip ? detailsFor(ctx, trip) : null;
				if (!trip || !details) continue;
				if (row.cancelled) trip.schedule_relationship = TripScheduleRelationship.CANCELED;
				details.scsService = observation({
					boardGroup: row.boardGroup,
					scheduledTime: row.time,
					destination: row.destination,
					coachesFrom: row.coachesFrom,
					departingIn: row.departingIn,
					departingInSeconds: row.departingInSeconds,
					cancelled: row.cancelled,
				}, "vline-scs-html", "confirmed", observedAt, `${row.time} ${row.destination}`);
			}
			status.lastSuccessAt = observedAt; status.error = null;
		} catch (error) { status.error = error instanceof Error ? error.message : String(error); }
	}
}

export function applyVLineEnrichment(ctx: CacheContext, options: VLinePluginOptions): void {
	const now = Date.now();
	const observedAt = new Date(now).toISOString();
	for (const trip of ctx.augmented.instancesRec.values()) {
		if (trip.feed_id !== "vic-vline") continue;
		const details = detailsFor(ctx, trip);
		if (!details) continue;
		const vehicle = getVehiclePositions(ctx).find((position: RealtimeVehiclePosition) =>
			position.feed_id === trip.feed_id && position.trip.trip_id === trip.trip_id &&
			(!position.trip.start_date || position.trip.start_date === trip.serviceDate),
		);
		const unit = normalizeVLineUnit(vehicle?.vehicle.id);
		if (unit) {
			const sourceTimestamp = vehicle?.timestamp ? new Date(vehicle.timestamp * 1000).toISOString() : undefined;
			details.leadingUnit = { ...observation(unit, "vic-vline-gtfsrt-vehicle-positions", "reported", observedAt, vehicle?.vehicle.id), sourceTimestamp };
		}
		const carriageIds = vehicle?.multi_carriage_details.map((carriage) => carriage.id.trim().toUpperCase()).filter(Boolean) ?? [];
		const realtimeConsist = carriageIds.length ? [...new Set(carriageIds)] : null;
		// Journey Planner's complete ConsistVehicles list wins over GTFS-RT multi-carriage data.
		if (realtimeConsist?.length && (!details.fullConsist || details.fullConsist.source === "vic-vline-gtfsrt-vehicle-positions"))
			details.fullConsist = observation(realtimeConsist, "vic-vline-gtfsrt-vehicle-positions", "reported", observedAt, vehicle?.vehicle.id);
		if (vehicle?.occupancy_status != null)
			details.occupancyStatus = observation(vehicle.occupancy_status, "vic-vline-gtfsrt-vehicle-positions", "reported", observedAt, vehicle.update_id);
		if (vehicle?.occupancy_percentage != null)
			details.occupancyPercentage = observation(vehicle.occupancy_percentage, "vic-vline-gtfsrt-vehicle-positions", "reported", observedAt, vehicle.update_id);
		if (vehicle?.multi_carriage_details.length)
			details.carriageOccupancy = observation(vehicle.multi_carriage_details, "vic-vline-gtfsrt-vehicle-positions", "reported", observedAt, vehicle.update_id);
		for (const chronosCall of details.chronosCalls) {
			const call = trip.stopTimes.find((stop) => gtfsStopKey(stop) === chronosCall.stopId);
			if (call) applyChronosEstimate(trip, call, chronosCall.estimatedDepartureUtc);
		}
		if (options.platformHeuristics === true) for (const stop of trip.stopTimes) {
			const stopId = stop.scheduled_parent_station_id ?? stop.scheduled_stop_id;
			if (!stopId || details.platforms.some((value) => value.stopId === stopId)) continue;
			const name = stop.scheduled_parent_station?.stop_name ?? stop.scheduled_stop?.stop_name ?? "";
			const value = inferVLinePlatform(name, trip.direction_id);
			if (value) details.platforms.push({ ...observation(value, "static-platform-heuristic", "inferred", observedAt), stopId, event: "both", kind: "platform" });
		}
		const precedence = { confirmed: 3, reported: 2, inferred: 1 } as const;
		for (const platform of [...details.platforms]
			.filter((value) => !value.expiresAt || Date.parse(value.expiresAt) > now || value.confidence === "inferred")
			.sort((a, b) => precedence[a.confidence] - precedence[b.confidence])) applyPlatform(trip, platform);
	}
}

function journeyLocationName(value: string | null): string | null {
	if (!value) return null;
	if (/southern cross/i.test(value)) return "Melbourne, Southern Cross";
	return value.replace(/\s+Railway\s+Station$/i, " Station").trim();
}

function scheduledLocalDateTime(trip: AugmentedTripInstance, seconds: number | null | undefined): string | null {
	if (seconds == null) return null;
	const dayOffset = Math.floor(seconds / 86_400);
	const date = new Date(Date.UTC(
		Number(trip.serviceDate.slice(0, 4)), Number(trip.serviceDate.slice(4, 6)) - 1,
		Number(trip.serviceDate.slice(6, 8)) + dayOffset,
	));
	const local = ((seconds % 86_400) + 86_400) % 86_400;
	const day = date.toISOString().slice(0, 10);
	const time = `${Math.floor(local / 3600).toString().padStart(2, "0")}:${Math.floor((local % 3600) / 60).toString().padStart(2, "0")}:${(local % 60).toString().padStart(2, "0")}`;
	return `${day}T${time}`;
}

async function cachedJourneyServices(
	ctx: CacheContext,
	options: NonNullable<VLinePluginOptions["journeyPlanner"]>,
	origin: string,
	destination: string,
	serviceDate: string,
	timeoutMs: number | undefined,
): Promise<VLineJourneyPlannerService[]> {
	const state = getVLineState(ctx), key = `${origin}\0${destination}\0${serviceDate}`;
	const cached = state.journeyCache.get(key);
	if (cached && cached.expiresAt > Date.now()) return cached.services;
	const active = state.journeyInFlight.get(key);
	if (active) return active;
	const request = getVLineJourneys(options, origin, destination, true, timeoutMs)
		.then((services) => {
			state.journeyCache.set(key, { services, expiresAt: Date.now() + ON_DEMAND_JOURNEY_TTL_MS });
			return services;
		});
	state.journeyInFlight.set(key, request);
	try { return await request; }
	finally { state.journeyInFlight.delete(key); }
}

async function cachedBookingAvailability(
	ctx: CacheContext,
	trip: AugmentedTripInstance,
	origin: string,
	destination: string,
	scheduledDepartureTime: string,
	timeoutMs: number | undefined,
) {
	const state = getVLineState(ctx), key = trip.instance_id;
	const cached = state.bookingCache.get(key);
	if (cached && cached.expiresAt > Date.now()) return cached.availability;
	const active = state.bookingInFlight.get(key);
	if (active) return active;
	const request = getVLineWebBookingAvailability(
		origin, destination, trip.serviceDate, vlineTdn(trip.trip_id)!, scheduledDepartureTime, timeoutMs,
	).then((availability) => {
		state.bookingCache.set(key, {
			availability,
			expiresAt: Date.now() + (availability ? ON_DEMAND_JOURNEY_TTL_MS : MISSING_BOOKING_TTL_MS),
		});
		return availability;
	});
	state.bookingInFlight.set(key, request);
	try { return await request; }
	finally { state.bookingInFlight.delete(key); }
}

function vlineDiagramKind(subtype: string | null | undefined): VehicleFormationUnit["diagramKind"] {
	const model = subtype?.trim().toLowerCase() ?? "";
	if (model.includes("vlocity") || model.includes("sprinter")) return "dmu";
	if (model.includes("locomotive")) return "locomotive";
	return "coach";
}

/** Expand reported type/count into every physical car, retaining only identifiers the provider actually supplies. */
export function vlineFormationUnits(
	trip: AugmentedTripInstance,
	details: VLineTripDetails,
): VehicleFormationUnit[] {
	const knownConsist = details.fullConsist?.value?.filter(Boolean) ?? [];
	const carCount = Math.max(knownConsist.length, trip.passenger_cars ?? 0, details.leadingUnit ? 1 : 0);
	if (carCount === 0) return [];
	const model = vlineVehicleModel(details.subtype?.value);
	const kind = vlineDiagramKind(model);
	return Array.from({ length: carCount }, (_, index) => ({
		id: knownConsist[index] ?? (knownConsist.length === 0 && index === 0 ? details.leadingUnit?.value ?? null : null),
		diagramKind: kind,
		type: model ? `${model} car` : "Passenger car",
		manufacturer: null,
		model,
		seats: null,
		bicycles: null,
		accessible: null,
		wifi: null,
		powerOutlets: null,
		accentColor: "#6b2c91",
	}));
}

function journeyServiceSupportsBooking(service: VLineJourneyPlannerService | null): boolean {
	return Boolean(
		service &&
			(service.canBookInJourneyPlanner ||
				service.reservationAvailable ||
				service.reservationRequired ||
				service.reservedCarriages.length > 0),
	);
}

/** Resolve the richer Journey Planner record only when a consumer asks for this trip's formation. */
export async function getVLineVehicleFormation(
	trip: AugmentedTripInstance,
	ctx: CacheContext,
	options: VLinePluginOptions,
): Promise<VehicleFormation | null> {
	if (trip.feed_id !== "vic-vline") return null;
	const first = firstScheduledCall(trip), last = lastScheduledCall(trip);
	const origin = journeyLocationName(first ? callName(first) : null);
	const destination = journeyLocationName(last ? callName(last) : null);
	const scheduled = first?.scheduled_departure_time ?? first?.scheduled_arrival_time;
	const scheduledDepartureTime = scheduledLocalDateTime(trip, scheduled);
	const details = detailsFor(ctx, trip);
	if (!details) return null;

	let service: VLineJourneyPlannerService | null = null;
	if (options.journeyPlanner && origin && destination) {
		try {
			const services = await cachedJourneyServices(
				ctx, options.journeyPlanner, origin, destination, trip.serviceDate, options.requestTimeoutMs,
			);
			const matches = services.filter((candidate) => serviceMatchesTrip(candidate, trip));
			service = matches.find((candidate) => candidate.scheduledDepartureTime === scheduledDepartureTime) ?? matches[0] ?? null;
			if (service) applyJourneyPlannerService(trip, details, service, new Date().toISOString());
		} catch (error) {
			getVLineState(ctx).sources["journey-planner"].error = error instanceof Error ? error.message : String(error);
		}
	}

	if (origin && destination && scheduledDepartureTime && journeyServiceSupportsBooking(service)) {
		try {
			const booking = await cachedBookingAvailability(
				ctx, trip, origin, destination, scheduledDepartureTime, options.requestTimeoutMs,
			);
			if (booking) {
				booking.reservationRequired ||= service?.reservationRequired ?? false;
				details.bookingAvailability = booking;
			}
		} catch {
			// Formation data remains useful when the public booking page is temporarily unavailable.
		}
	}

	const info = vlineVehicleInfoForTrip(trip, ctx);
	if (info) {
		trip.vehicle_id = info.vehicle_id;
		trip.vehicle_model = info.vehicle_model;
		trip.passenger_cars = info.passenger_cars ?? null;
		trip.scheduled_passenger_cars = info.scheduled_passenger_cars ?? null;
		trip.consist = info.consist ?? null;
		trip.vehicle_details = info.details ?? null;
	}
	const booking: VehicleBookingAvailability | null = details.bookingAvailability ? {
		reservedCarriages: [...details.bookingAvailability.reservedCarriages],
		reservedSeatsAvailable: details.bookingAvailability.reservedSeatsAvailable,
		unreservedTicketsAvailable: details.bookingAvailability.unreservedTicketsAvailable,
		reservationAvailable: details.bookingAvailability.reservationAvailable,
		reservationRequired: details.bookingAvailability.reservationRequired,
		seatMapAvailable: details.bookingAvailability.seatMapAvailable,
		journeyUrl: details.bookingAvailability.journeyUrl,
		source: "V/Line Journey Planner",
		observedAt: details.bookingAvailability.observedAt,
	} : null;
	const observed = details.fullConsist ?? details.subtype ?? details.passengerCars;
	const units = vlineFormationUnits(trip, details);
	return createVehicleFormation(trip, units, {
		accessibleSpaces: details.accessibleSpaces?.value ?? null,
		bicycleSpaces: details.bicycleSpaces?.value ?? null,
		// "IsLiveConsistInfo" can accompany type/count only. Do not describe that as a live formation.
		isLive: details.fullConsist?.value?.length ? (details.isLiveConsistInfo?.value ?? null) : null,
		source: observed ? "V/Line Journey Planner" : null,
		observedAt: observed?.observedAt ?? null,
		bookingAvailability: booking,
	});
}

export function vlineVehicleInfoForTrip(trip: AugmentedTripInstance, ctx: CacheContext): VehicleInfo | null {
	if (trip.feed_id !== "vic-vline") return null;
	const details = detailsFor(ctx, trip);
	if (!details) return null;
	return {
		vehicle_id: details.leadingUnit?.value ?? null,
		vehicle_model: vlineVehicleModel(details.subtype?.value),
		passenger_cars: details.passengerCars?.value ?? null,
		scheduled_passenger_cars: null,
		consist: details.fullConsist?.value ?? ptvVehicleDescriptorConsist("vic-vline", details.leadingUnit?.value),
		details,
	};
}

export function vlineDetails(ctx: CacheContext, trip: AugmentedTripInstance): VLineTripDetails | null {
	return getVLineState(ctx).detailsByInstanceId.get(trip.instance_id) ?? detailsFor(ctx, trip);
}
