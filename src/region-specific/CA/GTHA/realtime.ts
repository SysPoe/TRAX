import {
	type CacheContext,
	getAugmentedTripInstance,
	getAugmentedTrips,
	getTripUpdates,
	replaceInjectedTripUpdates,
} from "../../../cache/index.js";
import { GTFS, type RealtimeVehiclePosition } from "qdf-gtfs";
import { type GthaOperatingScheduleResponse, GTHADeparturesResponse, UPEDeparturesResponse } from "./types.js";
import logger from "../../../utils/logger.js";
import { getServiceDayStart, getServiceDate } from "../../../utils/time.js";
import { getDefaultTimeZone } from "../../../config.js";
import { entityKey } from "../../../identity.js";
import { getPluginState } from "../../../plugins/types.js";
import { isConsideredTripId } from "../../../utils/considered.js";
import { getModelFromId } from "./vehicleModel.js";
import { mergeVehicleInfo } from "../../../utils/vehicleModel.js";
import { propagateBlockHandoffs } from "./block-handoff.js";
import { parse } from "node-html-parser";
import { cacheFileExists, loadCacheFile, writeCacheFileAtomic } from "../../../utils/fs.js";
import {
	GO_TRACKER_HEADERS,
	SOURCE_A_THROTTLE_MS,
	SOURCE_A_URL,
	SOURCE_B_THROTTLE_MS,
	SOURCE_B_URL,
	SOURCE_C_IDS,
	SOURCE_C_LOOKAHEAD_SECS,
	SOURCE_C_URL_TEMPLATE,
	SOURCE_CD_THROTTLE_MS,
	SOURCE_D_LOOKAHEAD_SECS,
	SOURCE_D_URL_TEMPLATE,
	SOURCE_E_EXCLUDED_STOPS,
	SOURCE_E_STOP_CONVERSION,
	SOURCE_E_THROTTLE_MS,
	SOURCE_E_URL_TEMPLATE,
	SOURCE_F_THROTTLE_MS,
	SOURCE_F_URL,
	SOURCE_PRIORITIES,
	ROUTE_GROUP_EAST,
	ROUTE_GROUP_WEST,
} from "./gtha-realtime-constants.js";
import {
	buildGthaOperatingScheduleUpdates,
	GTHA_OPERATING_SCHEDULE_SOURCE_ID,
	isGthaOperatingScheduleForServiceDate,
} from "./operating-schedule.js";

function fetchWithTimeout(ctx: CacheContext, input: string | URL, init: RequestInit = {}): Promise<Response> {
	return fetch(input, {
		...init,
		signal: init.signal ?? AbortSignal.timeout(ctx.config.requestTimeoutMs),
	});
}

type GthaRealtimeState = {
	activeModels: Set<string>;
	activeIds: Set<string>;
	activeCars: Set<string>;
	activePassengerCars: Set<number>;
	prevs: {
		tripInstanceId: string;
		stopId: string;
		actualPlatform: string | null;
		scheduledPlatform: string | null;
		priority: number;
	}[];
	lastSourceEFetchMs: Record<string, number>;
	lastSourceBFetchMs: number;
	nextSourceBFetchMs: number;
	sourceBCacheLoaded: boolean;
	lastSourceFFetchMs: number;
	lastSourceAFetchMs: number;
	lastSourceCFetchMs: Record<string, number>;
	lastSourceDFetchMs: Record<string, number>;
	vehiclePassengerCars: Record<string, number>;
	vehicleConsists: Record<string, string[]>;
	vehicleBearings: Map<string, { bearing: number; receivedAt: number }>;
	sourceBData: GthaOperatingScheduleResponse | null;
	operatingScheduleOverrides: number;
	operatingScheduleUnresolvedTrips: number;
	operatingScheduleUnresolvedStops: number;
};

const SOURCE_A_BEARING_MAX_AGE_MS = SOURCE_A_THROTTLE_MS * 3;
const SOURCE_B_RETRY_MS = 60 * 1000;
const SOURCE_B_CACHE_FILE = "region-specific/ca-gtha/operating-schedule.json";

export type GthaRealtimeDiagnostics = {
	sources: {
		id: "A" | "B" | "C" | "D" | "E" | "F";
		name: string;
		provider: string;
		purpose: string;
		refreshIntervalMs: number;
		lastRequestAt: string | null;
		targets: number;
	}[];
	activeVehicles: number;
	activeFleetItems: number;
	activePassengerCarCounts: number;
	activeModels: number;
	knownConsists: number;
	knownPassengerCarCounts: number;
	retainedPlatformAssignments: number;
	operatingScheduleOverrides: number;
	operatingScheduleUnresolvedTrips: number;
	operatingScheduleUnresolvedStops: number;
};

function getState(ctx: CacheContext): GthaRealtimeState {
	return getPluginState(ctx, "ca-gtha:realtime", () => ({
		activeModels: new Set(),
		activeIds: new Set(),
		activeCars: new Set(),
		activePassengerCars: new Set(),
		prevs: [],
		lastSourceEFetchMs: {},
		lastSourceBFetchMs: 0,
		nextSourceBFetchMs: 0,
		sourceBCacheLoaded: false,
		lastSourceFFetchMs: 0,
		lastSourceAFetchMs: 0,
		lastSourceCFetchMs: {},
		lastSourceDFetchMs: {},
		vehiclePassengerCars: {},
		vehicleConsists: {},
		vehicleBearings: new Map(),
		sourceBData: null,
		operatingScheduleOverrides: 0,
		operatingScheduleUnresolvedTrips: 0,
		operatingScheduleUnresolvedStops: 0,
	}));
}

/** GO Tracker calls its compass bearing `course`; accept a full-turn 360 as north. */
export function parseGthaCourse(value: unknown): number | null {
	if (typeof value !== "number" && typeof value !== "string") return null;
	const raw = typeof value === "string" ? value.trim() : value;
	if (raw === "") return null;
	const course = Number(raw);
	if (!Number.isFinite(course) || course < 0 || course > 360) return null;
	return course === 360 ? 0 : course;
}

/**
 * Source A is authoritative when available. Metrolinx currently publishes an
 * explicit zero placeholder for every GO bearing, so expose that as missing and
 * let consumers infer direction from consecutive positions instead.
 */
export function applyGthaVehicleBearing(
	vehicle: RealtimeVehiclePosition,
	supplementalBearing: number | null,
): RealtimeVehiclePosition {
	if (vehicle.feed_id !== "go") return vehicle;
	const bearing = supplementalBearing ?? (vehicle.position.bearing === 0 ? null : vehicle.position.bearing);
	if (bearing === vehicle.position.bearing) return vehicle;
	return { ...vehicle, position: { ...vehicle.position, bearing } };
}

