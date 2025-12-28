import { CacheContext, getAugmentedTripInstance, getAugmentedTrips, getTripUpdates } from "../../cache.js";
import { GTFS, StopTime } from "qdf-gtfs";
import { GTHADeparturesResponse, UPEDeparturesResponse } from "./types.js";
import logger from "../../utils/logger.js";
import { getServiceDayStart, getServiceDate } from "../../utils/time.js";
import { isConsideredTripId } from "../../utils/considered.js";
import { getModelFromId } from "./vehicleModel.js";
import { mergeVehicleInfo } from "../../utils/vehicleModel.js";

const GO_LOOKAHEAD_SECS = 600;
const UP_LOOKAHEAD_SECS = 7200;
const GOTRACKER_REFERRER = "https://www.gotracker.ca/gotracker/web/";
const GOTRACKER_THROTTLE_MS = 2 * 60 * 1000;
const GOTRACKER_EXCLUDED_STOPS = new Set(["PA", "UN"]);

let prevs: {
	tripInstanceId: string;
	stopId: string;
	actualPlatform: string | null;
	scheduledPlatform: string | null;
}[] = [];
let lastGoTrackerFetchMs: Record<string, number> = {};
let vehiclePassengerCars: Record<string, number> = {};

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
	blockMap?: Map<string, any[]>,
) {
	const newActual = platform ?? stopTime.actual_platform_code ?? scheduledPlatform ?? null;
	const newScheduled = scheduledPlatform ?? stopTime.scheduled_platform_code ?? platform ?? null;

	const changed =
		newActual !== stopTime.actual_platform_code ||
		newScheduled !== stopTime.scheduled_platform_code ||
		!stopTime.rt_platform_code_updated;
	if (!changed) return;

	prevs = prevs.filter((v) => !(v.tripInstanceId === stopTime.instance_id && v.stopId === stopId));
	prevs.push({
		tripInstanceId: stopTime.instance_id,
		stopId,
		actualPlatform: newActual,
		scheduledPlatform: newScheduled,
	});

	stopTime.actual_platform_code = newActual;
	stopTime.scheduled_platform_code = newScheduled;
	stopTime.rt_platform_code_updated = true;

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
		applyPlatformUpdate(ctx, firstStopTime, stopId, actualPlatform, scheduledPlatform, blockMap);
	}
}

function propagateVehicleInfoToBlock(
	ctx: CacheContext,
	serviceDateStr: string,
	blockId: string | undefined | null,
	vehicleId: string | null,
	passengerCars: number | null,
	blockMap?: Map<string, any[]>,
) {
	if (!blockId) return;

	const blockTrips = blockMap
		? blockMap.get(blockId) || []
		: (ctx.augmented.serviceDateTrips.get(serviceDateStr) ?? [])
				.map((id) => ctx.augmented.tripsRec.get(id))
				.filter(Boolean)
				.flatMap((at) => at!.instances.filter((i) => i.serviceDate === serviceDateStr));

	const info = {
		vehicle_id: vehicleId,
		vehicle_model: vehicleId ? getModelFromId(vehicleId) : null,
		passenger_cars: passengerCars,
	};

	for (const inst of blockTrips) {
		if (inst.block_id !== blockId) continue;
		if (inst.vehicle_id === vehicleId && inst.passenger_cars === (passengerCars ?? null)) continue;

		const merged = mergeVehicleInfo(inst, info);
		inst.vehicle_id = merged.vehicle_id;
		inst.vehicle_model = merged.vehicle_model;
		inst.passenger_cars = merged.passenger_cars ?? null;
	}
}

function formatTrack(track: string | null | undefined): string | null {
	if (!track) return null;
	track = track.trim();
	if (track === "-" || track === "") return null;
	if (track.length === 4 && /^\d+$/.test(track)) {
		const p1 = Number.parseInt(track.slice(0, 2), 10);
		const p2 = Number.parseInt(track.slice(2, 4), 10);
		return `${p1} & ${p2}`;
	} else track = track.replace(/^0+/, "");
	return track;
}

