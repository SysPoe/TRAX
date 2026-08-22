import type { RealtimeVehiclePosition } from "qdf-gtfs";
import { DropOffType, PickupType, StopTimeScheduleRelationship, TripScheduleRelationship } from "qdf-gtfs";
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
import logger from "../../../utils/logger.js";
import { getServiceDayStart, parseTimeWithConfig, serviceTimeToInstant } from "../../../utils/time.js";
import { saveVLineBookingSnapshots, shouldPrefetchVLineBooking, vlineBookingSnapshotKey } from "./booking-snapshots.js";
import { getVLineState } from "./state.js";
import { inferVLinePlatform } from "./platform-heuristics.js";
import {
	getVLineJourneys,
	getVLineLocations,
	getVLinePlatformArrivals,
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
	VLineJourneyPlannerLocation,
	VLineJourneyPlannerService,
	VLinePluginOptions,
	VLinePlatformObservation,
	VLineScsBoardRow,
	VLineTripDetails,
} from "./types.js";

const DAY_MS = 86_400_000;
const LIVE_TTL_MS = 10 * 60_000;
const PLATFORM_TTL_MS = 25 * 60_000;
const DEFAULT_PLATFORM_WINDOW_MINUTES = 240;
const DEFAULT_PLATFORM_REFRESH_MS = 20 * 60_000;
const PLATFORM_LOCATION_TTL_MS = DAY_MS;
// Seven stations per one-minute refresh covers the API's 132 canonical station keys in 20 minutes.
const PLATFORM_STATIONS_PER_REFRESH = 7;
const PLATFORM_POLL_CONCURRENCY = 1;
const ON_DEMAND_JOURNEY_TTL_MS = 5 * 60_000;
const MISSING_BOOKING_TTL_MS = 2 * 60_000;
const BOOKING_SNAPSHOT_GRACE_MS = 6 * 60 * 60_000;

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
		tdn, leadingUnit: null, fullConsist: null, subtype: null, unitCount: null,
		passengerCars: null, accessibleSpaces: null, bicycleSpaces: null, isLiveConsistInfo: null,
		consistDescription: null, bookingAvailability: null,
		occupancyStatus: null, occupancyPercentage: null, carriageOccupancy: null,
		serviceStatus: null, scsService: null, platforms: [],
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
	if (!value) return "";
	const withoutMelbourne = value.toLowerCase().replace(/^melbourne\s*,\s*/, "");
	const stationName = withoutMelbourne.split(/[:,]/, 1)[0];
	return stationName.replace(/\b(railway|station)\b/g, "").replace(/[^a-z0-9]/g, "");
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
	const tripInstant = scheduledInstant(trip, scheduled);
	const serviceInstant = parseTimeWithConfig(service.scheduledDepartureTime, "Australia/Melbourne");
	if (tripInstant != null && serviceInstant > 0) return Math.abs(tripInstant - serviceInstant) <= 5 * 60_000;
	const serviceDate = service.scheduledDepartureTime.slice(0, 10).replaceAll("-", "");
	if (!/^\d{8}$/.test(serviceDate)) return true;
	return serviceDate === trip.serviceDate;
}

function findStop(trip: AugmentedTripInstance, service: VLineJourneyPlannerService) {
	const desired = normalizeStation(service.locationName ?? (service.platformEvent === "arrival" ? service.destination : service.origin));
	return trip.stopTimes.find((stop) => {
		const stopName = stop.scheduled_parent_station?.stop_name ?? stop.scheduled_stop?.stop_name;
		return desired && normalizeStation(stopName) === desired;
	}) ?? (service.platformEvent === "arrival" ? trip.stopTimes.at(-1) : trip.stopTimes[0]);
}