export function enrichGthaVehiclePosition(
	vehicle: RealtimeVehiclePosition,
	ctx: CacheContext,
	now = Date.now(),
): RealtimeVehiclePosition {
	const observation = getState(ctx).vehicleBearings.get(
		entityKey({ feedId: vehicle.feed_id, localId: vehicle.trip.trip_id }),
	);
	const supplementalBearing =
		observation && now - observation.receivedAt <= SOURCE_A_BEARING_MAX_AGE_MS ? observation.bearing : null;
	return applyGthaVehicleBearing(vehicle, supplementalBearing);
}

export function getActiveVehicleModels(ctx: CacheContext): Set<string> {
	return getState(ctx).activeModels;
}
export function getActiveVehicleIds(ctx: CacheContext): Set<string> {
	return getState(ctx).activeIds;
}
export function getActiveCars(ctx: CacheContext): Set<string> {
	return getState(ctx).activeCars;
}
export function getActivePassengerCars(ctx: CacheContext): Set<number> {
	return getState(ctx).activePassengerCars;
}

/** Serializable coverage/cadence snapshot for the admin status page. */
export function getGthaRealtimeDiagnostics(ctx: CacheContext): GthaRealtimeDiagnostics {
	const state = getState(ctx);
	const at = (timestamp: number) => (timestamp > 0 ? new Date(timestamp).toISOString() : null);
	const latest = (timestamps: Record<string, number>) => Math.max(0, ...Object.values(timestamps));
	return {
		sources: [
			{
				id: "A",
				name: "In-service AVL",
				provider: "GO Tracker",
				purpose: "Vehicle IDs and passenger-car counts",
				refreshIntervalMs: SOURCE_A_THROTTLE_MS,
				lastRequestAt: at(state.lastSourceAFetchMs),
				targets: 1,
			},
			{
				id: "B",
				name: "Daily operating schedule",
				provider: "GO Tracker",
				purpose: "Operational stop patterns, platforms, and locomotive assignments",
				refreshIntervalMs: SOURCE_B_THROTTLE_MS,
				lastRequestAt: at(state.lastSourceBFetchMs),
				targets: 1,
			},
			{
				id: "C",
				name: "UP Express departures",
				provider: "Metrolinx",
				purpose: "UP Express platform assignments",
				refreshIntervalMs: SOURCE_CD_THROTTLE_MS,
				lastRequestAt: at(latest(state.lastSourceCFetchMs)),
				targets: Object.keys(state.lastSourceCFetchMs).length || SOURCE_C_IDS.length,
			},
			{
				id: "D",
				name: "GO stop departures",
				provider: "Metrolinx",
				purpose: "Near-term actual and scheduled platforms",
				refreshIntervalMs: SOURCE_CD_THROTTLE_MS,
				lastRequestAt: at(latest(state.lastSourceDFetchMs)),
				targets: Object.keys(state.lastSourceDFetchMs).length,
			},
			{
				id: "E",
				name: "Rail signage",
				provider: "GO Tracker",
				purpose: "Platforms and actual/scheduled coach counts",
				refreshIntervalMs: SOURCE_E_THROTTLE_MS,
				lastRequestAt: at(latest(state.lastSourceEFetchMs)),
				targets: Object.keys(state.lastSourceEFetchMs).length,
			},
			{
				id: "F",
				name: "Fleet finder",
				provider: "TransSee",
				purpose: "Ordered locomotive, coach, and cab-car consists",
				refreshIntervalMs: SOURCE_F_THROTTLE_MS,
				lastRequestAt: at(state.lastSourceFFetchMs),
				targets: 1,
			},
		],
		activeVehicles: state.activeIds.size,
		activeFleetItems: state.activeCars.size,
		activePassengerCarCounts: state.activePassengerCars.size,
		activeModels: state.activeModels.size,
		knownConsists: Object.keys(state.vehicleConsists).length,
		knownPassengerCarCounts: Object.keys(state.vehiclePassengerCars).length,
		retainedPlatformAssignments: state.prevs.length,
		operatingScheduleOverrides: state.operatingScheduleOverrides,
		operatingScheduleUnresolvedTrips: state.operatingScheduleUnresolvedTrips,
		operatingScheduleUnresolvedStops: state.operatingScheduleUnresolvedStops,
	};
}

/** Return the latest scraped fleet allocation even before it has propagated to every trip in the block. */
export function getVehicleConsist(ctx: CacheContext, vehicleId: string): string[] | null {
	return getState(ctx).vehicleConsists[vehicleId] ?? null;
}

function unmergeId(ctx: CacheContext, stopId: string): string {
	const merge = ctx.config.mergeStops.find((m) => m.to === stopId);
	return merge ? merge.from[0] : stopId;
}

function mergeId(ctx: CacheContext, stopId: string): string {
	const merge = ctx.config.mergeStops.find((m) => m.from.includes(stopId));
	return merge ? merge.to : stopId;
}

function applyPlatformUpdate(
	ctx: CacheContext,
	stopTime: {
		instance_id: string;
		actual_stop_id?: string | null;
		scheduled_stop_id?: string | null;
		actual_platform_code?: string | null;
		scheduled_platform_code?: string | null;
		rt_platform_code_updated?: boolean;
	},
	stopId: string,
	platform: string | null,
	scheduledPlatform: string | null,
	source: string,
	blockMap?: Map<string, any[]>,
) {
	const state = getState(ctx);
	const priority = SOURCE_PRIORITIES[source] ?? -1;
	const currentPriority = (stopTime as any).platformPriority ?? -1;

	const newActual = platform ?? stopTime.actual_platform_code ?? scheduledPlatform ?? null;
	const newScheduled = scheduledPlatform ?? stopTime.scheduled_platform_code ?? platform ?? null;

	if (currentPriority > priority) return;

	state.prevs = state.prevs.filter((v) => !(v.tripInstanceId === stopTime.instance_id && v.stopId === stopId));
	state.prevs.push({
		tripInstanceId: stopTime.instance_id,
		stopId,
		actualPlatform: newActual,
		scheduledPlatform: newScheduled,
		priority: priority,
	});

	stopTime.actual_platform_code = newActual;
	stopTime.scheduled_platform_code = newScheduled;
	stopTime.rt_platform_code_updated = true;
	(stopTime as any).platformSource = source;
	(stopTime as any).platformPriority = priority;

	// If this is the terminating stop, propagate platform to next trip in block if it starts here
	const ti = getAugmentedTripInstance(ctx, stopTime.instance_id);
	if (ti && ti.stopTimes.at(-1) === (stopTime as any)) {
		propagatePlatformToNextTripInBlock(ctx, ti, stopId, newActual, newScheduled, blockMap);
	}
}