const gotrackerMobile_stop_conversion: Record<string, string[]> = {
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

export async function updateGTHAPlatforms(ctx: CacheContext, gtfs: GTFS) {
	const now = new Date();
	const serviceDateStr = getServiceDate(now, ctx.config.timezone);
	const serviceDayStart = getServiceDayStart(serviceDateStr, ctx.config.timezone);
	const nowSecs = Math.floor(now.getTime() / 1000 - serviceDayStart);

	const UP_ids = ["UN", "PA", "BL", "MD", "WE"];

	const stopTimes10m = gtfs
		.getStopTimes({ date: serviceDateStr, start_time: nowSecs, end_time: nowSecs + GO_LOOKAHEAD_SECS })
		.filter((v) => isConsideredTripId(v.trip_id, gtfs))
		.map((v) => ({ stop_id: v.stop_id, trip_id: v.trip_id }))
		.concat(
			getTripUpdates(ctx).flatMap(
				(update) =>
					update.stop_time_updates
						?.filter(
							(stu) =>
								(stu.departure_time ?? stu.arrival_time) &&
								((stu.departure_time ?? stu.arrival_time ?? 0) - nowSecs + 86400) % 86400 <=
								GO_LOOKAHEAD_SECS,
						)
						.map((stu) => ({ stop_id: stu.stop_id, trip_id: update.trip.trip_id })) ?? [],
			),
		)
		.filter((v) => v);

	const stopTimes10mMap = new Map<string, { stop_id: string; trip_id: string }>();
	stopTimes10m.forEach((st) => stopTimes10mMap.set(`${st.stop_id}-${st.trip_id}`, st));
	const uniqueStopTimes10m = Array.from(stopTimes10mMap.values());

	const stopTimes2h = UP_ids.flatMap((stop_id) =>
		gtfs.getStopTimes({
			date: serviceDateStr,
			start_time: nowSecs,
			end_time: nowSecs + UP_LOOKAHEAD_SECS,
			stop_id,
		}),
	)
		.filter((v) => isConsideredTripId(v.trip_id, gtfs))
		.map((v) => ({ stop_id: v.stop_id, trip_id: v.trip_id }))
		.concat(
			getTripUpdates(ctx).flatMap(
				(update) =>
					update.stop_time_updates
						?.filter(
							(stu) =>
								(stu.departure_time ?? stu.arrival_time) &&
								((stu.departure_time ?? stu.arrival_time ?? 0) - nowSecs + 86400) % 86400 <=
								UP_LOOKAHEAD_SECS,
						)
						.map((stu) => ({ stop_id: stu.stop_id, trip_id: update.trip.trip_id })) ?? [],
			),
		)
		.filter((v) => v);

	const stopTimes2hMap = new Map<string, { stop_id: string; trip_id: string }>();
	stopTimes2h.forEach((st) => stopTimes2hMap.set(`${st.stop_id}-${st.trip_id}`, st));
	const uniqueStopTimes2h = Array.from(stopTimes2hMap.values());

	const stopTimesGoTracker = gtfs
		.getStopTimes({ date: serviceDateStr, start_time: 0, end_time: 86400 })
		.filter((v) => isConsideredTripId(v.trip_id, gtfs))
		.map((v) => ({ stop_id: v.stop_id, trip_id: v.trip_id }));

	const stopTimesGoTrackerMap = new Map<string, { stop_id: string; trip_id: string }>();
	stopTimesGoTracker.forEach((st) => stopTimesGoTrackerMap.set(`${st.stop_id}-${st.trip_id}`, st));
	const uniqueStopTimesGoTracker = Array.from(stopTimesGoTrackerMap.values());

	const goStopIds = new Set(uniqueStopTimes10m.map((v) => v.stop_id));
	const goTrackerStopIds = new Set(
		uniqueStopTimesGoTracker.filter((v) => !GOTRACKER_EXCLUDED_STOPS.has(v.stop_id)).map((v) => v.stop_id),
	);

	const tripNumberToIds = new Map<string, string[]>();
	for (const tid of uniqueStopTimesGoTracker.map((v) => v.trip_id)) {
		const match = tid.match(/\d+$/);
		if (match) {
			const num = match[0];
			if (!tripNumberToIds.has(num)) tripNumberToIds.set(num, []);
			const list = tripNumberToIds.get(num)!;
			if (!list.includes(tid)) list.push(tid);
		}
	}

	logger.debug(
		`Updating GTHA platforms (GO ${goStopIds.size} | UPE ${UP_ids.length} | GoTracker ${goTrackerStopIds.size})`,
		{
			module: "region-specific/GTHA/realtime",
			function: "updateGTHAPlatforms",
		},
	);

	prevs.forEach((v) => {
		let ti = getAugmentedTripInstance(ctx, v.tripInstanceId);
		if (!ti) return;
		let st = ti.stopTimes.find((st) => (st.actual_stop_id ?? st.scheduled_stop_id) === v.stopId);
		if (!st) return;

		st.actual_platform_code = v.actualPlatform;
		st.scheduled_platform_code = v.scheduledPlatform;
		st.rt_platform_code_updated = true;
	});

	await Promise.all([
		...Array.from(goStopIds).map(async (stop_id) => {
			try {
				const url = `https://api.metrolinx.com/external/go/departures/stops/${stop_id}/departures?page=1&pageLimit=10`;
				const response = await fetch(url);
				if (!response.ok) return;

				const data: GTHADeparturesResponse = await response.json();

				for (const departure of data.trainDepartures.items) {
					const tripNumber = departure.tripNumber;
					let platform = departure.platform.replaceAll("-", "").trim() === "" ? null : departure.platform;
					let scheduledPlatform =
						departure.scheduledPlatform?.replaceAll("-", "")?.trim() === ""
							? null
							: departure.scheduledPlatform;

					if (!platform && scheduledPlatform) platform = scheduledPlatform;
					if (!scheduledPlatform && platform) scheduledPlatform = platform;

					for (const st of uniqueStopTimes10m) {
						if (!st.trip_id.endsWith(tripNumber)) continue;
						const augmentedStopTimes = getAugmentedTrips(ctx, st.trip_id)[0]?.instances.find((v) => {
							if (v.serviceDate === departure.scheduledDateTime.slice(0, 10).replace(/-/g, ""))
								return true;
							let offset = v.stopTimes.find(
								(st) => st.actual_stop_id === stop_id,
							)?.scheduled_departure_date_offset;

							if (!offset) return false;

							let prevDate = new Date(
								Date.UTC(
									Number.parseInt(departure.scheduledDateTime.slice(0, 4)),
									Number.parseInt(departure.scheduledDateTime.slice(5, 7)) - 1,
									Number.parseInt(departure.scheduledDateTime.slice(8, 10)),
								),
							);
							prevDate.setDate(prevDate.getDate() - offset);

							if (prevDate.toUTCString().slice(0, 10).replaceAll(/-/g, "") === v.serviceDate) return true;
							return false;
						})?.stopTimes;

						if (augmentedStopTimes) {
							const ast = augmentedStopTimes.find((ast) => ast.actual_stop_id === st.stop_id);

							if (ast?.actual_stop_id === stop_id) {
								if (platform !== null || scheduledPlatform !== null) {
									applyPlatformUpdate(ctx, ast, stop_id, platform, scheduledPlatform);
								}
							}
						}
					}
				}
			} catch (e) {
				logger.error(`Failed to update GO platforms for stop ${stop_id}`, {
					error: e,
					module: "region-specific/GTHA/realtime",
					function: "updateGTHAPlatforms",
				});

				console.error(e);
			}
		}),
		...UP_ids.map(async (stop_id) => {
			try {
				const upeUrl = `https://api.metrolinx.com/external/upe/tdp/up/departures/${stop_id}`;
				const upeResponse = await fetch(upeUrl);
				if (upeResponse.ok) {
					const upeData: UPEDeparturesResponse = await upeResponse.json();
					const dateStr = upeData.metadata.timeStamp.slice(0, 10).replace(/-/g, "");

					for (const departure of upeData.departures) {
						const tripNumber = departure.tripNumber;
						let platform = departure.platform.replaceAll("-", "").trim() === "" ? null : departure.platform;

						for (const st of uniqueStopTimes2h) {
							if (!st.trip_id.endsWith(tripNumber)) continue;
							const augmentedStopTimes =
								getAugmentedTrips(ctx, st.trip_id)[0]?.instances.find((v) => v.serviceDate === dateStr)
									?.stopTimes ?? getAugmentedTrips(ctx, st.trip_id)[0]?.instances[0]?.stopTimes;

							if (augmentedStopTimes) {
								const ast = augmentedStopTimes.find((ast) => ast.actual_stop_id === st.stop_id);

								if (ast?.actual_stop_id === stop_id && platform !== null)
									applyPlatformUpdate(ctx, ast, stop_id, platform, null);
							}
						}
					}
				}
			} catch (e) {
				logger.error(`Failed to update UPE platforms for stop ${stop_id}`, {
					error: e,
					module: "region-specific/GTHA/realtime",
					function: "updateGTHAPlatforms",
				});

				console.error(e);
			}
		}),
		...Array.from(goTrackerStopIds).map(async (stop_id) => {
			try {
				await maybeUpdatePlatformsFromGoTracker(stop_id, uniqueStopTimesGoTracker, ctx, serviceDateStr);
			} catch (e) {
				logger.error(`Failed to update GoTracker platforms for stop ${stop_id}`, {
					error: e,
					module: "region-specific/GTHA/realtime",
					function: "updateGTHAPlatforms",
				});

				console.error(e);
			}
		}),
	]);
	logger.debug(`Completed updating GTHA platforms`, {
		module: "region-specific/GTHA/realtime",
		function: "updateGTHAPlatforms",
	});

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

	await updateGTHAAVL(ctx, tripNumberToIds, serviceDateStr, blockMap);
	await updateGTHASchedule(ctx, tripNumberToIds, serviceDateStr, blockMap);
}

export async function updateGTHASchedule(
	ctx: CacheContext,
	tripNumberToIds: Map<string, string[]>,
	serviceDateStr: string,
	blockMap?: Map<string, any[]>,
) {
	try {
		const scheduleUrl = "https://www.gotracker.ca/gotracker/mobile/proxy/web/Schedule/Today/All";
		const response = await fetch(scheduleUrl, { headers: { Referer: GOTRACKER_REFERRER } });
		if (!response.ok) return;

		const data = await response.json();
		const commitmentTrips = data.commitmentTrip as any[];

		logger.debug(`GTHA Schedule: Processing ${commitmentTrips.length} commitment trips`, {
			module: "region-specific/GTHA/realtime",
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
								blockMap,
							);
							updateCount++;
						}

						if (gtStop.engineId && gtStop.engineId !== "-" && gtStop.engineId !== "") {
							const vehicleInfo = mergeVehicleInfo(instance, {
								vehicle_id: gtStop.engineId,
								vehicle_model: getModelFromId(gtStop.engineId),
								passenger_cars: vehiclePassengerCars[gtStop.engineId] ?? null,
							});
							instance.vehicle_id = vehicleInfo.vehicle_id;
							instance.vehicle_model = vehicleInfo.vehicle_model;
							instance.passenger_cars = vehicleInfo.passenger_cars ?? null;

							propagateVehicleInfoToBlock(
								ctx,
								serviceDateStr,
								instance.block_id,
								instance.vehicle_id,
								instance.passenger_cars,
								blockMap,
							);
						}
					}
				}
			}
		}

		logger.debug(`GTHA Schedule: Completed with ${updateCount} platform updates`, {
			module: "region-specific/GTHA/realtime",
			function: "updateGTHASchedule",
		});
	} catch (e) {
		logger.error("Failed to update GTHA Schedule", {
			error: e,
			module: "region-specific/GTHA/realtime",
			function: "updateGTHASchedule",
		});
	}
}