/** Apply the arrivals-board estimate only when GTFS-RT has not updated this arrival. */
function applyJourneyPlannerArrival(
	trip: AugmentedTripInstance,
	stop: AugmentedTripInstance["stopTimes"][number],
	actualDestinationArrivalTime: string | null,
): void {
	if (!actualDestinationArrivalTime || stop.rt_arrival_updated) return;
	const epoch = parseTimeWithConfig(actualDestinationArrivalTime, "Australia/Melbourne") / 1000;
	if (!Number.isFinite(epoch) || epoch <= 0) return;
	const actual = Math.round(epoch - getServiceDayStart(trip.serviceDate, "Australia/Melbourne"));
	const scheduled = stop.scheduled_arrival_time ?? actual;
	const delay = actual - scheduled;
	const delayClass = delay === 0 ? "on-time" : delay < 0 ? "early" : delay >= 600 ? "very-late" : "late";
	stop.actual_arrival_time = actual;
	if (stop.realtime) return;
	Object.assign(stop, {
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

export function applyJourneyPlannerService(
	trip: AugmentedTripInstance,
	details: VLineTripDetails,
	service: VLineJourneyPlannerService,
	observedAt: string,
): void {
	const raw = service.tdn;
	const consistFallback = service.platformEvent !== null;
	const source = consistFallback ? "vline-platform-services" : "vline-journey-planner";
	if (service.consistSubtype && (!consistFallback || !details.subtype)) details.subtype = observation(service.consistSubtype, source, "reported", observedAt, raw);
	if (service.consistCount && (!consistFallback || !details.unitCount)) details.unitCount = observation(service.consistCount, source, "reported", observedAt, raw);
	const cars = vlinePassengerCars(service.consistSubtype, service.consistCount);
	if (cars && (!consistFallback || !details.passengerCars)) details.passengerCars = observation(cars, source, "reported", observedAt, raw);
	if (service.consistVehicles?.length && (!consistFallback || !details.fullConsist)) details.fullConsist = observation(service.consistVehicles, source, "reported", observedAt, raw);
	if (service.accessibleSpaces != null && (!consistFallback || !details.accessibleSpaces)) details.accessibleSpaces = observation(service.accessibleSpaces, source, "reported", observedAt, raw);
	if (service.bicycleSpaces != null && (!consistFallback || !details.bicycleSpaces)) details.bicycleSpaces = observation(service.bicycleSpaces, source, "reported", observedAt, raw);
	if (!consistFallback || !details.isLiveConsistInfo) details.isLiveConsistInfo = observation(service.isLiveConsistInfo, source, "reported", observedAt, raw);
	if (service.consistDescription && (!consistFallback || !details.consistDescription)) details.consistDescription = observation(service.consistDescription, source, "reported", observedAt, raw);
	if (service.serviceStatus) details.serviceStatus = observation(service.serviceStatus, source, "reported", observedAt, raw);
	const stop = findStop(trip, service);
	if (service.platform) {
		const stopId = stop?.scheduled_parent_station_id ?? stop?.scheduled_stop_id;
		if (stopId) {
			const event = service.platformEvent ?? "both";
			details.platforms = details.platforms.filter((value) =>
				value.source !== "vline-platform-services" || value.stopId !== stopId || value.event !== event,
			);
			details.platforms.push({
				...observation(service.platform, "vline-platform-services", "confirmed", observedAt, raw),
				expiresAt: new Date(Date.parse(observedAt) + PLATFORM_TTL_MS).toISOString(),
				stopId, event, kind: "platform",
			});
		}
	}
	if (stop && service.platformEvent !== null) {
		applyJourneyPlannerArrival(trip, stop, service.actualArrivalTime);
	}
	if (service.actualDestinationArrivalTime) {
		const destination = normalizeStation(service.destination);
		const destinationStop = trip.stopTimes.find((call) => normalizeStation(callName(call)) === destination) ?? trip.stopTimes.at(-1);
		if (destinationStop && destinationStop !== stop) {
			applyJourneyPlannerArrival(trip, destinationStop, service.actualDestinationArrivalTime);
		} else if (destinationStop && !service.actualArrivalTime) {
			applyJourneyPlannerArrival(trip, destinationStop, service.actualDestinationArrivalTime);
		}
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

async function currentInstances(ctx: CacheContext): Promise<AugmentedTripInstance[]> {
	const earliest = Date.now() - DAY_MS, latest = Date.now() + DAY_MS * 2;
	const trips: AugmentedTripInstance[] = [];
	let scanned = 0;
	for (const trip of ctx.augmented.instancesRec.values()) {
		if (trip.feed_id === "vic-vline" && vlineTdn(trip.trip_id)) {
			const first = trip.stopTimes[0], seconds = first?.scheduled_departure_time ?? first?.scheduled_arrival_time;
			const instant = scheduledInstant(trip, seconds);
			if (instant == null || (instant >= earliest && instant <= latest)) trips.push(trip);
		}
		if (++scanned % 250 === 0) await new Promise((resolve) => setImmediate(resolve));
	}
	return trips;
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

export type VLinePlatformStationDemand = {
	location: string;
	stationKey: string;
	tripInstanceIds: string[];
	arrivals: boolean;
	departures: boolean;
	nextCallAt: number;
};

/** Select only API-canonical rail stations with a scheduled call inside the board window. */
export function vlinePlatformStationDemands(
	trips: readonly AugmentedTripInstance[],
	locations: readonly VLineJourneyPlannerLocation[],
	nowMs: number,
	windowMinutes = DEFAULT_PLATFORM_WINDOW_MINUTES,
): VLinePlatformStationDemand[] {
	const apiLocationByKey = new Map<string, VLineJourneyPlannerLocation>();
	for (const location of locations) {
		if (location.stopType?.toLowerCase() !== "station") continue;
		const key = normalizeStation(location.name);
		if (key && !apiLocationByKey.has(key)) apiLocationByKey.set(key, location);
	}
	const latest = nowMs + Math.max(30, windowMinutes) * 60_000;
	const demandByKey = new Map<string, {
		location: string;
		tripInstanceIds: Set<string>;
		arrivals: boolean;
		departures: boolean;
		nextCallAt: number;
	}>();
	for (const trip of trips) {
		if (trip.schedule_relationship === TripScheduleRelationship.CANCELED) continue;
		for (const call of trip.stopTimes) {
			if (call.passing) continue;
			const stationKey = normalizeStation(callName(call));
			const apiLocation = apiLocationByKey.get(stationKey);
			if (!apiLocation) continue;
			const arrivalAt = scheduledInstant(trip, call.scheduled_arrival_time);
			const departureAt = scheduledInstant(trip, call.scheduled_departure_time);
			const arrivals = call.drop_off_type !== DropOffType.None && arrivalAt != null && arrivalAt >= nowMs && arrivalAt <= latest;
			const departures = call.pickup_type !== PickupType.None && departureAt != null && departureAt >= nowMs && departureAt <= latest;
			if (!arrivals && !departures) continue;
			const nextCallAt = Math.min(arrivals ? arrivalAt! : Number.POSITIVE_INFINITY, departures ? departureAt! : Number.POSITIVE_INFINITY);
			const existing = demandByKey.get(stationKey);
			if (existing) {
				existing.tripInstanceIds.add(trip.instance_id);
				existing.arrivals ||= arrivals;
				existing.departures ||= departures;
				existing.nextCallAt = Math.min(existing.nextCallAt, nextCallAt);
			} else {
				demandByKey.set(stationKey, {
					location: apiLocation.name,
					tripInstanceIds: new Set([trip.instance_id]),
					arrivals,
					departures,
					nextCallAt,
				});
			}
		}
	}
	return [...demandByKey.entries()].map(([stationKey, demand]) => ({
		...demand,
		stationKey,
		tripInstanceIds: [...demand.tripInstanceIds],
	})).sort((a, b) => a.nextCallAt - b.nextCallAt || a.location.localeCompare(b.location));
}

export function vlinePlatformStationsDue(
	demands: readonly VLinePlatformStationDemand[],
	polls: ReadonlyMap<string, { lastAttemptAt: number }>,
	nowMs: number,
	refreshIntervalMs = DEFAULT_PLATFORM_REFRESH_MS,
	limit = PLATFORM_STATIONS_PER_REFRESH,
): VLinePlatformStationDemand[] {
	return demands.filter((demand) => {
		const poll = polls.get(demand.stationKey);
		return !poll || nowMs - poll.lastAttemptAt >= refreshIntervalMs;
	}).sort((a, b) => {
		const aAttempt = polls.get(a.stationKey)?.lastAttemptAt ?? 0;
		const bAttempt = polls.get(b.stationKey)?.lastAttemptAt ?? 0;
		return aAttempt - bAttempt || a.nextCallAt - b.nextCallAt;
	}).slice(0, Math.max(0, limit));
}

async function platformLocationsForPolling(
	state: ReturnType<typeof getVLineState>,
	options: NonNullable<VLinePluginOptions["journeyPlanner"]>,
	timeoutMs: number | undefined,
): Promise<{ locations: VLineJourneyPlannerLocation[]; requested: boolean; error: string | null }> {
	if (options.locations?.length) return {
		locations: options.locations.map((name) => ({ name, stopCode: null, stopType: "Station", line: null })),
		requested: false,
		error: null,
	};
	const cached = state.platformLocationsCache;
	if (cached && cached.expiresAt > Date.now()) return { locations: cached.locations, requested: false, error: null };
	try {
		const locations = await getVLineLocations(options, timeoutMs);
		state.platformLocationsCache = { locations, expiresAt: Date.now() + PLATFORM_LOCATION_TTL_MS };
		return { locations, requested: true, error: null };
	} catch (error) {
		return {
			locations: cached?.locations ?? [{ name: "Melbourne, Southern Cross", stopCode: "MEL", stopType: "Station", line: "All" }],
			requested: true,
			error: `locations: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

function serviceMatchesStation(
	service: VLineJourneyPlannerService,
	trip: AugmentedTripInstance,
	stationKey: string,
): boolean {
	return serviceMatchesPlatformTrip(service, trip, stationKey);
}

/** Match a platform-board row by V/Line run number at the requested station. */
export function serviceMatchesPlatformTrip(
	service: VLineJourneyPlannerService,
	trip: AugmentedTripInstance,
	stationKey: string,
): boolean {
	if (service.tdn !== vlineTdn(trip.trip_id)) return false;
	const stationCalls = trip.stopTimes.filter((call) =>
		!call.passing && normalizeStation(callName(call)) === stationKey,
	);
	if (!stationCalls.length) return false;

	// Retain the precise origin-time match when the board supplies it, then try
	// the requested station's event time for intermediate and terminating calls.
	if (serviceMatchesTrip(service, trip)) return true;
	const serviceInstant = parseTimeWithConfig(service.scheduledDepartureTime, "Australia/Melbourne");
	if (serviceInstant > 0 && stationCalls.some((call) => {
		const seconds = service.platformEvent === "arrival"
			? call.scheduled_arrival_time ?? call.scheduled_departure_time
			: call.scheduled_departure_time ?? call.scheduled_arrival_time;
		const callInstant = scheduledInstant(trip, seconds);
		return callInstant != null && Math.abs(callInstant - serviceInstant) <= 5 * 60_000;
	})) return true;

	// Some arrival/departure rows expose the run's origin time rather than the
	// local platform time. The run number is stable, so use it as a same-service-
	// day fallback after confirming that this trip actually calls at the station.
	const serviceDate = service.scheduledDepartureTime.slice(0, 10).replaceAll("-", "");
	return /^\d{8}$/.test(serviceDate) && serviceDate === trip.serviceDate;
}

async function pollPlatformStation(
	ctx: CacheContext,
	options: NonNullable<VLinePluginOptions["journeyPlanner"]>,
	demand: VLinePlatformStationDemand,
	observedAt: string,
	windowMinutes: number,
	timeoutMs: number | undefined,
): Promise<{ success: boolean; errors: string[] }> {
	const requests: { event: "arrival" | "departure"; request: Promise<VLineJourneyPlannerService[]> }[] = [];
	if (demand.departures) requests.push({
		event: "departure",
		request: getVLinePlatformDepartures(options, demand.location, "B", windowMinutes, timeoutMs),
	});
	if (demand.arrivals) requests.push({
		event: "arrival",
		request: getVLinePlatformArrivals(options, demand.location, "B", windowMinutes, timeoutMs),
	});
	const settled = await Promise.allSettled(requests.map((request) => request.request));
	const errors: string[] = [];
	let success = false;
	for (let index = 0; index < settled.length; index++) {
		const result = settled[index], event = requests[index].event;
		if (result.status === "rejected") {
			errors.push(`${demand.location} ${event}s: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
			continue;
		}
		success = true;
		for (const service of result.value) {
			if (normalizeStation(service.locationName) !== demand.stationKey) continue;
			for (const instanceId of demand.tripInstanceIds) {
				const trip = ctx.augmented.instancesRec.get(instanceId);
				if (!trip || !serviceMatchesStation(service, trip, demand.stationKey)) continue;
				const details = detailsFor(ctx, trip);
				if (details) applyJourneyPlannerService(trip, details, service, observedAt);
			}
		}
	}
	return { success, errors };
}

async function refreshVLinePlatformBoards(
	ctx: CacheContext,
	options: NonNullable<VLinePluginOptions["journeyPlanner"]>,
	trips: readonly AugmentedTripInstance[],
	observedAt: string,
	timeoutMs: number | undefined,
): Promise<void> {
	const state = getVLineState(ctx), status = state.sources["journey-planner"];
	status.enabled = true;
	const windowMinutes = Math.max(30, options.windowMinutes ?? DEFAULT_PLATFORM_WINDOW_MINUTES);
	const refreshIntervalMs = Math.max(60_000, options.platformRefreshIntervalMs ?? DEFAULT_PLATFORM_REFRESH_MS);
	const now = Date.parse(observedAt);
	const hasScheduledCall = trips.some((trip) => trip.stopTimes.some((call) => {
		const seconds = call.scheduled_departure_time ?? call.scheduled_arrival_time;
		const instant = scheduledInstant(trip, seconds);
		return !call.passing && instant != null && instant >= now && instant <= now + windowMinutes * 60_000;
	}));
	if (!hasScheduledCall) return;
	const locationResult = await platformLocationsForPolling(state, options, timeoutMs);
	const demands = vlinePlatformStationDemands(trips, locationResult.locations, now, windowMinutes);
	const due = vlinePlatformStationsDue(demands, state.platformPollByLocation, now, refreshIntervalMs);
	if (locationResult.requested || due.length) status.lastAttemptAt = observedAt;
	const results = await mapConcurrent(due, PLATFORM_POLL_CONCURRENCY, async (demand) => {
		const previous = state.platformPollByLocation.get(demand.stationKey);
		state.platformPollByLocation.set(demand.stationKey, { lastAttemptAt: now, lastSuccessAt: previous?.lastSuccessAt ?? null, error: null });
		const result = await pollPlatformStation(ctx, options, demand, observedAt, windowMinutes, timeoutMs);
		state.platformPollByLocation.set(demand.stationKey, {
			lastAttemptAt: now,
			lastSuccessAt: result.success ? now : (previous?.lastSuccessAt ?? null),
			error: result.errors.length ? result.errors.join("; ") : null,
		});
		return result;
	});
	if (locationResult.error || results.some((result) => result.errors.length)) {
		status.error = [locationResult.error, ...results.flatMap((result) => result.errors)].filter(Boolean).join("; ");
	} else if (locationResult.requested || results.length) {
		status.error = null;
	}
	if ((!locationResult.error && locationResult.requested) || results.some((result) => result.success)) {
		status.lastSuccessAt = observedAt;
	}
}

function firstScheduledCall(trip: AugmentedTripInstance) {
	return trip.stopTimes.find((stop) => !stop.passing &&
		(stop.scheduled_departure_time != null || stop.scheduled_arrival_time != null));
}

function lastScheduledCall(trip: AugmentedTripInstance) {
	return [...trip.stopTimes].reverse().find((stop) => !stop.passing);
}

function callName(call: AugmentedTripInstance["stopTimes"][number]): string | null {
	return call.scheduled_parent_station?.stop_name ?? call.scheduled_stop?.stop_name ?? null;
}

function scheduleVLineBookingPrefetches(
	ctx: CacheContext,
	options: VLinePluginOptions,
	trips: readonly AugmentedTripInstance[],
	now = Date.now(),
): void {
	const state = getVLineState(ctx);
	for (const trip of trips) {
		const first = firstScheduledCall(trip), last = lastScheduledCall(trip);
		const departure = first?.scheduled_departure_time ?? first?.scheduled_arrival_time;
		const departureMs = scheduledInstant(trip, departure);
		const origin = journeyLocationName(first ? callName(first) : null);
		const destination = journeyLocationName(last ? callName(last) : null);
		const scheduledDepartureTime = scheduledLocalDateTime(trip, departure);
		if (departureMs == null || !shouldPrefetchVLineBooking(departureMs, now) ||
			!origin || !destination || !scheduledDepartureTime) continue;
		const key = bookingSnapshotKeyForTrip(trip, origin, destination, scheduledDepartureTime);
		const snapshot = state.bookingSnapshots.get(key);
		if ((snapshot && snapshot.expiresAt > now) || state.bookingPrefetchAttempted.has(key)) continue;
		state.bookingPrefetchAttempted.add(key);
		void getVLineVehicleFormation(trip, ctx, options).catch((error) => {
			logger.warn(
				`V/Line pre-departure booking capture failed: ${error instanceof Error ? error.message : String(error)}`,
				{ module: "AU/VIC", function: "scheduleVLineBookingPrefetches" },
			);
		});
	}
}

export async function refreshVLineOfficialSources(ctx: CacheContext, options: VLinePluginOptions): Promise<void> {
	const state = getVLineState(ctx), observedAt = new Date().toISOString(), trips = await currentInstances(ctx);
	state.lastRefreshAt = observedAt;

	if (options.journeyPlanner) {
		try {
			await refreshVLinePlatformBoards(ctx, options.journeyPlanner, trips, observedAt, options.requestTimeoutMs);
		} catch (error) {
			state.sources["journey-planner"].error = error instanceof Error ? error.message : String(error);
		}
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

	if (options.journeyPlanner) scheduleVLineBookingPrefetches(ctx, options, trips);
}

export const _test = { currentInstances };

export function applyVLineEnrichment(ctx: CacheContext, options: VLinePluginOptions): void {
	const now = Date.now();
	const observedAt = new Date(now).toISOString();
	const vehiclesByTripId = new Map<string, RealtimeVehiclePosition[]>();
	for (const vehicle of getVehiclePositions(ctx)) {
		if (vehicle.feed_id !== "vic-vline") continue;
		const vehicles = vehiclesByTripId.get(vehicle.trip.trip_id);
		if (vehicles) vehicles.push(vehicle);
		else vehiclesByTripId.set(vehicle.trip.trip_id, [vehicle]);
	}
	for (const trip of ctx.augmented.instancesRec.values()) {
		if (trip.feed_id !== "vic-vline") continue;
		const details = detailsFor(ctx, trip);
		if (!details) continue;
		const vehicle = vehiclesByTripId.get(trip.trip_id)?.find((position) =>
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
		if (realtimeConsist?.length && (!details.fullConsist ||
			details.fullConsist.source === "vic-vline-gtfsrt-vehicle-positions" || details.fullConsist.source === "vline-platform-services"))
			details.fullConsist = observation(realtimeConsist, "vic-vline-gtfsrt-vehicle-positions", "reported", observedAt, vehicle?.vehicle.id);
		if (vehicle?.occupancy_status != null)
			details.occupancyStatus = observation(vehicle.occupancy_status, "vic-vline-gtfsrt-vehicle-positions", "reported", observedAt, vehicle.update_id);
		if (vehicle?.occupancy_percentage != null)
			details.occupancyPercentage = observation(vehicle.occupancy_percentage, "vic-vline-gtfsrt-vehicle-positions", "reported", observedAt, vehicle.update_id);
		if (vehicle?.multi_carriage_details.length)
			details.carriageOccupancy = observation(vehicle.multi_carriage_details, "vic-vline-gtfsrt-vehicle-positions", "reported", observedAt, vehicle.update_id);
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

export function journeyLocationName(
	value: string | null,
	locations: readonly VLineJourneyPlannerLocation[] = [],
): string | null {
	if (!value) return null;
	const fallback = /southern cross/i.test(value)
		? "Melbourne, Southern Cross"
		: value.replace(/\s+Railway\s+Station$/i, " Station").trim();
	const stationKey = normalizeStation(fallback);
	return locations.find((location) =>
		location.stopType?.toLowerCase() === "station" && normalizeStation(location.name) === stationKey,
	)?.name ?? fallback;
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

function bookingSnapshotKeyForTrip(
	trip: AugmentedTripInstance,
	origin: string,
	destination: string,
	scheduledDepartureTime: string,
): string {
	return vlineBookingSnapshotKey(
		trip.serviceDate,
		vlineTdn(trip.trip_id)!,
		scheduledDepartureTime,
		origin,
		destination,
	);
}

function bookingSnapshotExpiry(trip: AugmentedTripInstance): number {
	const last = lastScheduledCall(trip);
	const finalTime = last?.scheduled_arrival_time ?? last?.scheduled_departure_time;
	return (scheduledInstant(trip, finalTime) ?? Date.now() + DAY_MS) + BOOKING_SNAPSHOT_GRACE_MS;
}

function restoreBookingSnapshot(ctx: CacheContext, details: VLineTripDetails, key: string): void {
	const state = getVLineState(ctx);
	const snapshot = state.bookingSnapshots.get(key);
	if (!snapshot) return;
	if (snapshot.expiresAt <= Date.now()) {
		state.bookingSnapshots.delete(key);
		return;
	}
	if (!details.bookingAvailability ||
		Date.parse(details.bookingAvailability.observedAt) < Date.parse(snapshot.availability.observedAt)) {
		details.bookingAvailability = structuredClone(snapshot.availability);
	}
}

function persistBookingSnapshot(
	ctx: CacheContext,
	trip: AugmentedTripInstance,
	key: string,
	availability: NonNullable<VLineTripDetails["bookingAvailability"]>,
): void {
	const state = getVLineState(ctx);
	state.bookingSnapshots.set(key, {
		availability: structuredClone(availability),
		expiresAt: bookingSnapshotExpiry(trip),
	});
	try {
		saveVLineBookingSnapshots(ctx.config.cacheDir, state.bookingSnapshots);
	} catch (error) {
		logger.warn(
			`Failed to persist V/Line booking snapshots: ${error instanceof Error ? error.message : String(error)}`,
			{ module: "AU/VIC", function: "persistBookingSnapshot" },
		);
	}
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

function reportedAvailabilityCount(value: number | null | undefined): number | null {
	// Journey Planner uses zero when live inventory is unavailable. The public
	// booking page is the only source that can confirm a genuine zero count.
	return value != null && value > 0 ? value : null;
}

export function vlineServiceBookingAvailability(
	service: VLineJourneyPlannerService | null,
	observedAt: string,
): VehicleBookingAvailability | null {
	if (!service || !journeyServiceSupportsBooking(service)) return null;
	return {
		reservedCarriages: [...service.reservedCarriages],
		reservedSeatsAvailable: reportedAvailabilityCount(service.reservedSeatsAvailable),
		unreservedTicketsAvailable: reportedAvailabilityCount(service.unreservedTicketsAvailable),
		reservationAvailable: service.reservationAvailable,
		reservationRequired: service.reservationRequired,
		seatMapAvailable: false,
		journeyUrl: null,
		source: "V/Line Journey Planner",
		observedAt,
	};
}

/** Resolve the richer Journey Planner record only when a consumer asks for this trip's formation. */
export async function getVLineVehicleFormation(
	trip: AugmentedTripInstance,
	ctx: CacheContext,
	options: VLinePluginOptions,
): Promise<VehicleFormation | null> {
	if (trip.feed_id !== "vic-vline") return null;
	const first = firstScheduledCall(trip), last = lastScheduledCall(trip);
	const details = detailsFor(ctx, trip);
	if (!details) return null;
	const locationResult = options.journeyPlanner
		? await platformLocationsForPolling(getVLineState(ctx), options.journeyPlanner, options.requestTimeoutMs)
		: null;
	const locations = locationResult?.locations ?? [];
	const origin = journeyLocationName(first ? callName(first) : null, locations);
	const destination = journeyLocationName(last ? callName(last) : null, locations);
	const scheduled = first?.scheduled_departure_time ?? first?.scheduled_arrival_time;
	const scheduledDepartureTime = scheduledLocalDateTime(trip, scheduled);
	const bookingSnapshotKey = origin && destination && scheduledDepartureTime
		? bookingSnapshotKeyForTrip(trip, origin, destination, scheduledDepartureTime)
		: null;
	if (bookingSnapshotKey) restoreBookingSnapshot(ctx, details, bookingSnapshotKey);

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
				if ((booking.unreservedTicketsAvailable ?? 0) <= 0) {
					booking.reservationRequired ||= service?.reservationRequired ?? false;
				}
				if (booking.reservedCarriages.length === 0 && service?.reservedCarriages.length) {
					booking.reservedCarriages = [...service.reservedCarriages];
				}
				booking.reservedSeatsAvailable ??= reportedAvailabilityCount(service?.reservedSeatsAvailable);
				booking.unreservedTicketsAvailable ??= reportedAvailabilityCount(service?.unreservedTicketsAvailable);
				details.bookingAvailability = booking;
				if (bookingSnapshotKey) persistBookingSnapshot(ctx, trip, bookingSnapshotKey, booking);
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
	} : vlineServiceBookingAvailability(service, new Date().toISOString());
	const observed = details.fullConsist ?? details.subtype ?? details.passengerCars;
	const formationSource = observed?.source === "vline-platform-services" ? "V/Line Platform Services"
		: observed ? "V/Line Journey Planner" : null;
	const units = vlineFormationUnits(trip, details);
	return createVehicleFormation(trip, units, {
		accessibleSpaces: details.accessibleSpaces?.value ?? null,
		bicycleSpaces: details.bicycleSpaces?.value ?? null,
		// "IsLiveConsistInfo" can accompany type/count only. Do not describe that as a live formation.
		isLive: details.fullConsist?.value?.length ? (details.isLiveConsistInfo?.value ?? null) : null,
		source: formationSource,
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