function propagatePlatformToNextTripInBlock(
	ctx: CacheContext,
	currentInst: any,
	stopId: string,
	actualPlatform: string | null,
	scheduledPlatform: string | null,
	blockMap?: Map<string, any[]>,
) {
	if (!currentInst.block_id) return;

	let nextTrip: any = null;
	const currentEndTime =
		currentInst.stopTimes.at(-1)?.actual_arrival_time ?? currentInst.stopTimes.at(-1)?.scheduled_arrival_time;

	const blockTrips = blockMap
		? blockMap.get(currentInst.block_id) || []
		: (ctx.augmented.serviceDateTrips.get(currentInst.serviceDate) ?? [])
				.map((id) => ctx.augmented.tripsRec.get(id))
				.filter(Boolean)
				.flatMap((at) => at!.instances.filter((i) => i.serviceDate === currentInst.serviceDate));

	for (const inst of blockTrips) {
		if (inst.block_id !== currentInst.block_id || inst.instance_id === currentInst.instance_id) continue;

		const firstSt = inst.stopTimes[0];
		const startTime = (firstSt?.actual_departure_time ?? firstSt?.scheduled_departure_time) as number | null;
		if (startTime !== null && currentEndTime !== null && startTime >= (currentEndTime as number)) {
			const nextTripStartTime = (nextTrip?.stopTimes[0]?.actual_departure_time ??
				nextTrip?.stopTimes[0]?.scheduled_departure_time) as number | null;
			if (!nextTrip || startTime < (nextTripStartTime ?? Infinity)) {
				nextTrip = inst;
			}
		}
	}

	if (nextTrip && (nextTrip.stopTimes[0]?.actual_stop_id ?? nextTrip.stopTimes[0]?.scheduled_stop_id) === stopId) {
		const firstStopTime = nextTrip.stopTimes[0];
		applyPlatformUpdate(ctx, firstStopTime, stopId, actualPlatform, scheduledPlatform, "Propagation", blockMap);
	}
}

function registerCarTrips(ctx: CacheContext, tripId: string, carId: string) {
	let set = ctx.augmented.carTrips.get(carId);
	if (!set) {
		set = new Set();
		ctx.augmented.carTrips.set(carId, set);
	}
	set.add(tripId);
}

function getTripRouteGroup(ctx: CacheContext, tripId: string): string | null {
	const augmentedTrip = ctx.augmented.tripsRec.get(tripId);
	if (!augmentedTrip || !ctx.gtfs) return null;
	const routeId = augmentedTrip.route_id;
	const route = ctx.gtfs.getRoutes({ feed_id: augmentedTrip.feed_id, route_id: routeId })[0];
	if (!route) return null;
	const rsn = route.route_short_name;
	if (rsn && ROUTE_GROUP_EAST.includes(rsn)) return "EAST";
	if (rsn && ROUTE_GROUP_WEST.includes(rsn)) return "WEST";
	return null;
}

function propagateVehicleInfoToBlock(
	ctx: CacheContext,
	serviceDateStr: string,
	blockId: string | undefined | null,
	vehicleId: string | null,
	passengerCars: number | null,
	blockMap?: Map<string, any[]>,
	consist: string[] | null = null,
	sourceTripId?: string,
) {
	if (!blockId) return;

	let blockTrips = blockMap
		? blockMap.get(blockId) || []
		: (ctx.augmented.serviceDateTrips.get(serviceDateStr) ?? [])
				.map((id) => ctx.augmented.tripsRec.get(id))
				.filter((v) => v && v.block_id === blockId)
				.flatMap((at) => at!.instances.filter((i) => i.serviceDate === serviceDateStr));

	if (blockTrips.length === 0) return;

	// Sort trips by time
	blockTrips = [...blockTrips].sort((a, b) => {
		const aTime = a.stopTimes[0]?.scheduled_departure_time ?? 0;
		const bTime = b.stopTimes[0]?.scheduled_departure_time ?? 0;
		return aTime - bTime;
	});

	const sourceIndex = sourceTripId ? blockTrips.findIndex((inst) => inst.trip_id === sourceTripId) : -1;

	const updateInst = (inst: any, currentConsist: string[] | null) => {
		const info = {
			vehicle_id: vehicleId,
			vehicle_model: vehicleId ? getModelFromId(vehicleId) : null,
			passenger_cars: passengerCars,
			consist: currentConsist,
		};

		if (
			inst.vehicle_id === vehicleId &&
			inst.passenger_cars === (passengerCars ?? null) &&
			JSON.stringify(inst.consist) === JSON.stringify(currentConsist)
		) {
			if (inst.vehicle_id)
				registerCarTrips(ctx, entityKey({ feedId: inst.feed_id, localId: inst.trip_id }), inst.vehicle_id);
			if (inst.consist) {
				for (const carId of inst.consist)
					registerCarTrips(ctx, entityKey({ feedId: inst.feed_id, localId: inst.trip_id }), carId);
			}
			return;
		}

		const merged = mergeVehicleInfo(ctx, inst, info);
		inst.vehicle_id = merged.vehicle_id;
		inst.vehicle_model = merged.vehicle_model;
		inst.passenger_cars = merged.passenger_cars ?? null;
		if (currentConsist) inst.consist = currentConsist;

		if (inst.vehicle_id)
			registerCarTrips(ctx, entityKey({ feedId: inst.feed_id, localId: inst.trip_id }), inst.vehicle_id);
		if (inst.consist) {
			for (const carId of inst.consist)
				registerCarTrips(ctx, entityKey({ feedId: inst.feed_id, localId: inst.trip_id }), carId);
		}
	};

	if (sourceIndex === -1) {
		for (const inst of blockTrips) {
			updateInst(inst, consist);
		}
		return;
	}

	// Apply to source trip (redundant but safe)
	updateInst(blockTrips[sourceIndex], consist);

	// Propagate forwards
	let forwardConsist = consist;
	for (let i = sourceIndex + 1; i < blockTrips.length; i++) {
		const prev = blockTrips[i - 1];
		const curr = blockTrips[i];
		const groupPrev = getTripRouteGroup(ctx, entityKey({ feedId: prev.feed_id, localId: prev.trip_id }));
		const groupCurr = getTripRouteGroup(ctx, entityKey({ feedId: curr.feed_id, localId: curr.trip_id }));
		if (groupPrev && groupCurr && groupPrev === groupCurr && forwardConsist) {
			forwardConsist = [...forwardConsist].reverse();
		}
		updateInst(curr, forwardConsist);
	}

	// Propagate backwards
	let backwardConsist = consist;
	for (let i = sourceIndex - 1; i >= 0; i--) {
		const next = blockTrips[i + 1];
		const curr = blockTrips[i];
		const groupNext = getTripRouteGroup(ctx, entityKey({ feedId: next.feed_id, localId: next.trip_id }));
		const groupCurr = getTripRouteGroup(ctx, entityKey({ feedId: curr.feed_id, localId: curr.trip_id }));
		if (groupNext && groupCurr && groupNext === groupCurr && backwardConsist) {
			backwardConsist = [...backwardConsist].reverse();
		}
		updateInst(curr, backwardConsist);
	}
}

function formatTrack(track: string | null | undefined): string | null {
	if (!track) return null;
	track = track.trim();
	if (track === "-" || track === "") return null;
	if (/^\d+$/.test(track)) return track.replace(/^0+/, "");
	let s = track.split(/[^\d]/g).filter((v) => v.length > 0);
	if (s.length === 2) return `${s[0]} & ${s[1]}`;
	logger.error("Failed to parse track: " + track + " " + s + "!", {
		module: "CA/GTHA",
		function: "formatTrack",
	});
	return null;
}