export async function updateGTHAAVL(
	ctx: CacheContext,
	tripNumberToIds: Map<string, string[]>,
	serviceDateStr: string,
	blockMap?: Map<string, any[]>,
) {
	try {
		const avlUrl = "https://www.gotracker.ca/gotracker/mobile/proxy/web/AVL/InService/Trip2/All";
		const response = await fetch(avlUrl, { headers: { Referer: GOTRACKER_REFERRER } });
		if (!response.ok) return;

		const data = await response.json();
		const trips = (data.trip as any[]).filter((v) => v.source !== "B");

		logger.debug(`GTHA AVL: Processing ${trips.length} active trips`, {
			module: "region-specific/GTHA/realtime",
			function: "updateGTHAAVL",
		});

		// Pass 1: Update persistent cache from current AVL data
		for (const trip of trips) {
			const vehicleId = trip.vehicleNumber;
			if (!vehicleId || vehicleId === "-") continue;

			const vehicleType = trip.vehicleType ?? "";
			if (vehicleType.startsWith("L")) {
				const num = Number.parseInt(vehicleType.slice(1), 10);
				if (!Number.isNaN(num)) {
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
					});
					instance.vehicle_id = vehicleInfo.vehicle_id;
					instance.vehicle_model = vehicleInfo.vehicle_model;
					instance.passenger_cars = vehicleInfo.passenger_cars ?? null;

					propagateVehicleInfoToBlock(
						ctx,
						serviceDateStr,
						instance.block_id,
						instance.vehicle_id,
						instance.passenger_cars,
						blockMap,
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
					);
				}
				updateCount++;
			}
		}

		logger.debug(`GTHA AVL: Completed vehicle updates for ${updateCount} trip instances`, {
			module: "region-specific/GTHA/realtime",
			function: "updateGTHAAVL",
		});
	} catch (e) {
		logger.error("Failed to update GTHA AVL", {
			error: e,
			module: "region-specific/GTHA/realtime",
			function: "updateGTHAAVL",
		});
	}
}

