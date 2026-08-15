import * as qdf from "qdf-gtfs";
import { AugmentedStop } from "./augmentedStop.js";
import * as cache from "../cache/index.js";
import { findPassingStopTimes } from "./SRT.js";
import { interpolateTimes as wasmInterpolateTimes } from "../../build/release.js";
import { getPlatformData as loadPlatformData, seqPlatformDefinitionsPresent } from "./platformData.js";
import type { PlatformData, PlatformDefinition } from "./platformData.js";
import { ServiceCapacity } from "./serviceCapacity.js";
import { getServiceDayStart } from "./time.js";
import { getFeedTimeZone } from "../config.js";
import { Timer } from "./timer.js";
import { addDaysToDateString as wasmAddDaysToDateString, calculateDelayClassWasm } from "../../build/release.js";
import { getSeqState } from "../plugins/seq-state.js";

export type BoardingLocationKind = "track" | "platform" | "gate" | "door" | "letter";

/** A provider-supplied boarding location whose meaning is more specific than a generic platform code. */
export type BoardingLocation = {
	kind: BoardingLocationKind;
	value: string;
	source: string;
	observed_at: string;
	confidence?: "confirmed" | "reported" | "inferred";
	expires_at?: string;
};

export type AugmentedStopTime = {
	_stopTime: qdf.StopTime | null;
	feed_id: string;
	trip_id: string;
	passing: boolean;
	pickup_type: qdf.PickupType;
	drop_off_type: qdf.DropOffType;

	instance_id: string;
	service_date: string;
	schedule_relationship: qdf.TripScheduleRelationship;
	service_capacity: ServiceCapacity;

	actual_exit_side: "left" | "right" | "both" | null;
	scheduled_exit_side: "left" | "right" | "both" | null;

	actual_arrival_time: number | null;
	actual_departure_time: number | null;
	actual_stop_id: string | null;
	actual_parent_station_id: string | null;
	actual_platform_code: string | null;
	actual_arrival_boarding_locations: BoardingLocation[];
	actual_departure_boarding_locations: BoardingLocation[];

	rt_stop_updated: boolean;
	rt_parent_station_updated: boolean;
	rt_platform_code_updated: boolean;
	rt_arrival_updated: boolean;
	rt_departure_updated: boolean;

	scheduled_arrival_time: number | null;
	scheduled_departure_time: number | null;
	scheduled_stop_id: string | null;
	scheduled_parent_station_id: string | null;
	scheduled_platform_code: string | null;

	scheduled_arrival_dates: string[];
	actual_arrival_dates: string[];
	scheduled_arrival_date_offset: number;
	actual_arrival_date_offset: number;

	scheduled_departure_dates: string[];
	actual_departure_dates: string[];
	scheduled_departure_date_offset: number;
	actual_departure_date_offset: number;
} & (
	| {
			realtime: true;
			realtime_info: {
				delay_secs: number;
				delay_string: string;
				delay_class: "on-time" | "scheduled" | "late" | "very-late" | "early";
				schedule_relationship: qdf.StopTimeScheduleRelationship;
				propagated: boolean;
				rt_start_date: string | null;
			};
	  }
	| {
			realtime: false;
			realtime_info: null;
	  }
) & {
		actual_stop?: AugmentedStop | null;
		actual_parent_station?: AugmentedStop | null;
		scheduled_stop?: AugmentedStop | null;
		scheduled_parent_station?: AugmentedStop | null;
	};

type IntermediateAST = Omit<AugmentedStopTime, "actual_exit_side" | "scheduled_exit_side">;

function attachStopReferences(
	ast: AugmentedStopTime,
	refs: {
		actualStop?: AugmentedStop | null;
		actualParent?: AugmentedStop | null;
		scheduledStop?: AugmentedStop | null;
		scheduledParent?: AugmentedStop | null;
	},
): void {
	ast.actual_stop = refs.actualStop ?? null;
	ast.actual_parent_station = refs.actualParent ?? null;
	ast.scheduled_stop = refs.scheduledStop ?? null;
	ast.scheduled_parent_station = refs.scheduledParent ?? null;
}