function getUniqueStopTimesForRange(
	ctx: CacheContext,
	gtfs: GTFS,
	serviceDateStr: string,
	nowSecs: number,
	lookaheadSecs: number,
	stopId?: string,
) {
	const serviceDayStart = getServiceDayStart(serviceDateStr, getDefaultTimeZone(ctx.config));
	const inWindow = (timestamp: number | null | undefined) => {
		if (timestamp == null) return false;
		const serviceSeconds = timestamp > 1_000_000_000 ? timestamp - serviceDayStart : timestamp;
		return serviceSeconds >= nowSecs && serviceSeconds <= nowSecs + lookaheadSecs;
	};
	const stopTimes = gtfs
		.getStopTimes({
			...{ date: serviceDateStr, start_time: nowSecs, end_time: nowSecs + lookaheadSecs },
			...(stopId ? { stop_id: mergeId(ctx, stopId) } : {}),
		})
		.filter((v) => isConsideredTripId({ feedId: v.feed_id, localId: v.trip_id }, ctx))
		.map((v) => ({ feed_id: v.feed_id, stop_id: v.stop_id, trip_id: v.trip_id }))
		.concat(
			getTripUpdates(ctx).flatMap(
				(update) =>
					update.stop_time_updates
						?.filter(
							(stu) =>
								(!stopId || stu.stop_id === stopId) && inWindow(stu.departure_time ?? stu.arrival_time),
						)
						.map((stu) => ({
							feed_id: update.feed_id,
							stop_id: stu.stop_id,
							trip_id: update.trip.trip_id,
						})) ?? [],
			),
		)
		.filter((v) => v);

	const map = new Map<string, { feed_id: string; stop_id: string; trip_id: string }>();
	stopTimes.forEach((st) => {
		const key = `${st.feed_id}:${st.stop_id}-${st.trip_id}`;
		if (!map.has(key)) map.set(key, st);
	});
	return Array.from(map.values());
}

function normalizeStationName(value: string): string {
	return value
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/\s+go$/i, "")
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

function loadCachedSourceB(ctx: CacheContext, serviceDate: string): GthaOperatingScheduleResponse | null {
	if (!cacheFileExists(SOURCE_B_CACHE_FILE, ctx.config.cacheDir)) return null;
	try {
		const cached: unknown = JSON.parse(loadCacheFile(SOURCE_B_CACHE_FILE, ctx.config.cacheDir));
		return isGthaOperatingScheduleForServiceDate(cached, serviceDate) ? cached : null;
	} catch (error) {
		logger.warn(
			`Ignoring an unreadable Source B cache: ${error instanceof Error ? error.message : String(error)}`,
			{ module: "CA/GTHA", function: "loadCachedSourceB" },
		);
		return null;
	}
}

async function fetchSourceB(ctx: CacheContext, serviceDate: string): Promise<GthaOperatingScheduleResponse> {
	let lastError: unknown = new Error("Source B request failed");
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const response = await fetchWithTimeout(ctx, SOURCE_B_URL, { headers: GO_TRACKER_HEADERS });
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const data: unknown = await response.json();
			if (!isGthaOperatingScheduleForServiceDate(data, serviceDate)) {
				throw new Error(`response was not an operating schedule for ${serviceDate}`);
			}
			return data;
		} catch (error) {
			lastError = error;
		}
	}
	throw lastError;
}

/** Inject complete Source B override patterns before generic realtime augmentation. */
export async function refreshGthaOperatingSchedule(ctx: CacheContext): Promise<void> {
	if (!ctx.gtfs) throw new Error("Attempted to load the GTHA operating schedule before GTFS initialization");
	const state = getState(ctx);
	const now = Date.now();
	const serviceDate = getServiceDate(new Date(now), getDefaultTimeZone(ctx.config));

	if (state.sourceBData && !isGthaOperatingScheduleForServiceDate(state.sourceBData, serviceDate)) {
		state.sourceBData = null;
		state.sourceBCacheLoaded = false;
		state.nextSourceBFetchMs = 0;
		replaceInjectedTripUpdates(ctx, GTHA_OPERATING_SCHEDULE_SOURCE_ID, []);
		state.operatingScheduleOverrides = 0;
		state.operatingScheduleUnresolvedTrips = 0;
		state.operatingScheduleUnresolvedStops = 0;
	}
	if (!state.sourceBCacheLoaded) {
		state.sourceBCacheLoaded = true;
		state.sourceBData = loadCachedSourceB(ctx, serviceDate);
	}

	if (now >= state.nextSourceBFetchMs) {
		state.lastSourceBFetchMs = now;
		try {
			const data = await fetchSourceB(ctx, serviceDate);
			state.sourceBData = data;
			state.nextSourceBFetchMs = now + SOURCE_B_THROTTLE_MS;
			try {
				writeCacheFileAtomic(SOURCE_B_CACHE_FILE, JSON.stringify(data), ctx.config.cacheDir);
			} catch (error) {
				logger.warn(
					`Failed to persist the Source B cache: ${error instanceof Error ? error.message : String(error)}`,
					{ module: "CA/GTHA", function: "refreshGthaOperatingSchedule" },
				);
			}
		} catch (error) {
			state.nextSourceBFetchMs = now + SOURCE_B_RETRY_MS;
			if (!state.sourceBData) throw error;
			logger.warn(
				`Failed to refresh Source B; retaining today's cached operating schedule and retrying in one minute: ${error instanceof Error ? error.message : String(error)}`,
				{ module: "CA/GTHA", function: "refreshGthaOperatingSchedule" },
			);
		}
	}

	const data = state.sourceBData;
	if (!data) return;

	const tripsByNumber = new Map<string, ReturnType<GTFS["getTrips"]>>();
	for (const trip of ctx.gtfs.getTrips({ feed_id: "go", date: serviceDate })) {
		const tripNumber = trip.trip_id.match(/(\d+)$/)?.[1];
		if (!tripNumber) continue;
		const candidates = tripsByNumber.get(tripNumber);
		if (candidates) candidates.push(trip);
		else tripsByNumber.set(tripNumber, [trip]);
	}

	const stopIdsByName = new Map<string, Set<string>>();
	for (const stop of ctx.augmented.stops) {
		if (stop.feed_id !== "go" || !stop.stop_name) continue;
		const name = normalizeStationName(stop.stop_name);
		const stopId = stop.parent_stop_id ?? stop.stop_id;
		const ids = stopIdsByName.get(name);
		if (ids) ids.add(stopId);
		else stopIdsByName.set(name, new Set([stopId]));
	}

	const result = buildGthaOperatingScheduleUpdates(data, {
		serviceDayStartEpochSeconds: getServiceDayStart(serviceDate, getDefaultTimeZone(ctx.config)),
		resolveTrip: (tripNumber) => {
			const candidates = tripsByNumber.get(tripNumber) ?? [];
			return candidates.length === 1 ? candidates[0] : null;
		},
		resolveStopId: (stopName) => {
			const ids = stopIdsByName.get(normalizeStationName(stopName));
			return ids?.size === 1 ? ids.values().next().value! : null;
		},
	});

	replaceInjectedTripUpdates(ctx, GTHA_OPERATING_SCHEDULE_SOURCE_ID, result.updates);
	state.operatingScheduleOverrides = result.updates.length;
	state.operatingScheduleUnresolvedTrips = result.unresolvedTrips.length;
	state.operatingScheduleUnresolvedStops = result.unresolvedStops.length;
	logger.debug(
		`Source B injected ${result.updates.length} operating schedule overrides (${result.unresolvedTrips.length} unresolved trips, ${result.unresolvedStops.length} unresolved stops).`,
		{ module: "CA/GTHA", function: "refreshGthaOperatingSchedule" },
	);
}

