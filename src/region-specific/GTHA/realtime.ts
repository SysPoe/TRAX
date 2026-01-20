import { CacheContext, getAugmentedTripInstance, getAugmentedTrips, getTripUpdates } from "../../cache.js";
import { GTFS } from "qdf-gtfs";
import { GTHADeparturesResponse, UPEDeparturesResponse } from "./types.js";
import logger from "../../utils/logger.js";
import { getServiceDayStart, getServiceDate } from "../../utils/time.js";
import { isConsideredTripId } from "../../utils/considered.js";
import { getModelFromId } from "./vehicleModel.js";
import { mergeVehicleInfo } from "../../utils/vehicleModel.js";
import { parse } from "node-html-parser";

// --- Config & Settings ---
const SOURCE_C_LOOKAHEAD_SECS = 7200;
const SOURCE_D_LOOKAHEAD_SECS = 600;

const SOURCE_E_REFERRER = "https://www.gotracker.ca/gotracker/web/";
const SOURCE_E_EXCLUDED_STOPS = new Set(["PA", "UN"]);

const SOURCE_C_IDS = ["UN", "PA", "BL", "MD", "WE"];

const SOURCE_E_STOP_CONVERSION: Record<string, string[]> = {
	UN: ["BR", "GT", "LE", "LW", "ST"],
	DW: ["BR"],
	RU: ["BR"],
	MP: ["BR"],
	KC: ["BR"],
	AU: ["BR"],
	NE: ["BR"],
	EA: ["BR"],
	BD: ["BR"],
	BA: ["BR"],
	AD: ["BR"],
	BL: ["GT"],
	MD: ["GT"],
	WE: ["GT"],
	MA: ["GT"],
	BE: ["GT"],
	BR: ["GT"],
	MO: ["GT"],
	GE: ["GT"],
	AC: ["GT"],
	GL: ["GT"],
	KI: ["GT"],
	DA: ["LE"],
	SC: ["LE"],
	EG: ["LE"],
	GU: ["LE"],
	RO: ["LE"],
	PIN: ["LE"],
	AJ: ["LE"],
	WH: ["LE"],
	OS: ["LE"],
	EX: ["LW"],
	MI: ["LW"],
	LO: ["LW"],
	PO: ["LW"],
	CL: ["LW"],
	OA: ["LW"],
	BO: ["LW"],
	AP: ["LW"],
	BU: ["LW"],
	AL: ["LW"],
	WR: ["LW"],
	CF: ["LW"],
	SCTH: ["LW"],
	NI: ["LW"],
	KE: ["ST"],
	AG: ["ST"],
	MK: ["ST"],
	UI: ["ST"],
	CE: ["ST"],
	MR: ["ST"],
	MJ: ["ST"],
	ST: ["ST"],
	LI: ["ST"],
};

// --- URLs ---
const SOURCE_A_URL = "https://www.gotracker.ca/gotracker/mobile/proxy/web/AVL/InService/Trip2/All";
const SOURCE_B_URL = "https://www.gotracker.ca/gotracker/mobile/proxy/web/Schedule/Today/All";
const SOURCE_C_URL_TEMPLATE = (stop_id: string) =>
	`https://api.metrolinx.com/external/upe/tdp/up/departures/${stop_id}`;
const SOURCE_D_URL_TEMPLATE = (stop_id: string) =>
	`https://api.metrolinx.com/external/go/departures/stops/${stop_id}/departures?page=1&pageLimit=10`;
const SOURCE_E_URL_TEMPLATE = (code: string, stop_id: string) =>
	`https://www.gotracker.ca/gotracker/mobile/proxy/web/Messages/Signage/Rail/${code}/${stop_id}`;
const SOURCE_F_URL = "https://www.transsee.ca/fleetfind?a=gotrain";

// --- Throttles ---
const MINUTES = 60 * 1000;
const SOURCE_A_THROTTLE_MS = 1 * MINUTES;
const SOURCE_B_THROTTLE_MS = 15 * MINUTES;
const SOURCE_CD_THROTTLE_MS = 1 * MINUTES;
const SOURCE_E_THROTTLE_MS = 2 * MINUTES;
const SOURCE_F_THROTTLE_MS = 5 * MINUTES;