function calculateDelayClass(delaySecs: number) {
	const info = calculateDelayClassWasm(delaySecs);
	return { str: info.str, cls: info.cls as "on-time" | "late" | "very-late" | "early" };
}

function addDaysToDateString(dateStr: string, daysToAdd: number, ctx: cache.CacheContext): string {
	if (daysToAdd === 0) return dateStr;
	const key = `${dateStr}|${daysToAdd}`;
	let cached = ctx.runtimeState.dateOffsets.get(key);
	if (cached !== undefined) return cached;
	const result = wasmAddDaysToDateString(dateStr, daysToAdd);
	ctx.runtimeState.dateOffsets.set(key, result);
	return result;
}

export function getServiceDateArray(date: string, ctx: cache.CacheContext): string[] {
	let cached = ctx.runtimeState.serviceDateArrays.get(date);
	if (!cached) {
		cached = [date];
		ctx.runtimeState.serviceDateArrays.set(date, cached);
	}
	return cached;
}

export function clearAugmentedStopTimeCaches(ctx: cache.CacheContext): void {
	ctx.runtimeState.dateOffsets.clear();
	ctx.runtimeState.serviceDateArrays.clear();
}

function resolveExitSide(
	stops: IntermediateAST[],
	index: number,
	platformDataList: PlatformDefinition[],
	platformCode: number,
): "left" | "right" | "both" | null {
	const platform = platformDataList?.find((v) => v.platform_code === platformCode);
	if (!platform) return null;

	const prevId = index > 0 ? (stops[index - 1].actual_parent_station_id ?? stops[index - 1].actual_stop_id) : "";
	const nextId =
		index < stops.length - 1 ? (stops[index + 1].actual_parent_station_id ?? stops[index + 1].actual_stop_id) : "";

	const matchesNext = nextId ? platform.next.includes(nextId) : false;
	const matchesPrev = prevId ? platform.from.includes(prevId) : false;

	const swap = { left: "right", right: "left", both: "both" } as const;

	if (matchesNext || matchesPrev) {
		return platform.exitSide;
	}
	return swap[platform.exitSide as keyof typeof swap];
}