export async function updateAllSources(ctx: CacheContext, gtfs: GTFS) {
	const state = getState(ctx);
	const timer = ctx.augmented.timer;
	timer.start("updateAllSources");

	state.activeIds.clear();
	state.activeModels.clear();
	state.activeCars.clear();
	state.activePassengerCars.clear();
	ctx.augmented.carTrips.clear();

	const now = new Date();
	const serviceDateStr = getServiceDate(now, getDefaultTimeZone(ctx.config));

	// Re-apply previous state (prevents UI flicker if context was reset but module state remains)
	state.prevs.forEach((v) => {
		const ti = getAugmentedTripInstance(ctx, v.tripInstanceId);
		const st = ti?.stopTimes.find((st) => (st.actual_stop_id ?? st.scheduled_stop_id) === v.stopId);
		if (st) {
			st.actual_platform_code = v.actualPlatform;
			st.scheduled_platform_code = v.scheduledPlatform;
			st.rt_platform_code_updated = true;
			(st as any).platformSource = "prevs";
			(st as any).platformPriority = v.priority ?? SOURCE_PRIORITIES.prevs;
		}
	});

	// Re-bootstrap carTrips from existing augmented data
	const existingTripsForDate = ctx.augmented.serviceDateTrips.get(serviceDateStr) ?? [];
	for (const tripId of existingTripsForDate) {
		const at = ctx.augmented.tripsRec.get(tripId);
		if (!at) continue;
		const inst = at.instances.find((i) => i.serviceDate === serviceDateStr);
		if (inst) {
			if (inst.vehicle_id)
				registerCarTrips(ctx, entityKey({ feedId: inst.feed_id, localId: inst.trip_id }), inst.vehicle_id);
			if (inst.consist) {
				for (const carId of inst.consist)
					registerCarTrips(ctx, entityKey({ feedId: inst.feed_id, localId: inst.trip_id }), carId);
			}
		}
	}
	const serviceDayStart = getServiceDayStart(serviceDateStr, getDefaultTimeZone(ctx.config));
	const nowSecs = Math.floor(now.getTime() / 1000 - serviceDayStart);
	const nowMs = Date.now();

	timer.start("updateAllSources:buildBlockMap");
	const blockMap = new Map<string, any[]>();
	const tripsForDate = ctx.augmented.serviceDateTrips.get(serviceDateStr) ?? [];
	for (const tripId of tripsForDate) {
		const at = ctx.augmented.tripsRec.get(tripId);
		if (!at) continue;
		const inst = at.instances.find((i) => i.serviceDate === serviceDateStr);
		if (!inst || !inst.block_id) continue;
		if (!blockMap.has(inst.block_id)) blockMap.set(inst.block_id, []);
		blockMap.get(inst.block_id)!.push(inst);
	}
	timer.stop("updateAllSources:buildBlockMap");

	timer.start("updateSourceF");
	await updateSourceF(ctx, serviceDateStr, blockMap);
	timer.stop("updateSourceF");

	// --- 1. Fetch Data (with throttles) ---

	// Source A
	let sourceAPromise: Promise<any> | null = null;
	if (nowMs - state.lastSourceAFetchMs >= SOURCE_A_THROTTLE_MS) {
		state.lastSourceAFetchMs = nowMs;
		sourceAPromise = fetchWithTimeout(ctx, SOURCE_A_URL, { headers: GO_TRACKER_HEADERS })
			.then((r) => (r.ok ? r.json() : null))
			.catch(() => null);
	}

	// Source C
	const sourceCFetches = SOURCE_C_IDS.filter((stop_id) => {
		if (nowMs - (state.lastSourceCFetchMs[stop_id] ?? 0) < SOURCE_CD_THROTTLE_MS) return false;
		state.lastSourceCFetchMs[stop_id] = nowMs;
		return true;
	}).map((stop_id) => ({
		stop_id,
		promise: fetchWithTimeout(ctx, SOURCE_C_URL_TEMPLATE(stop_id))
			.then(async (r) => (r.ok ? ((await r.json()) as UPEDeparturesResponse) : null))
			.catch((e) => {
				logger.error(`Failed to update Source C platforms for stop ${stop_id}: ${e.message ?? e}`, {
					module: "CA/GTHA",
				});
				console.error(e);
			}),
	}));

	// Source D (requires identifying active stops first)
	timer.start("updateAllSources:getStopTimesSourceD");
	const uniqueStopTimesSourceD = getUniqueStopTimesForRange(
		ctx,
		gtfs,
		serviceDateStr,
		nowSecs,
		SOURCE_D_LOOKAHEAD_SECS,
	);
	timer.stop("updateAllSources:getStopTimesSourceD");

	const sourceDStopIds = Array.from(new Set(uniqueStopTimesSourceD.map((v) => unmergeId(ctx, v.stop_id))));
	const sourceDFetches = sourceDStopIds
		.filter((stop_id) => {
			if (nowMs - (state.lastSourceDFetchMs[stop_id] ?? 0) < SOURCE_CD_THROTTLE_MS) return false;
			state.lastSourceDFetchMs[stop_id] = nowMs;
			return true;
		})
		.map((stop_id) => ({
			stop_id: mergeId(ctx, stop_id),
			promise: fetchWithTimeout(ctx, SOURCE_D_URL_TEMPLATE(stop_id))
				.then(async (r) => (r.ok ? ((await r.json()) as GTHADeparturesResponse) : null))
				.catch((e) => {
					logger.error(`Failed to update Source D platforms for stop ${stop_id}: ${e.message ?? e}`, {
						module: "CA/GTHA",
					});
					console.error(e);
					return null;
				}),
		}));

	// Source E
	timer.start("updateAllSources:getStopTimesSourceE");
	// Fetch all stop times for the current service day (24h)
	const uniqueStopTimesSourceE = getUniqueStopTimesForRange(ctx, gtfs, serviceDateStr, 0, 86400);
	timer.stop("updateAllSources:getStopTimesSourceE");

	// Group stop times by stop_id for O(1) lookup during Source E processing
	const stopTimesByStopE = new Map<string, typeof uniqueStopTimesSourceE>();
	for (const st of uniqueStopTimesSourceE) {
		if (!stopTimesByStopE.has(st.stop_id)) stopTimesByStopE.set(st.stop_id, []);
		stopTimesByStopE.get(st.stop_id)!.push(st);
	}

	const sourceEStopIds = Array.from(
		new Set(
			uniqueStopTimesSourceE
				.filter((v) => !SOURCE_E_EXCLUDED_STOPS.has(unmergeId(ctx, v.stop_id)))
				.map((v) => unmergeId(ctx, v.stop_id)),
		),
	);
	const sourceEFetches = sourceEStopIds
		.filter((stop_id) => {
			if (nowMs - (state.lastSourceEFetchMs[stop_id] ?? 0) < SOURCE_E_THROTTLE_MS) return false;
			state.lastSourceEFetchMs[stop_id] = nowMs;
			return true;
		})
		.map((stop_id) => {
			const corridor_codes = SOURCE_E_STOP_CONVERSION[stop_id] ?? [];
			return {
				stop_id: mergeId(ctx, stop_id),
				corridors: corridor_codes.map((code) => ({
					code,
					promise: fetchWithTimeout(ctx, SOURCE_E_URL_TEMPLATE(code, stop_id), {
						headers: GO_TRACKER_HEADERS,
					})
						.then((r) => (r.ok ? r.json() : null))
						.catch((e) => {
							logger.error(
								`Failed to fetch Source E for stop ${stop_id} corridor ${code}: ${e.message}`,
								{
									module: "CA/GTHA",
								},
							);
							console.error(e);
							return null;
						}),
				})),
			};
		});

	// --- 2. Process State & Wait for Departures ---

	timer.start("updateAllSources:processAPIs");

	// Process Source D Departures
	for (const item of sourceDFetches) {
		const data = await item.promise;
		if (!data) continue;

		for (const departure of data.trainDepartures.items) {
			const tripNumber = departure.tripNumber;
			let platform = formatTrack(departure.platform);
			let scheduledPlatform = formatTrack(departure.scheduledPlatform);

			platform = platform ?? scheduledPlatform;

			if (platform === null && scheduledPlatform === null) continue;

			for (const st of uniqueStopTimesSourceD) {
				if (!st.trip_id.endsWith(tripNumber)) continue;
				const instance = getAugmentedTrips(ctx, { feedId: st.feed_id, localId: st.trip_id })[0]?.instances.find(
					(v) => {
						if (v.serviceDate === departure.scheduledDateTime.slice(0, 10).replace(/-/g, "")) return true;
						const offset = v.stopTimes.find(
							(fst) => fst.actual_stop_id === item.stop_id,
						)?.scheduled_departure_date_offset;
						if (!offset) return false;

						const prevDate = new Date(departure.scheduledDateTime.slice(0, 10));
						prevDate.setDate(prevDate.getDate() - offset);
						return prevDate.toISOString().slice(0, 10).replace(/-/g, "") === v.serviceDate;
					},
				);

				const ast = instance?.stopTimes.find((ast) => ast.actual_stop_id === item.stop_id);
				if (ast && ast.actual_stop_id)
					applyPlatformUpdate(ctx, ast, item.stop_id, platform, scheduledPlatform, "Source D", blockMap);
			}
		}
	}

	// Process Source C Departures
	timer.start("updateAllSources:getStopTimesSourceC");
	const uniqueStopTimesSourceC = getUniqueStopTimesForRange(
		ctx,
		gtfs,
		serviceDateStr,
		nowSecs,
		SOURCE_C_LOOKAHEAD_SECS,
	);
	timer.stop("updateAllSources:getStopTimesSourceC");

	for (const item of sourceCFetches) {
		const data = await item.promise;
		if (!data) continue;
		const dateStr = data.metadata.timeStamp.slice(0, 10).replace(/-/g, "");

		for (const departure of data.departures) {
			const platform = formatTrack(departure.platform);
			if (platform === null) continue;

			for (const st of uniqueStopTimesSourceC) {
				if (!st.trip_id.endsWith(departure.tripNumber)) continue;
				const instance =
					getAugmentedTrips(ctx, { feedId: st.feed_id, localId: st.trip_id })[0]?.instances.find(
						(v) => v.serviceDate === dateStr,
					) ?? getAugmentedTrips(ctx, { feedId: st.feed_id, localId: st.trip_id })[0]?.instances[0];

				const ast = instance?.stopTimes.find((ast) => ast.actual_stop_id === mergeId(ctx, item.stop_id));
				if (ast)
					applyPlatformUpdate(ctx, ast, mergeId(ctx, item.stop_id), platform, null, "Source C", blockMap);
			}
		}
	}

	// Process Source E
	for (const item of sourceEFetches) {
		const results = await Promise.all(item.corridors.map((c) => c.promise));
		const validResults = results.filter(Boolean);
		if (validResults.length > 0) {
			processSourceEUpdates(
				item.stop_id,
				validResults,
				stopTimesByStopE.get(item.stop_id) ?? [],
				ctx,
				serviceDateStr,
			);
		}
	}
	timer.stop("updateAllSources:processAPIs");

	// --- 3. Process Source A & Source B ---

	const tripNumberToIds = new Map<string, string[]>();
	for (const item of uniqueStopTimesSourceE) {
		const tid = item.trip_id;
		const match = tid.match(/\d+$/);
		if (match) {
			const num = match[0];
			if (!tripNumberToIds.has(num)) tripNumberToIds.set(num, []);
			const list = tripNumberToIds.get(num)!;
			const key = entityKey({ feedId: item.feed_id, localId: tid });
			if (!list.includes(key)) list.push(key);
		}
	}

	if (sourceAPromise) {
		timer.start("updateAllSources:SourceA");
		await updateSourceA(ctx, tripNumberToIds, serviceDateStr, blockMap, await sourceAPromise);
		timer.stop("updateAllSources:SourceA");
	}

	if (state.sourceBData) {
		timer.start("updateAllSources:SourceB");
		await updateSourceB(ctx, tripNumberToIds, serviceDateStr, state.sourceBData, blockMap);
		timer.stop("updateAllSources:SourceB");
	}

	propagateBlockHandoffs(blockMap);

	timer.stop("updateAllSources");
}