// --- Module State ---
let activeModels: Set<string> = new Set();
let activeIds: Set<string> = new Set();
let activeCars: Set<string> = new Set();
let activePassengerCars: Set<number> = new Set();

const SOURCE_PRIORITIES: Record<string, number> = {
	"Source D": 4,
	"Source E": 3,
	"Source C": 2,
	"Source A": 1,
	"Source B": 0,
	Propagation: 0,
	prevs: 0,
};

let prevs: {
	tripInstanceId: string;
	stopId: string;
	actualPlatform: string | null;
	scheduledPlatform: string | null;
	priority: number;
}[] = [];
let lastSourceEFetchMs: Record<string, number> = {};
let lastSourceBFetchMs = 0;
let lastSourceFFetchMs = 0;
let lastSourceAFetchMs = 0;
let lastSourceCFetchMs: Record<string, number> = {};
let lastSourceDFetchMs: Record<string, number> = {};
let vehiclePassengerCars: Record<string, number> = {};
let vehicleConsists: Record<string, string[]> = {};

export function getActiveVehicleModels(): Set<string> {
	return activeModels;
}
export function getActiveVehicleIds(): Set<string> {
	return activeIds;
}
export function getActiveCars(): Set<string> {
	return activeCars;
}
export function getActivePassengerCars(): Set<number> {
	return activePassengerCars;
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
	const priority = SOURCE_PRIORITIES[source] ?? -1;
	const currentPriority = (stopTime as any).platformPriority ?? -1;

	const newActual = platform ?? stopTime.actual_platform_code ?? scheduledPlatform ?? null;
	const newScheduled = scheduledPlatform ?? stopTime.scheduled_platform_code ?? platform ?? null;

	if (currentPriority > priority) return;

	prevs = prevs.filter((v) => !(v.tripInstanceId === stopTime.instance_id && v.stopId === stopId));
	prevs.push({
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

const ROUTE_GROUP_EAST = ["ST", "RH", "LE"];
const ROUTE_GROUP_WEST = ["MI", "LW", "KI", "BR"];

function getTripRouteGroup(ctx: CacheContext, tripId: string): string | null {
	const augmentedTrip = ctx.augmented.tripsRec.get(tripId);
	if (!augmentedTrip || !ctx.gtfs) return null;
	const routeId = augmentedTrip.route_id;
	const route = ctx.gtfs.getRoutes({ route_id: routeId })[0];
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
				.filter(Boolean)
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
			if (inst.vehicle_id) registerCarTrips(ctx, inst.trip_id, inst.vehicle_id);
			if (inst.consist) {
				for (const carId of inst.consist) registerCarTrips(ctx, inst.trip_id, carId);
			}
			return;
		}

		const merged = mergeVehicleInfo(inst, info);
		inst.vehicle_id = merged.vehicle_id;
		inst.vehicle_model = merged.vehicle_model;
		inst.passenger_cars = merged.passenger_cars ?? null;
		if (currentConsist) inst.consist = currentConsist;

		if (inst.vehicle_id) registerCarTrips(ctx, inst.trip_id, inst.vehicle_id);
		if (inst.consist) {
			for (const carId of inst.consist) registerCarTrips(ctx, inst.trip_id, carId);
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
		const groupPrev = getTripRouteGroup(ctx, prev.trip_id);
		const groupCurr = getTripRouteGroup(ctx, curr.trip_id);
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
		const groupNext = getTripRouteGroup(ctx, next.trip_id);
		const groupCurr = getTripRouteGroup(ctx, curr.trip_id);
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
		module: "GTHA",
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
	const stopTimes = gtfs
		.getStopTimes({ date: serviceDateStr, start_time: nowSecs, end_time: nowSecs + lookaheadSecs, stop_id: stopId })
		.filter((v) => isConsideredTripId(v.trip_id, gtfs))
		.map((v) => ({ stop_id: v.stop_id, trip_id: v.trip_id }))
		.concat(
			getTripUpdates(ctx).flatMap(
				(update) =>
					update.stop_time_updates
						?.filter(
							(stu) =>
								(!stopId || stu.stop_id === stopId) &&
								(stu.departure_time ?? stu.arrival_time) &&
								((stu.departure_time ?? stu.arrival_time ?? 0) - nowSecs + 86400) % 86400 <=
									lookaheadSecs,
						)
						.map((stu) => ({ stop_id: stu.stop_id, trip_id: update.trip.trip_id })) ?? [],
			),
		)
		.filter((v) => v);

	const map = new Map<string, { stop_id: string; trip_id: string }>();
	stopTimes.forEach((st) => {
		const key = `${st.stop_id}-${st.trip_id}`;
		if (!map.has(key)) map.set(key, st);
	});
	return Array.from(map.values());
}

export async function updateAllSources(ctx: CacheContext, gtfs: GTFS) {
	const timer = ctx.augmented.timer;
	timer.start("updateAllSources");

	activeIds.clear();
	activeModels.clear();
	activeCars.clear();
	activePassengerCars.clear();
	ctx.augmented.carTrips.clear();

	const now = new Date();
	const serviceDateStr = getServiceDate(now, ctx.config.timezone);

	// Re-apply previous state (prevents UI flicker if context was reset but module state remains)
	prevs.forEach((v) => {
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
			if (inst.vehicle_id) registerCarTrips(ctx, inst.trip_id, inst.vehicle_id);
			if (inst.consist) {
				for (const carId of inst.consist) registerCarTrips(ctx, inst.trip_id, carId);
			}
		}
	}
	const serviceDayStart = getServiceDayStart(serviceDateStr, ctx.config.timezone);
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
	if (nowMs - lastSourceAFetchMs >= SOURCE_A_THROTTLE_MS) {
		lastSourceAFetchMs = nowMs;
		sourceAPromise = fetch(SOURCE_A_URL, { headers: { Referer: SOURCE_E_REFERRER } })
			.then((r) => (r.ok ? r.json() : null))
			.catch(() => null);
	}

	// Source B
	let sourceBPromise: Promise<any> | null = null;
	if (nowMs - lastSourceBFetchMs >= SOURCE_B_THROTTLE_MS) {
		lastSourceBFetchMs = nowMs;
		sourceBPromise = fetch(SOURCE_B_URL, { headers: { Referer: SOURCE_E_REFERRER } })
			.then((r) => (r.ok ? r.json() : null))
			.catch(() => null);
	}

	// Source C
	const sourceCFetches = SOURCE_C_IDS.filter((stop_id) => {
		if (nowMs - (lastSourceCFetchMs[stop_id] ?? 0) < SOURCE_CD_THROTTLE_MS) return false;
		lastSourceCFetchMs[stop_id] = nowMs;
		return true;
	}).map((stop_id) => ({
		stop_id,
		promise: fetch(SOURCE_C_URL_TEMPLATE(stop_id))
			.then(async (r) => (r.ok ? ((await r.json()) as UPEDeparturesResponse) : null))
			.catch((e) => {
				logger.error(`Failed to update Source C platforms for stop ${stop_id}: ${e.message ?? e}`, {
					module: "GTHA",
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

	const sourceDStopIds = Array.from(new Set(uniqueStopTimesSourceD.map((v) => v.stop_id)));
	const sourceDFetches = sourceDStopIds
		.filter((stop_id) => {
			if (nowMs - (lastSourceDFetchMs[stop_id] ?? 0) < SOURCE_CD_THROTTLE_MS) return false;
			lastSourceDFetchMs[stop_id] = nowMs;
			return true;
		})
		.map((stop_id) => ({
			stop_id,
			promise: fetch(SOURCE_D_URL_TEMPLATE(stop_id))
				.then(async (r) => (r.ok ? ((await r.json()) as GTHADeparturesResponse) : null))
				.catch((e) => {
					logger.error(`Failed to update Source D platforms for stop ${stop_id}: ${e.message ?? e}`, {
						module: "GTHA",
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
		new Set(uniqueStopTimesSourceE.filter((v) => !SOURCE_E_EXCLUDED_STOPS.has(v.stop_id)).map((v) => v.stop_id)),
	);
	const sourceEFetches = sourceEStopIds
		.filter((stop_id) => {
			if (nowMs - (lastSourceEFetchMs[stop_id] ?? 0) < SOURCE_E_THROTTLE_MS) return false;
			lastSourceEFetchMs[stop_id] = nowMs;
			return true;
		})
		.map((stop_id) => {
			const corridor_codes = SOURCE_E_STOP_CONVERSION[stop_id] ?? [];
			return {
				stop_id,
				corridors: corridor_codes.map((code) => ({
					code,
					promise: fetch(SOURCE_E_URL_TEMPLATE(code, stop_id), { headers: { Referer: SOURCE_E_REFERRER } })
						.then((r) => (r.ok ? r.json() : null))
						.catch((e) => {
							logger.error(
								`Failed to fetch Source E for stop ${stop_id} corridor ${code}: ${e.message}`,
								{
									module: "GTHA",
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
				const instance = getAugmentedTrips(ctx, st.trip_id)[0]?.instances.find((v) => {
					if (v.serviceDate === departure.scheduledDateTime.slice(0, 10).replace(/-/g, "")) return true;
					const offset = v.stopTimes.find(
						(fst) => fst.actual_stop_id === item.stop_id,
					)?.scheduled_departure_date_offset;
					if (!offset) return false;

					const prevDate = new Date(departure.scheduledDateTime.slice(0, 10));
					prevDate.setDate(prevDate.getDate() - offset);
					return prevDate.toISOString().slice(0, 10).replace(/-/g, "") === v.serviceDate;
				});

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
					getAugmentedTrips(ctx, st.trip_id)[0]?.instances.find((v) => v.serviceDate === dateStr) ??
					getAugmentedTrips(ctx, st.trip_id)[0]?.instances[0];

				const ast = instance?.stopTimes.find((ast) => ast.actual_stop_id === item.stop_id);
				if (ast) applyPlatformUpdate(ctx, ast, item.stop_id, platform, null, "Source C", blockMap);
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
	for (const tid of uniqueStopTimesSourceE.map((v) => v.trip_id)) {
		const match = tid.match(/\d+$/);
		if (match) {
			const num = match[0];
			if (!tripNumberToIds.has(num)) tripNumberToIds.set(num, []);
			const list = tripNumberToIds.get(num)!;
			if (!list.includes(tid)) list.push(tid);
		}
	}

	if (sourceAPromise) {
		timer.start("updateAllSources:SourceA");
		await updateSourceA(ctx, tripNumberToIds, serviceDateStr, blockMap, await sourceAPromise);
		timer.stop("updateAllSources:SourceA");
	}

	if (sourceBPromise) {
		timer.start("updateAllSources:SourceB");
		await updateSourceB(ctx, tripNumberToIds, serviceDateStr, blockMap, await sourceBPromise);
		timer.stop("updateAllSources:SourceB");
	}

	timer.stop("updateAllSources");
}

export async function updateSourceB(
	ctx: CacheContext,
	tripNumberToIds: Map<string, string[]>,
	serviceDateStr: string,
	blockMap?: Map<string, any[]>,
	data?: any,
) {
	const timer = ctx.augmented.timer;
	timer.start("updateSourceB");
	try {
		if (!data) {
			const response = await fetch(SOURCE_B_URL, { headers: { Referer: SOURCE_E_REFERRER } });
			if (!response.ok) return;

			data = await response.json();
		}
		if (!data) return;

		const commitmentTrips = data.commitmentTrip as any[];

		logger.debug(`GTHA Schedule: Processing ${commitmentTrips.length} commitment trips`, {
			module: "GTHA",
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
							activeIds.add(gtStop.engineId);
							activeCars.add(gtStop.engineId);
							const vehicle_model = getModelFromId(gtStop.engineId);
							if (vehicle_model) activeModels.add(vehicle_model);

							const vehicleInfo = mergeVehicleInfo(instance, {
								vehicle_id: gtStop.engineId,
								vehicle_model,
								passenger_cars: vehiclePassengerCars[gtStop.engineId] ?? null,
								consist: vehicleConsists[gtStop.engineId] ?? null,
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
			module: "GTHA",
			function: "updateGTHASchedule",
		});
	} catch (e) {
		logger.error(`Failed to update Source B: ${(e as any).message ?? e}`, {
			module: "GTHA",
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
	const timer = ctx.augmented.timer;
	timer.start("updateSourceA");
	try {
		if (!data) {
			const response = await fetch(SOURCE_A_URL, { headers: { Referer: SOURCE_E_REFERRER } });
			if (!response.ok) return;

			data = await response.json();
		}
		if (!data) return;

		const trips = (data.trip as any[]).filter((v) => v.source !== "B");

		logger.debug(`Source A: Processing ${trips.length} active trips`, {
			module: "GTHA",
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
					activePassengerCars.add(num);
					vehiclePassengerCars[vehicleId] = num;
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
			if (passengerCars === null && vehicleId && vehiclePassengerCars[vehicleId]) {
				passengerCars = vehiclePassengerCars[vehicleId];
			}

			if (vehicleId) {
				activeIds.add(vehicleId);
				activeCars.add(vehicleId);
				const vehicle_model = getModelFromId(vehicleId);
				if (vehicle_model) activeModels.add(vehicle_model);
			}

			const tripIds = tripNumberToIds.get(tripNumber) || [];
			for (const tripId of tripIds) {
				const augmentedTrip = ctx.augmented.tripsRec.get(tripId);
				if (!augmentedTrip) continue;

				const instance = augmentedTrip.instances.find((v) => v.serviceDate === serviceDateStr);
				if (!instance) continue;

				if (vehicleId) {
					const vehicleInfo = mergeVehicleInfo(instance, {
						vehicle_id: vehicleId,
						vehicle_model: getModelFromId(vehicleId),
						passenger_cars: passengerCars,
						consist: vehicleConsists[vehicleId] ?? null,
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
					const vehicleInfo = mergeVehicleInfo(instance, {
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
			module: "GTHA",
			function: "updateGTHAAVL",
		});
	} catch (e) {
		logger.error(`Failed to update Source A: ${(e as any).message ?? e}`, {
			module: "GTHA",
			function: "updateSourceA",
		});
		console.error(e);
	}
	timer.stop("updateSourceA");
}

function processSourceEUpdates(
	stop_id: string,
	dataList: any[],
	stopTimes: { stop_id: string; trip_id: string }[],
	ctx: CacheContext,
	serviceDateStr: string,
) {
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
			const instance = getAugmentedTrips(ctx, st.trip_id)[0]?.instances.find(
				(v) => v.serviceDate === targetServiceDate,
			);

			if (!instance) continue;
			const ast = instance.stopTimes.find((f_ast) => f_ast.actual_stop_id === st.stop_id);
			if (!ast) continue;
			applyPlatformUpdate(ctx, ast, stop_id, platform, null, "Source E");

			if (trip.coachCount !== undefined) {
				instance.passenger_cars = trip.coachCount;
				if (instance.vehicle_id) vehiclePassengerCars[instance.vehicle_id] = trip.coachCount;
			} else if (instance.vehicle_id && vehiclePassengerCars[instance.vehicle_id]) {
				instance.passenger_cars = vehiclePassengerCars[instance.vehicle_id];
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
	const now = Date.now();
	if (now - lastSourceFFetchMs < SOURCE_F_THROTTLE_MS) return;
	lastSourceFFetchMs = now;

	try {
		const response = await fetch(SOURCE_F_URL);
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
			const infoRow = rows[1]
				.querySelectorAll("td")
				.slice(1)
				.map((td) => td.text.trim());

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

			vehicleConsists[vehicleNumber] = consist;
			consist.forEach((car) => activeCars.add(car));

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
			module: "GTHA",
			function: "updateSourceF",
		});
	} catch (e) {
		logger.error(`Failed to fetch Source F: ${(e as any).message ?? e}`, {
			module: "GTHA",
			function: "updateSourceF",
		});
		console.error(e);
	}
}