function assignPlatformSides(st: IntermediateAST[], platformDataMap: PlatformData): AugmentedStopTime[] {
	const getPlatformData = (stopId: string | null | undefined) => {
		if (!stopId) return null;
		const data = platformDataMap[stopId];
		return Array.isArray(data) ? data : null;
	};

	let prevActualTrack = "";
	let prevScheduledTrack = "";

	let pathBuffer: AugmentedStopTime[] = [];
	let candidatePathB: AugmentedStopTime[] = [];
	let candidatePathA: AugmentedStopTime[] = [];
	let candidatePathS: AugmentedStopTime[] = [];

	for (let i = 0; i < st.length; i++) {
		const item = st[i];
		if (item.realtime && item.realtime_info?.schedule_relationship === qdf.StopTimeScheduleRelationship.SKIPPED) {
			const refs = {
				actualStop: item.actual_stop ?? null,
				actualParent: item.actual_parent_station ?? null,
				scheduledStop: item.scheduled_stop ?? null,
				scheduledParent: item.scheduled_parent_station ?? null,
			};
			const skippedWithSides = {
				...item,
				actual_exit_side: null,
				scheduled_exit_side: null,
			} as AugmentedStopTime;
			attachStopReferences(skippedWithSides, refs);
			pathBuffer.push(skippedWithSides);
			continue;
		}

		const actId = item.actual_parent_station_id ?? item.actual_stop_id;
		const schId = item.scheduled_parent_station_id ?? item.scheduled_stop_id;

		const actData = getPlatformData(actId);
		const schData = getPlatformData(schId);

		let actPlat: PlatformDefinition | null = null;
		let schPlat: PlatformDefinition | null = null;

		if (item.passing) {
			actPlat = actData?.find((v) => v.trackCode === prevActualTrack) ?? null;
			schPlat = schData?.find((v) => v.trackCode === prevScheduledTrack) ?? null;
			if (!actPlat) prevActualTrack = "";
			if (!schPlat) prevScheduledTrack = "";
		} else {
			actPlat = actData?.find((v) => v.platform_code === parseInt(item.actual_platform_code ?? "0")) ?? null;
			schPlat = schData?.find((v) => v.platform_code === parseInt(item.scheduled_platform_code ?? "0")) ?? null;
		}

		if (actPlat?.trackCode === prevActualTrack && schPlat?.trackCode === prevScheduledTrack) {
			pathBuffer = candidatePathB.slice();
		} else if (actPlat?.trackCode === prevActualTrack) {
			pathBuffer = candidatePathA.slice();
		} else if (schPlat?.trackCode === prevScheduledTrack) {
			pathBuffer = candidatePathS.slice();
		}

		let actSide: "left" | "right" | "both" | null = null;
		let schSide: "left" | "right" | "both" | null = null;

		if (!item.passing) {
			if (actPlat) actSide = resolveExitSide(st, i, actData ?? [], actPlat.platform_code);
			if (schPlat) schSide = resolveExitSide(st, i, schData ?? [], schPlat.platform_code);
		}

		const refs = {
			actualStop: item.actual_stop ?? null,
			actualParent: item.actual_parent_station ?? null,
			scheduledStop: item.scheduled_stop ?? null,
			scheduledParent: item.scheduled_parent_station ?? null,
		};
		const newEntry: AugmentedStopTime = {
			...item,
			actual_exit_side: actSide,
			scheduled_exit_side: schSide,
			actual_platform_code: actPlat?.platform_code?.toString() ?? item.actual_platform_code,
			scheduled_platform_code: schPlat?.platform_code?.toString() ?? item.scheduled_platform_code,
		} as AugmentedStopTime;
		attachStopReferences(newEntry, refs);

		pathBuffer.push(newEntry);
		candidatePathB = pathBuffer.slice();
		candidatePathA = pathBuffer.slice();
		candidatePathS = pathBuffer.slice();

		prevActualTrack = actPlat?.trackCode ?? "";
		prevScheduledTrack = schPlat?.trackCode ?? "";
	}

	return pathBuffer;
}