export async function updateSourceB(
	ctx: CacheContext,
	tripNumberToIds: Map<string, string[]>,
	serviceDateStr: string,
	data: GthaOperatingScheduleResponse,
	blockMap?: Map<string, any[]>,
) {
	const state = getState(ctx);
	const timer = ctx.augmented.timer;
	timer.start("updateSourceB");
	try {
		const commitmentTrips = data.commitmentTrip;

		logger.debug(`GTHA Schedule: Processing ${commitmentTrips.length} commitment trips`, {
			module: "CA/GTHA",
			function: "updateGTHASchedule",
		});

		let updateCount = 0;
		for (const trip of commitmentTrips) {
			const tripNumber = trip.tripNumber;
			const tripIds = tripNumberToIds.get(tripNumber) || [];

			if (tripIds.length === 0) continue;

			for (const tripId of tripIds) {
				const augmentedTrip = ctx.augmented.tripsRec.get(tripId);
				if (!augmentedTrip) continue;

				const instance = augmentedTrip.instances.find((v: any) => v.serviceDate === serviceDateStr);
				if (!instance) continue;
				if (trip.stop.some((stop) => stop.isOverride === "1")) {
					const destination = trip.stop
						.filter((stop) => stop.isStopping === "1" && stop.isCancelled !== "1")
						.at(-1)?.name;
					if (destination) {
						const prefix = instance.trip_headsign?.match(/^(.*? - )/)?.[1] ?? "";
						instance.trip_headsign = `${prefix}${destination}`;
					}
				}

				// Pre-calculate time map for this instance's stopTimes for faster lookup
				const timeMap = new Map<string, any>();
				for (const st of instance.stopTimes) {
					const gtfsTimeSecs = st.scheduled_departure_time ?? st.scheduled_arrival_time;
					if (gtfsTimeSecs === null) continue;
					const h = Math.floor((gtfsTimeSecs / 3600) % 24);
					const m = Math.floor((gtfsTimeSecs % 3600) / 60);
					const hhmm = `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
					timeMap.set(hhmm, st);
				}

				for (const gtStop of trip.stop) {
					const schTime = gtStop.schDeparture || gtStop.schArrival;
					if (!schTime) continue;

					const targetStopTime = timeMap.get(schTime);

					if (targetStopTime) {
						const schTrack = formatTrack(gtStop.schTrack);
						const actTrack = formatTrack(gtStop.completeInfo?.actTrack);

						if (schTrack || actTrack) {
							applyPlatformUpdate(
								ctx,
								targetStopTime,
								targetStopTime.actual_stop_id ?? targetStopTime.scheduled_stop_id ?? "",
								actTrack ?? schTrack,
								schTrack,
								"Source B",
								blockMap,
							);
							updateCount++;
						}

						if (gtStop.engineId && gtStop.engineId !== "-" && gtStop.engineId.trim() !== "") {
							state.activeIds.add(gtStop.engineId);
							state.activeCars.add(gtStop.engineId);
							const vehicle_model = getModelFromId(gtStop.engineId);
							if (vehicle_model) state.activeModels.add(vehicle_model);

							const vehicleInfo = mergeVehicleInfo(ctx, instance, {
								vehicle_id: gtStop.engineId,
								vehicle_model,
								passenger_cars: state.vehiclePassengerCars[gtStop.engineId] ?? null,
								consist: state.vehicleConsists[gtStop.engineId] ?? null,
							});
							instance.vehicle_id = vehicleInfo.vehicle_id;
							instance.vehicle_model = vehicleInfo.vehicle_model;
							instance.passenger_cars = vehicleInfo.passenger_cars ?? null;
							instance.consist = vehicleInfo.consist ?? null;

							propagateVehicleInfoToBlock(
								ctx,
								serviceDateStr,
								instance.block_id,
								instance.vehicle_id,
								instance.passenger_cars,
								blockMap,
								instance.consist,
								instance.trip_id,
							);
						}
					}
				}
			}
		}

		logger.debug(`GTHA Schedule: Completed with ${updateCount} platform updates`, {
			module: "CA/GTHA",
			function: "updateGTHASchedule",
		});
	} catch (e) {
		logger.error(`Failed to update Source B: ${(e as any).message ?? e}`, {
			module: "CA/GTHA",
			function: "updateSourceB",
		});
		console.error(e);
	}
	timer.stop("updateSourceB");
}

export async function updateSourceA(
	ctx: CacheContext,
	tripNumberToIds: Map<string, string[]>,
	serviceDateStr: string,
	blockMap?: Map<string, any[]>,
	data?: any,
) {
	const state = getState(ctx);
	const timer = ctx.augmented.timer;
	timer.start("updateSourceA");
	try {
		if (!data) {
			const response = await fetchWithTimeout(ctx, SOURCE_A_URL, { headers: GO_TRACKER_HEADERS });
			if (!response.ok) return;

			data = await response.json();
		}
		if (!data) return;

		const trips = (data.trip as any[]).filter((v) => v.source !== "B");
		const receivedAt = Date.now();
		const vehicleBearings = new Map<string, { bearing: number; receivedAt: number }>();
		for (const trip of trips) {
			const bearing = parseGthaCourse(trip.course);
			if (bearing === null) continue;
			for (const tripId of tripNumberToIds.get(String(trip.tripNumber)) ?? []) {
				vehicleBearings.set(tripId, { bearing, receivedAt });
			}
		}
		state.vehicleBearings = vehicleBearings;

		logger.debug(`Source A: Processing ${trips.length} active trips`, {
			module: "CA/GTHA",
			function: "updateSourceA",
		});

		// Pass 1: Update persistent cache from current AVL data
		for (const trip of trips) {
			const vehicleId = trip.vehicleNumber;
			if (!vehicleId || vehicleId === "-") continue;

			const vehicleType = trip.vehicleType ?? "";
			if (vehicleType.startsWith("L")) {
				const num = Number.parseInt(vehicleType.slice(1), 10);
				if (!Number.isNaN(num)) {
					state.activePassengerCars.add(num);
					state.vehiclePassengerCars[vehicleId] = num;
				}
			}
		}

		let updateCount = 0;
		// Pass 2: Apply to instances, using cache for missing car counts
		for (const trip of trips) {
			const tripNumber = trip.tripNumber;
			const vehicleId = trip.vehicleNumber && trip.vehicleNumber !== "-" ? trip.vehicleNumber : null;
			const vehicleType = trip.vehicleType ?? "";

			let passengerCars: number | null = null;
			if (vehicleType.startsWith("L")) {
				const num = Number.parseInt(vehicleType.slice(1), 10);
				if (!Number.isNaN(num)) passengerCars = num;
			}

			// If missing car count but we have a vehicle ID, try the cache
			if (passengerCars === null && vehicleId && state.vehiclePassengerCars[vehicleId]) {
				passengerCars = state.vehiclePassengerCars[vehicleId];
			}

			if (vehicleId) {
				state.activeIds.add(vehicleId);
				state.activeCars.add(vehicleId);
				const vehicle_model = getModelFromId(vehicleId);
				if (vehicle_model) state.activeModels.add(vehicle_model);
			}

			const tripIds = tripNumberToIds.get(tripNumber) || [];
			for (const tripId of tripIds) {
				const augmentedTrip = ctx.augmented.tripsRec.get(tripId);
				if (!augmentedTrip) continue;

				const instance = augmentedTrip.instances.find((v) => v.serviceDate === serviceDateStr);
				if (!instance) continue;

				if (vehicleId) {
					const vehicleInfo = mergeVehicleInfo(ctx, instance, {
						vehicle_id: vehicleId,
						vehicle_model: getModelFromId(vehicleId),
						passenger_cars: passengerCars,
						consist: state.vehicleConsists[vehicleId] ?? null,
					});
					instance.vehicle_id = vehicleInfo.vehicle_id;
					instance.vehicle_model = vehicleInfo.vehicle_model;
					instance.passenger_cars = vehicleInfo.passenger_cars ?? null;
					instance.consist = vehicleInfo.consist ?? null;

					propagateVehicleInfoToBlock(
						ctx,
						serviceDateStr,
						instance.block_id,
						instance.vehicle_id,
						instance.passenger_cars,
						blockMap,
						instance.consist,
						instance.trip_id,
					);
				} else if (passengerCars !== null) {
					const vehicleInfo = mergeVehicleInfo(ctx, instance, {
						vehicle_id: null,
						vehicle_model: null,
						passenger_cars: passengerCars,
					});
					instance.passenger_cars = vehicleInfo.passenger_cars ?? null;

					propagateVehicleInfoToBlock(
						ctx,
						serviceDateStr,
						instance.block_id,
						instance.vehicle_id,
						instance.passenger_cars,
						blockMap,
						instance.consist,
						instance.trip_id,
					);
				}
				updateCount++;
			}
		}

		logger.debug(`GTHA AVL: Completed vehicle updates for ${updateCount} trip instances`, {
			module: "CA/GTHA",
			function: "updateGTHAAVL",
		});
	} catch (e) {
		logger.error(`Failed to update Source A: ${(e as any).message ?? e}`, {
			module: "CA/GTHA",
			function: "updateSourceA",
		});
		console.error(e);
	}
	timer.stop("updateSourceA");
}

function processSourceEUpdates(
	stop_id: string,
	dataList: any[],
	stopTimes: { feed_id: string; stop_id: string; trip_id: string }[],
	ctx: CacheContext,
	serviceDateStr: string,
) {
	const state = getState(ctx);
	let tripMessages: any[] = [];

	for (const data of dataList) {
		if (!data?.directions) continue;
		for (const direction of data.directions) {
			if (direction.tripMessages) {
				tripMessages = tripMessages.concat(direction.tripMessages);
			}
		}
	}

	for (const trip of tripMessages) {
		if (!trip?.tripName) continue;

		const platform = trip.track?.toString()?.trim();
		if (!platform) continue;

		const targetServiceDate = trip.scheduled?.slice(0, 10).replace(/-/g, "") ?? serviceDateStr;

		// Optimization: build a map of st to trip_id for the current trip name to avoid inner loop overhead
		const relevantSts = stopTimes.filter((st) => st.trip_id.endsWith(trip.tripName));

		for (const st of relevantSts) {
			const instance = getAugmentedTrips(ctx, { feedId: st.feed_id, localId: st.trip_id })[0]?.instances.find(
				(v) => v.serviceDate === targetServiceDate,
			);

			if (!instance) continue;
			const ast = instance.stopTimes.find((f_ast) => f_ast.actual_stop_id === st.stop_id);
			if (!ast) continue;
			applyPlatformUpdate(ctx, ast, stop_id, platform, null, "Source E");

			if (trip.coachCount !== undefined) {
				instance.passenger_cars = trip.coachCount;
				if (instance.vehicle_id) state.vehiclePassengerCars[instance.vehicle_id] = trip.coachCount;
			} else if (instance.vehicle_id && state.vehiclePassengerCars[instance.vehicle_id]) {
				instance.passenger_cars = state.vehiclePassengerCars[instance.vehicle_id];
			}

			propagateVehicleInfoToBlock(
				ctx,
				targetServiceDate,
				instance.block_id,
				instance.vehicle_id,
				instance.passenger_cars,
				undefined,
				instance.consist,
			);

			if (trip.scheduledCoachCount !== undefined) instance.scheduled_passenger_cars = trip.scheduledCoachCount;
		}
	}
}

export async function updateSourceF(ctx: CacheContext, serviceDateStr: string, blockMap?: Map<string, any[]>) {
	const state = getState(ctx);
	const now = Date.now();
	if (now - state.lastSourceFFetchMs < SOURCE_F_THROTTLE_MS) return;
	state.lastSourceFFetchMs = now;

	try {
		const response = await fetchWithTimeout(ctx, SOURCE_F_URL);
		if (!response.ok) return;
		const html = await response.text();

		const root = parse(html);
		const trainParagraphs = root.querySelectorAll("p[id]");

		let matchCount = 0;
		let tripUpdatedCount = 0;

		for (const p of trainParagraphs) {
			const vehicleNumber = Number.parseInt(p.getAttribute("id") ?? "");
			if (Number.isNaN(vehicleNumber)) continue;

			// Extract destination from paragraph text
			const pInnerHTML = p.innerHTML;
			const destination =
				pInnerHTML
					.split("</span>")
					.pop()
					?.split("<br>")[0]
					?.replace(/<[^>]+>/g, "")
					.replace(/^to\s+/, "")
					.trim() || "";

			const table = p.nextElementSibling;
			if (!table || table.tagName !== "TABLE") continue;

			const rows = table.querySelectorAll("tr");
			if (rows.length < 2) continue;

			matchCount++;

			const fleetRow = rows[0]
				.querySelectorAll("td")
				.slice(1)
				.map((td) => td.text.trim());
			const infoRow = rows[1].querySelectorAll("td").map((td) => td.text.trim());

			let locoIdx = infoRow.findIndex((s) => s.toLowerCase().includes("locomotive"));
			let cabIdx = infoRow.findIndex((s) => s.toLowerCase().includes("cab"));

			const isToUnion = destination.includes("Union Station");

			let consist = [...fleetRow];
			const cabIsLead = isToUnion;

			if (cabIdx !== -1 && locoIdx !== -1) {
				const cabAtStart = cabIdx < locoIdx;
				if (cabIsLead !== cabAtStart) {
					consist.reverse();
				}
			}

			state.vehicleConsists[vehicleNumber] = consist;
			consist.forEach((car) => state.activeCars.add(car));

			const tripsForDate = ctx.augmented.serviceDateTrips.get(serviceDateStr) ?? [];
			for (const tripId of tripsForDate) {
				const augmentedTrip = ctx.augmented.tripsRec.get(tripId);
				if (!augmentedTrip) continue;
				const instance = augmentedTrip.instances.find((v) => v.serviceDate === serviceDateStr);
				if (!instance) continue;

				if (instance.vehicle_id === vehicleNumber.toString()) {
					instance.consist = consist;
					tripUpdatedCount++;
					propagateVehicleInfoToBlock(
						ctx,
						serviceDateStr,
						instance.block_id,
						instance.vehicle_id,
						instance.passenger_cars,
						blockMap,
						consist,
					);
				}
			}
		}

		logger.debug(`Updated Source F w/ ${matchCount} matches and ${tripUpdatedCount} trips`, {
			module: "CA/GTHA",
			function: "updateSourceF",
		});
	} catch (e) {
		logger.error(`Failed to fetch Source F: ${(e as any).message ?? e}`, {
			module: "CA/GTHA",
			function: "updateSourceF",
		});
		console.error(e);
	}
}