async function maybeUpdatePlatformsFromGoTracker(
	stop_id: string,
	stopTimes: { stop_id: string; trip_id: string }[],
	ctx: CacheContext,
	serviceDateStr: string,
) {
	if (GOTRACKER_EXCLUDED_STOPS.has(stop_id)) return;

	const nowMs = Date.now();
	if (nowMs - (lastGoTrackerFetchMs[stop_id] ?? 0) < GOTRACKER_THROTTLE_MS) return;
	lastGoTrackerFetchMs[stop_id] = nowMs;

	const corridor_codes = gotrackerMobile_stop_conversion[stop_id] ?? [];

	let tripMessages: any[] = [];

	for (const corridor_code of corridor_codes) {
		const goTrackerUrl = `https://www.gotracker.ca/gotracker/mobile/proxy/web/Messages/Signage/Rail/${corridor_code}/${stop_id}`;

		try {
			const response = await fetch(goTrackerUrl, { headers: { Referer: GOTRACKER_REFERRER } });
			if (!response.ok) continue;

			const data = await response.json();
			if (!data?.directions) continue;
			for (const direction of data.directions) {
				if (direction.tripMessages) {
					tripMessages = tripMessages.concat(direction.tripMessages);
				}
			}
		} catch (e) {
			logger.error(`Failed to fetch GoTracker for stop ${stop_id} corridor ${corridor_code}`, {
				error: e,
				module: "region-specific/GTHA/realtime",
				function: "maybeUpdatePlatformsFromGoTracker",
			});
		}
	}

	for (const trip of tripMessages) {
		if (!trip?.tripName) continue;

		const platform = trip.track?.toString()?.trim();
		if (!platform) continue;

		const targetServiceDate = trip.scheduled?.slice(0, 10).replace(/-/g, "") ?? serviceDateStr;

		for (const st of stopTimes) {
			if (st.stop_id !== stop_id) continue;
			if (!st.trip_id.endsWith(trip.tripName)) continue;

			const instance = getAugmentedTrips(ctx, st.trip_id)[0]?.instances.find(
				(v) => v.serviceDate === targetServiceDate,
			);

			if (!instance) continue;
			const ast = instance.stopTimes.find((ast) => ast.actual_stop_id === st.stop_id);
			if (!ast) continue;
			applyPlatformUpdate(ctx, ast, stop_id, platform, null);

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
			);

			if (trip.scheduledCoachCount !== undefined) instance.scheduled_passenger_cars = trip.scheduledCoachCount;
		}
	}
}