export function augmentStopTimes(
	staticStopTimes: qdf.StopTime[] | null,
	instanceContext: {
		serviceDate: string;
		tripUpdate: qdf.RealtimeTripUpdate | null;
		scheduleRelationship: qdf.TripScheduleRelationship;
	},
	ctx: cache.CacheContext,
): AugmentedStopTime[] {
	ctx.augmented.timer.start("augmentStopTimes");
	const { serviceDate, tripUpdate, scheduleRelationship } = instanceContext;
	const tripId = tripUpdate?.trip.trip_id ?? staticStopTimes?.[0]?.trip_id ?? "";
	const feedId = tripUpdate?.feed_id ?? staticStopTimes?.[0]?.feed_id;
	if (!feedId) throw new Error(`Cannot augment stop times for trip '${tripId}' without feed identity`);

	const stopTimeUpdates = tripUpdate?.stop_time_updates ?? [];

	// Build O(1) lookup maps for realtime updates so the per-stop loop below avoids
	// repeated linear scans of stopTimeUpdates.
	const rtBySeq = new Map<number, qdf.RealtimeStopTimeUpdate>();
	const rtByStopId = new Map<string, qdf.RealtimeStopTimeUpdate>();
	for (const rt of stopTimeUpdates) {
		if (rt.stop_sequence != null) {
			rtBySeq.set(rt.stop_sequence, rt);
		} else if (rt.stop_id) {
			rtByStopId.set(rt.stop_id, rt);
		}
	}

	const sequenceMap = new Map<number, { static?: qdf.StopTime; rt?: qdf.RealtimeStopTimeUpdate }>();

	ctx.augmented.timer.start("augmentStopTimes:mergeStaticAndRealtime");
	if (staticStopTimes) {
		for (const st of staticStopTimes) {
			const seq = st.stop_sequence;
			if (!sequenceMap.has(seq)) sequenceMap.set(seq, {});
			sequenceMap.get(seq)!.static = st;
		}
	}

	for (const rt of stopTimeUpdates) {
		const seq = rt.stop_sequence;
		if (seq !== undefined && seq !== null) {
			if (!sequenceMap.has(seq)) sequenceMap.set(seq, {});
			sequenceMap.get(seq)!.rt = rt;
		}
	}
	ctx.augmented.timer.stop("augmentStopTimes:mergeStaticAndRealtime");

	const sortedSequences = Array.from(sequenceMap.keys()).sort((a, b) => a - b);

	type MergedStop = qdf.StopTime & {
		_rtUpdate?: qdf.RealtimeStopTimeUpdate;
		_isSkipped?: boolean;
	};

	const mergedList: MergedStop[] = [];

	const timezone = getFeedTimeZone(ctx.config, feedId);
	const serviceDayStartKey = `${timezone}\0${serviceDate}`;
	let serviceDayStart = ctx.runtimeState.serviceDayStarts.get(serviceDayStartKey);
	if (serviceDayStart === undefined) {
		serviceDayStart = getServiceDayStart(serviceDate, timezone);
		ctx.runtimeState.serviceDayStarts.set(serviceDayStartKey, serviceDayStart);
	}

	ctx.augmented.timer.start("augmentStopTimes:buildMergedList");
	for (const seq of sortedSequences) {
		const entry = sequenceMap.get(seq)!;
		const s = entry.static;
		const r = entry.rt;

		const isSkipped = r?.schedule_relationship === qdf.StopTimeScheduleRelationship.SKIPPED;

		let stopId = s?.stop_id ?? r?.stop_id ?? "";
		let arr = s?.arrival_time ?? 0;
		let dep = s?.departure_time ?? 0;

		if (!s && r) {
			if (r.arrival_time) {
				arr = Math.floor(Number(r.arrival_time) - serviceDayStart);
				if (r.arrival_delay != null) arr -= r.arrival_delay;
			}
			if (r.departure_time) {
				dep = Math.floor(Number(r.departure_time) - serviceDayStart);
				if (r.departure_delay != null) dep -= r.departure_delay;
			}
			if (arr === 0 && dep !== 0) arr = dep;
			if (dep === 0 && arr !== 0) dep = arr;
		}

		mergedList.push({
			feed_id: feedId,
			trip_id: tripId,
			stop_sequence: seq,
			stop_id: stopId,
			arrival_time: arr,
			departure_time: dep,
			stop_headsign: s?.stop_headsign ?? "",
			pickup_type: s?.pickup_type ?? 0,
			drop_off_type: s?.drop_off_type ?? 0,
			shape_dist_traveled: s?.shape_dist_traveled ?? 0,
			timepoint: s?.timepoint ?? 1,
			continuous_pickup: 0,
			continuous_drop_off: 0,
			_rtUpdate: r,
			_isSkipped: isSkipped,
		});
	}
	ctx.augmented.timer.stop("augmentStopTimes:buildMergedList");

	const activeStops = mergedList.filter((s) => !s._isSkipped);
	const interpolatedActiveStops = findPassingStopTimes(activeStops, ctx);
	const finalStops: IntermediateAST[] = [];

	const firstValid = interpolatedActiveStops[0];
	const initialScheduledArr = firstValid?.arrival_time ?? 0;
	const initialScheduledDep = firstValid?.departure_time ?? 0;
	const initialActualArr = initialScheduledArr;
	const initialActualDep = initialScheduledDep;

	const dateOffsets = {
		schedArr: Math.floor(initialScheduledArr / 86400),
		schedDep: Math.floor(initialScheduledDep / 86400),
		actArr: Math.floor(initialActualArr / 86400),
		actDep: Math.floor(initialActualDep / 86400),
	};

	let lastDelay = 0;
	const propagateOnTime = scheduleRelationship === qdf.TripScheduleRelationship.SCHEDULED && !!tripUpdate;

	/** Raw GTFS timeline seconds (may exceed 86400); used to re-interpolate passing rows against actual segment anchors. */
	let lastNonPassingActDepRaw: number | null = null;
	let pendingPassingRows: AugmentedStopTime[] = [];
	let pendingEmus: number[] | null = null;

	let currentSequence = -1;

	ctx.augmented.timer.start("augmentStopTimes:processStops");
	for (const stopTime of interpolatedActiveStops) {
		const seq = stopTime.stop_sequence;
		const isPassing = Boolean((stopTime as qdf.StopTime & { _passing?: boolean })._passing);
		// Synthetic topology rows retain the feed that owns the physical station.
		const stopFeedId = isPassing ? stopTime.feed_id : feedId;

		const prevWholeSeq = Math.floor(currentSequence);
		const currWholeSeq = Math.floor(seq);

		for (let s = prevWholeSeq + 1; s < currWholeSeq; s++) {
			const missed = sequenceMap.get(s);
			if (missed && missed.rt?.schedule_relationship === qdf.StopTimeScheduleRelationship.SKIPPED) {
				const originalMergeItem = mergedList.find((m) => m.stop_sequence === s);
				if (originalMergeItem) {
					const scheduledStop = cache.getAugmentedStops(ctx, {
						feedId,
						localId: originalMergeItem.stop_id,
					})[0];
					const scheduledParent = scheduledStop?.parent_stop_id
						? cache.getAugmentedStops(ctx, { feedId, localId: scheduledStop.parent_stop_id })[0]
						: null;
					const skipped: AugmentedStopTime = {
						_stopTime: originalMergeItem,
						feed_id: feedId,
						trip_id: tripId,
						passing: false,
						pickup_type: originalMergeItem.pickup_type,
						drop_off_type: originalMergeItem.drop_off_type,
						instance_id: "",
						service_date: "",
						schedule_relationship: qdf.TripScheduleRelationship.SCHEDULED,
						service_capacity: ServiceCapacity.NOT_CALCULATED,
						actual_exit_side: null,
						scheduled_exit_side: null,
						actual_arrival_time: null,
						actual_departure_time: null,
						actual_stop_id: scheduledStop?.stop_id ?? null,
						actual_parent_station_id: scheduledParent?.stop_id ?? scheduledStop?.parent_stop_id ?? null,
						actual_platform_code: null,
						actual_arrival_boarding_locations: [],
						actual_departure_boarding_locations: [],
						rt_stop_updated: true,
						rt_parent_station_updated: false,
						rt_platform_code_updated: false,
						rt_arrival_updated: false,
						rt_departure_updated: false,
						scheduled_arrival_time: originalMergeItem.arrival_time,
						scheduled_departure_time: originalMergeItem.departure_time,
						scheduled_stop_id: scheduledStop?.stop_id ?? null,
						scheduled_parent_station_id: scheduledParent?.stop_id ?? scheduledStop?.parent_stop_id ?? null,
						scheduled_platform_code: scheduledStop?.platform_code ?? null,
						realtime: true,
						realtime_info: {
							delay_secs: 0,
							delay_string: "Skipped",
							delay_class: "scheduled",
							schedule_relationship: qdf.StopTimeScheduleRelationship.SKIPPED,
							propagated: false,
							rt_start_date: tripUpdate?.trip.start_date ?? serviceDate,
						},
						scheduled_arrival_dates: [],
						actual_arrival_dates: [],
						scheduled_arrival_date_offset: 0,
						actual_arrival_date_offset: 0,
						scheduled_departure_dates: [],
						actual_departure_dates: [],
						scheduled_departure_date_offset: 0,
						actual_departure_date_offset: 0,
					};
					attachStopReferences(skipped, {
						actualStop: scheduledStop,
						actualParent: scheduledParent,
						scheduledStop: scheduledStop,
						scheduledParent: scheduledParent,
					});
					finalStops.push(skipped);
				}
			}
		}
		currentSequence = seq;

		const stopId = stopTime.stop_id;
		const rtUpdate = isPassing ? undefined : (rtBySeq.get(seq) ?? rtByStopId.get(stopId));

		const scheduledStop = cache.getAugmentedStops(ctx, { feedId: stopFeedId, localId: stopId })[0];
		const scheduledParentId = scheduledStop?.parent_stop_id ?? scheduledStop?.parent_station ?? null;
		const scheduledParent = scheduledParentId
			? cache.getAugmentedStops(ctx, { feedId: stopFeedId, localId: scheduledParentId })[0]
			: null;

		const schedArr = stopTime.arrival_time;
		const schedDep = stopTime.departure_time;
		let actArr = schedArr;
		let actDep = schedDep;

		let delaySecs = lastDelay;
		let propagated = false;
		let currentScheduleRelationship = rtUpdate?.schedule_relationship ?? qdf.StopTimeScheduleRelationship.SCHEDULED;

		let rtFlags = { stop: false, parent: false, platform: false, arr: false, dep: false };
		let platformCode: string | null = null;
		let actualStop = scheduledStop;
		let actualParent = scheduledParent;

		if (rtUpdate) {
			propagated = false;
			if (rtUpdate.departure_delay !== null && rtUpdate.departure_delay !== undefined) {
				actDep = (schedDep ?? 0) + rtUpdate.departure_delay;
				delaySecs = rtUpdate.departure_delay;
				lastDelay = delaySecs;
				rtFlags.dep = true;
			} else if (rtUpdate.departure_time) {
				const depAbs = Math.floor(Number(rtUpdate.departure_time) - serviceDayStart);
				delaySecs = depAbs - (schedDep ?? 0);
				actDep = depAbs;
				lastDelay = delaySecs;
				rtFlags.dep = true;
			} else if (lastDelay) {
				actDep = (schedDep ?? 0) + lastDelay;
				propagated = true;
			}

			if (rtUpdate.arrival_delay !== null && rtUpdate.arrival_delay !== undefined) {
				actArr = (schedArr ?? 0) + rtUpdate.arrival_delay;
				delaySecs = rtUpdate.arrival_delay;
				rtFlags.arr = true;
			} else if (rtUpdate.arrival_time) {
				const arrAbs = Math.floor(Number(rtUpdate.arrival_time) - serviceDayStart);
				actArr = arrAbs;
				rtFlags.arr = true;
			} else if (lastDelay) {
				actArr = (schedArr ?? 0) + lastDelay;
				propagated = true;
			}

			const rtRawStop = cache.getRawStops(ctx, { feed_id: feedId, stop_id: rtUpdate.stop_id })[0];
			if (rtRawStop?.platform_code) {
				platformCode = rtRawStop.platform_code;
				rtFlags.platform = true;
			}

			if (rtUpdate.stop_id && rtUpdate.stop_id !== stopId) {
				actualStop = cache.getAugmentedStops(ctx, { feedId, localId: rtUpdate.stop_id })[0];
				actualParent = actualStop?.parent_station
					? cache.getAugmentedStops(ctx, { feedId, localId: actualStop.parent_station })[0]
					: null;
				rtFlags.stop = true;
				rtFlags.parent = true;
			}
		} else {
			if (lastDelay !== 0) {
				if (schedArr !== null) actArr = schedArr + lastDelay;
				if (schedDep !== null) actDep = schedDep + lastDelay;
				propagated = true;
			} else if (propagateOnTime) {
				delaySecs = 0;
				propagated = true;
			}
		}

		if (
			!isPassing &&
			pendingPassingRows.length > 0 &&
			pendingEmus &&
			pendingEmus.length >= 2 &&
			lastNonPassingActDepRaw !== null &&
			actArr != null &&
			actDep != null
		) {
			const startDep = lastNonPassingActDepRaw;
			const endArr = actArr;
			if (endArr > startDep) {
				const wallTimes = wasmInterpolateTimes(startDep, endArr, pendingEmus);
				const getOffsetPass = (secs: number) => Math.floor(secs / 86400);
				for (let pi = 0; pi < pendingPassingRows.length; pi++) {
					const row = pendingPassingRows[pi];
					const t = wallTimes[pi];
					const offArr = getOffsetPass(t);
					const offDep = offArr;
					const wallArr = t;
					const wallDep = t;
					const rawSched =
						(row.scheduled_arrival_time ?? 0) +
						86400 * (dateOffsets.schedArr + row.scheduled_arrival_date_offset);
					const delaySeg = Math.round(t - rawSched);
					const { str: delayStr, cls: delayCls } = calculateDelayClass(delaySeg);
					row.actual_arrival_time = wallArr;
					row.actual_departure_time = wallDep;
					row.actual_arrival_dates = getServiceDateArray(
						addDaysToDateString(serviceDate, offArr - dateOffsets.actArr, ctx),
						ctx,
					);
					row.actual_departure_dates = getServiceDateArray(
						addDaysToDateString(serviceDate, offDep - dateOffsets.actDep, ctx),
						ctx,
					);
					row.actual_arrival_date_offset = offArr - dateOffsets.actArr;
					row.actual_departure_date_offset = offDep - dateOffsets.actDep;
					if (row.realtime && row.realtime_info) {
						row.realtime_info = {
							...row.realtime_info,
							delay_secs: delaySeg,
							delay_string: delayStr,
							delay_class: delayCls,
							propagated: true,
						};
					}
				}
			}
			pendingPassingRows = [];
			pendingEmus = null;
		}

		let realtimeInfo = null;
		const hasRealtime =
			!!rtUpdate || propagated || (!!tripUpdate && scheduleRelationship === qdf.TripScheduleRelationship.ADDED);

		if (hasRealtime) {
			const { str, cls } = calculateDelayClass(delaySecs);
			realtimeInfo = {
				delay_secs: delaySecs,
				delay_string: str,
				delay_class: cls,
				schedule_relationship: currentScheduleRelationship,
				propagated: propagated && !isPassing,
				rt_start_date: tripUpdate?.trip.start_date ?? serviceDate,
			};
		}

		const realtimeDetails = hasRealtime
			? { realtime: true as const, realtime_info: realtimeInfo! }
			: { realtime: false as const, realtime_info: null };

		const getOffset = (secs: number) => Math.floor(secs / 86400);
		const currentOffsets = {
			schedArr: schedArr ? getOffset(schedArr) : null,
			schedDep: schedDep ? getOffset(schedDep) : null,
			actArr: actArr ? getOffset(actArr) : null,
			actDep: actDep ? getOffset(actDep) : null,
		};

		const datesServiceDate = serviceDate;

		const augmented: AugmentedStopTime = {
			_stopTime: isPassing ? null : stopTime,
			feed_id: stopFeedId,
			trip_id: tripId,
			passing: isPassing,
			pickup_type: stopTime.pickup_type,
			drop_off_type: stopTime.drop_off_type,
			instance_id: "",
			service_date: "",
			schedule_relationship: qdf.TripScheduleRelationship.SCHEDULED,
			service_capacity: ServiceCapacity.NOT_CALCULATED,
			actual_exit_side: null,
			scheduled_exit_side: null,

			actual_arrival_time: actArr ?? null,
			actual_departure_time: actDep ?? null,
			actual_stop_id: actualStop?.stop_id ?? stopId ?? null,
			actual_parent_station_id:
				actualParent?.stop_id ??
				actualStop?.parent_stop_id ??
				scheduledParent?.stop_id ??
				scheduledStop?.parent_stop_id ??
				null,
			actual_platform_code: isPassing ? null : (platformCode ?? scheduledStop?.platform_code ?? null),
			actual_arrival_boarding_locations: [],
			actual_departure_boarding_locations: [],

			rt_stop_updated: rtFlags.stop,
			rt_parent_station_updated: rtFlags.parent,
			rt_platform_code_updated: rtFlags.platform,
			rt_arrival_updated: rtFlags.arr,
			rt_departure_updated: rtFlags.dep,

			scheduled_arrival_time: schedArr ?? null,
			scheduled_departure_time: schedDep ?? null,
			scheduled_stop_id: scheduledStop?.stop_id ?? null,
			scheduled_parent_station_id: scheduledParent?.stop_id ?? scheduledStop?.parent_stop_id ?? null,
			scheduled_platform_code: isPassing ? null : (scheduledStop?.platform_code ?? null),

			...realtimeDetails,

			scheduled_arrival_dates: getServiceDateArray(
				addDaysToDateString(
					datesServiceDate,
					(currentOffsets.schedArr ?? currentOffsets.schedDep ?? dateOffsets.schedArr) - dateOffsets.schedArr,
					ctx,
				),
				ctx,
			),
			actual_arrival_dates: getServiceDateArray(
				addDaysToDateString(
					datesServiceDate,
					(currentOffsets.actArr ?? currentOffsets.actDep ?? dateOffsets.actArr) - dateOffsets.actArr,
					ctx,
				),
				ctx,
			),
			scheduled_arrival_date_offset:
				(currentOffsets.schedArr ?? currentOffsets.schedDep ?? dateOffsets.schedArr) - dateOffsets.schedArr,
			actual_arrival_date_offset:
				(currentOffsets.actArr ?? currentOffsets.actDep ?? dateOffsets.actArr) - dateOffsets.actArr,
			scheduled_departure_dates: getServiceDateArray(
				addDaysToDateString(
					datesServiceDate,
					(currentOffsets.schedDep ?? currentOffsets.schedArr ?? dateOffsets.schedDep) - dateOffsets.schedDep,
					ctx,
				),
				ctx,
			),
			actual_departure_dates: getServiceDateArray(
				addDaysToDateString(
					datesServiceDate,
					(currentOffsets.actDep ?? currentOffsets.actArr ?? dateOffsets.actDep) - dateOffsets.actDep,
					ctx,
				),
				ctx,
			),
			scheduled_departure_date_offset:
				(currentOffsets.schedDep ?? currentOffsets.schedArr ?? dateOffsets.schedDep) - dateOffsets.schedDep,
			actual_departure_date_offset:
				(currentOffsets.actDep ?? currentOffsets.actArr ?? dateOffsets.actDep) - dateOffsets.actDep,
		};

		attachStopReferences(augmented, {
			actualStop,
			actualParent,
			scheduledStop,
			scheduledParent,
		});

		finalStops.push(augmented);
		if (isPassing) {
			pendingPassingRows.push(augmented);
			const segmentEmu = (stopTime as qdf.StopTime & { _segmentEmus?: number[] })._segmentEmus;
			if (segmentEmu?.length && !pendingEmus) pendingEmus = segmentEmu;
		} else {
			lastNonPassingActDepRaw = actDep;
		}
	}
	ctx.augmented.timer.stop("augmentStopTimes:processStops");

	const seqState = getSeqState(ctx);
	let pd = seqState.platformData;
	if (!seqPlatformDefinitionsPresent(pd)) {
		const loadedPlatforms = loadPlatformData(ctx.config);
		seqState.platformData = { ...loadedPlatforms, ...(pd ?? {}) };
		pd = seqState.platformData;
	}

	ctx.augmented.timer.start("augmentStopTimes:assignPlatformSides");
	const result = assignPlatformSides(finalStops, pd ?? {});
	ctx.augmented.timer.stop("augmentStopTimes:assignPlatformSides");

	ctx.augmented.timer.stop("augmentStopTimes");
	return result;
}
