import * as qdf from "qdf-gtfs";
import { AugmentedStop } from "./augmentedStop.js";
import * as cache from "../cache.js";
import { findPassingStopTimes } from "./SRT.js";
import platformData from "./platformData.js";

// --- Types & Exports ---

export type AugmentedStopTime = {
	_stopTime: qdf.StopTime | null;
	trip_id: string;
	passing: boolean;

	// Instance Metadata
	instance_id: string;
	service_date: string;
	schedule_relationship: qdf.TripScheduleRelationship;
	service_capacity: string | null;

	// Exit sides
	actual_exit_side: "left" | "right" | "both" | null;
	scheduled_exit_side: "left" | "right" | "both" | null;

	// Actual times (Realtime if available, otherwise scheduled)
	// Seconds since midnight of the offset day
	actual_arrival_time: number | null;
	actual_departure_time: number | null;
	actual_stop_id: string | null;
	actual_parent_station_id: string | null;
	actual_platform_code: string | null;

	// Realtime updates metadata
	rt_stop_updated: boolean;
	rt_parent_station_updated: boolean;
	rt_platform_code_updated: boolean;
	rt_arrival_updated: boolean;
	rt_departure_updated: boolean;

	// Scheduled times
	scheduled_arrival_time: number | null;
	scheduled_departure_time: number | null;
	scheduled_stop_id: string | null;
	scheduled_parent_station_id: string | null;
	scheduled_platform_code: string | null;

	// Date handling
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
		// Non-enumerable helpers added at runtime
		actual_stop?: AugmentedStop | null;
		actual_parent_station?: AugmentedStop | null;
		scheduled_stop?: AugmentedStop | null;
		scheduled_parent_station?: AugmentedStop | null;
	};

// Internal type for data before platform/exit side calculation
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
	Object.defineProperties(ast, {
		actual_stop: { value: refs.actualStop ?? null, enumerable: false, writable: true },
		actual_parent_station: { value: refs.actualParent ?? null, enumerable: false, writable: true },
		scheduled_stop: { value: refs.scheduledStop ?? null, enumerable: false, writable: true },
		scheduled_parent_station: { value: refs.scheduledParent ?? null, enumerable: false, writable: true },
	});
}

// --- Helper Functions ---

function getPlatformData(stopId: string | null | undefined) {
	if (!stopId) return null;
	return platformData[stopId];
}

function calculateDelayClass(delaySecs: number) {
	if (Math.abs(delaySecs) <= 60) return { str: "on time", cls: "on-time" as const };
	if (delaySecs > 0 && delaySecs <= 300) return { str: `${Math.round(delaySecs / 60)}m late`, cls: "late" as const };
	if (delaySecs > 300) return { str: `${Math.round(delaySecs / 60)}m late`, cls: "very-late" as const };
	return { str: `${Math.round(Math.abs(delaySecs) / 60)}m early`, cls: "early" as const };
}

function addDaysToDateString(dateStr: string, daysToAdd: number): string {
	if (daysToAdd === 0) return dateStr;
	const y = parseInt(dateStr.slice(0, 4), 10);
	const m = parseInt(dateStr.slice(4, 6), 10) - 1;
	const d = parseInt(dateStr.slice(6, 8), 10);

	const date = new Date(Date.UTC(y, m, d));
	date.setUTCDate(date.getUTCDate() + daysToAdd);

	const ny = date.getUTCFullYear();
	const nm = (date.getUTCMonth() + 1).toString().padStart(2, "0");
	const nd = date.getUTCDate().toString().padStart(2, "0");
	return `${ny}${nm}${nd}`;
}

// --- Platform & Side Logic ---

function resolveExitSide(
	stops: IntermediateAST[],
	index: number,
	platformDataList: any[],
	platformCode: number,
): "left" | "right" | "both" | null {
	const platform = platformDataList?.find((v) => v.platform_code === platformCode);
	if (!platform) return null;

	const prevId = index > 0 ? stops[index - 1].actual_parent_station_id || stops[index - 1].actual_stop_id : "";
	const nextId =
		index < stops.length - 1 ? stops[index + 1].actual_parent_station_id || stops[index + 1].actual_stop_id : "";

	const matchesNext = platform.next.includes(nextId);
	const matchesPrev = platform.from.includes(prevId);

	const swap = { left: "right", right: "left", both: "both" } as const;

	if (matchesNext || matchesPrev) {
		return platform.exitSide;
	}
	return swap[platform.exitSide as keyof typeof swap];
}

function assignPlatformSides(st: IntermediateAST[]): AugmentedStopTime[] {
	let prevActualTrack = "";
	let prevScheduledTrack = "";

	let pathBuffer: AugmentedStopTime[] = [];
	let candidatePathB: AugmentedStopTime[] = [];
	let candidatePathA: AugmentedStopTime[] = [];
	let candidatePathS: AugmentedStopTime[] = [];

	for (let i = 0; i < st.length; i++) {
		const item = st[i];
		// Skip sides for SKIPPED stops
		if (item.realtime && item.realtime_info?.schedule_relationship === qdf.StopTimeScheduleRelationship.SKIPPED) {
			const refs = {
				actualStop: (item as any).actual_stop ?? null,
				actualParent: (item as any).actual_parent_station ?? null,
				scheduledStop: (item as any).scheduled_stop ?? null,
				scheduledParent: (item as any).scheduled_parent_station ?? null,
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

		let actPlat: any = null;
		let schPlat: any = null;

		if (item.passing) {
			actPlat = actData?.find((v: any) => v.trackCode === prevActualTrack) ?? null;
			schPlat = schData?.find((v: any) => v.trackCode === prevScheduledTrack) ?? null;
			if (!actPlat) prevActualTrack = "";
			if (!schPlat) prevScheduledTrack = "";
		} else {
			actPlat = actData?.find((v: any) => v.platform_code === parseInt(item.actual_platform_code ?? "0")) ?? null;
			schPlat =
				schData?.find((v: any) => v.platform_code === parseInt(item.scheduled_platform_code ?? "0")) ?? null;
		}

		if (actPlat?.trackCode === prevActualTrack && schPlat?.trackCode === prevScheduledTrack) {
			pathBuffer = [...candidatePathB];
		} else if (actPlat?.trackCode === prevActualTrack) {
			pathBuffer = [...candidatePathA];
		} else if (schPlat?.trackCode === prevScheduledTrack) {
			pathBuffer = [...candidatePathS];
		}

		let actSide: "left" | "right" | "both" | null = null;
		let schSide: "left" | "right" | "both" | null = null;

		if (!item.passing) {
			if (actPlat) actSide = resolveExitSide(st, i, actData ?? [], actPlat.platform_code);
			if (schPlat) schSide = resolveExitSide(st, i, schData ?? [], schPlat.platform_code);
		}

		const refs = {
			actualStop: (item as any).actual_stop ?? null,
			actualParent: (item as any).actual_parent_station ?? null,
			scheduledStop: (item as any).scheduled_stop ?? null,
			scheduledParent: (item as any).scheduled_parent_station ?? null,
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
		candidatePathB = [...pathBuffer];
		candidatePathA = [...pathBuffer];
		candidatePathS = [...pathBuffer];

		prevActualTrack = actPlat?.trackCode ?? "";
		prevScheduledTrack = schPlat?.trackCode ?? "";
	}

	return pathBuffer;
}

// --- Augmentation Logic ---

/**
 * Reconciles static stops with realtime updates.
 * Handles added stops, changed stop IDs, and reordering based on sequence.
 */
export function augmentStopTimes(
	staticStopTimes: qdf.StopTime[] | null,
	instanceContext: {
		serviceDate: string;
		tripUpdate: qdf.RealtimeTripUpdate | null;
		scheduleRelationship: qdf.TripScheduleRelationship;
	},
	ctx?: cache.CacheContext,
): AugmentedStopTime[] {
	const { serviceDate, tripUpdate, scheduleRelationship } = instanceContext;
	const tripId = tripUpdate?.trip.trip_id || staticStopTimes?.[0]?.trip_id || "";

	// 1. Gather all sequences from Static and RT
	const stopTimeUpdates = tripUpdate?.stop_time_updates || [];
	const sequenceMap = new Map<number, { static?: qdf.StopTime; rt?: qdf.RealtimeStopTimeUpdate }>();

	// Map Static
	if (staticStopTimes) {
		for (const st of staticStopTimes) {
			const seq = st.stop_sequence;
			if (!sequenceMap.has(seq)) sequenceMap.set(seq, {});
			sequenceMap.get(seq)!.static = st;
		}
	}

	// Map Realtime
	for (const rt of stopTimeUpdates) {
		const seq = rt.stop_sequence;
		// If an update doesn't have a sequence, we can't reliably map it without strict stop_id matching logic which is prone to error on loops.
		// GTFS-RT spec strongly encourages stop_sequence.
		if (seq !== undefined && seq !== null) {
			if (!sequenceMap.has(seq)) sequenceMap.set(seq, {});
			sequenceMap.get(seq)!.rt = rt;
		}
	}

	// 2. Sort Sequences
	const sortedSequences = Array.from(sequenceMap.keys()).sort((a, b) => a - b);

	// 3. Build Merged List (Pre-interpolation)
	// We need to construct a list of objects that look like qdf.StopTime but contain merged info.
	type MergedStop = qdf.StopTime & {
		_rtUpdate?: qdf.RealtimeStopTimeUpdate;
		_isSkipped?: boolean;
	};

	const mergedList: MergedStop[] = [];

	// Helper to calculate seconds from service date
	const y = parseInt(serviceDate.slice(0, 4));
	const m = parseInt(serviceDate.slice(4, 6)) - 1;
	const d = parseInt(serviceDate.slice(6, 8));
	const serviceDayStart = new Date(Date.UTC(y, m, d) - 10 * 3600 * 1000).getTime() / 1000;

	for (const seq of sortedSequences) {
		const entry = sequenceMap.get(seq)!;
		const s = entry.static;
		const r = entry.rt;

		// Check for SKIPPED status
		const isSkipped = r?.schedule_relationship === qdf.StopTimeScheduleRelationship.SKIPPED;

		// Base object
		let stopId = s?.stop_id || r?.stop_id || "";
		let arr = s?.arrival_time ?? 0;
		let dep = s?.departure_time ?? 0;

		// If this is purely an added stop via RT
		if (!s && r) {
			// Convert RT timestamps to relative seconds if provided, otherwise 0
			// Note: If only delays are provided for an ADDED stop, it's ambiguous, but usually ADDED stops have absolute times.
			if (r.arrival_time) arr = Math.floor(Number(r.arrival_time) - serviceDayStart);
			if (r.departure_time) dep = Math.floor(Number(r.departure_time) - serviceDayStart);
			if (arr === 0 && dep !== 0) arr = dep;
			if (dep === 0 && arr !== 0) dep = arr;
		}

		mergedList.push({
			trip_id: tripId,
			stop_sequence: seq,
			stop_id: stopId,
			arrival_time: arr,
			departure_time: dep,
			stop_headsign: s?.stop_headsign || "",
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

	// 4. Calculate Passing Times (Interpolation)
	// We only want to run SRT logic on stops that are NOT skipped.
	// If a stop is skipped, the train doesn't go there (or passes through without stopping in a way that implies a different path/timing).
	const activeStops = mergedList.filter((s) => !s._isSkipped);

	// findPassingStopTimes returns qdf.StopTime[], effectively stripping our extra metadata.
	// We need to re-match the results back to our mergedList structure.
	const interpolatedActiveStops = findPassingStopTimes(activeStops, ctx);

	// 5. Re-integrate Skipped Stops & Construct Final AST
	const finalStops: IntermediateAST[] = [];

	let activeIdx = 0;

	// Initial Offsets for Date Calculation
	const firstValid = interpolatedActiveStops[0];
	const initialScheduledArr = firstValid?.arrival_time ?? 0;
	const initialScheduledDep = firstValid?.departure_time ?? 0;
	const initialActualArr = initialScheduledArr; // Start assumption
	const initialActualDep = initialScheduledDep;

	const dateOffsets = {
		schedArr: Math.floor(initialScheduledArr / 86400),
		schedDep: Math.floor(initialScheduledDep / 86400),
		actArr: Math.floor(initialActualArr / 86400),
		actDep: Math.floor(initialActualDep / 86400),
	};

	let lastDelay = 0;
	const propagateOnTime = scheduleRelationship === qdf.TripScheduleRelationship.SCHEDULED && !!tripUpdate;

	// Iterate through the original sorted sequences to maintain order (including skipped)
	// We use sortedSequences to map back to our mergedList which might have "Active" and "Skipped" entries

	// We iterate through mergedList because it aligns 1:1 with sortedSequences
	for (const originalMergeItem of mergedList) {
		if (originalMergeItem._isSkipped) {
			// Construct a "Skipped" AugmentedStopTime
			const scheduledStop = cache.getAugmentedStops(originalMergeItem.stop_id, ctx)[0];
			const scheduledParent = scheduledStop?.parent_stop_id
				? cache.getAugmentedStops(scheduledStop.parent_stop_id, ctx)[0]
				: null;
			const skipped: AugmentedStopTime = {
				_stopTime: originalMergeItem,
				trip_id: tripId,
				passing: false,
				instance_id: "",
				service_date: "",
				schedule_relationship: qdf.TripScheduleRelationship.SCHEDULED,
				service_capacity: null,
				actual_exit_side: null,
				scheduled_exit_side: null,

				actual_arrival_time: null,
				actual_departure_time: null,
				actual_stop_id: scheduledStop?.stop_id ?? null,
				actual_parent_station_id: scheduledParent?.stop_id ?? scheduledStop?.parent_stop_id ?? null,
				actual_platform_code: null,

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
			continue;
		}

		// It's an active stop (either original or interpolated)
		// We need to grab the *interpolated* version which might be passing
		// Note: activeStops was fed to findPassingStopTimes.
		// interpolatedActiveStops contains the result, which might contain MORE items (passing nodes) than activeStops.
		// However, findPassingStopTimes returns items in order.
		// Wait - findPassingStopTimes INSERTS nodes. So 1:1 mapping with mergedList breaks if we iterate mergedList.
		// Correction: We must iterate the *interpolatedActiveStops* and insert Skipped stops where their sequence implies.
	}

	// Correct Loop Strategy:
	// We have `mergedList` (contains static+RT, including skipped, sorted by sequence).
	// We have `interpolatedActiveStops` (contains static+RT active stops + inserted passing nodes).
	// Passing nodes generated by SRT usually share the sequence number of the start or end, or interpolate.
	// Let's iterate `interpolatedActiveStops` and check sequence gaps to re-insert skipped stops.

	let currentSequence = -1;

	for (const stopTime of interpolatedActiveStops) {
		const seq = stopTime.stop_sequence;
		const isPassing = (stopTime as any)._passing;

		// Check if we skipped any sequences from the merged list that were marked SKIPPED
		// We look at sortedSequences.
		// While the next sequence in sorted list < current interpolated sequence, check if it was skipped.

		// Note: Passing stops might have fractional sequences or same sequence.
		// We only check for skipped stops that are explicitly in the sortedSequences map.

		const prevWholeSeq = Math.floor(currentSequence);
		const currWholeSeq = Math.floor(seq);

		// If we jumped ahead in sequence, check if we missed any "Skipped" stops in the gap
		for (let s = prevWholeSeq + 1; s < currWholeSeq; s++) {
			const missed = sequenceMap.get(s);
			if (missed && missed.rt?.schedule_relationship === qdf.StopTimeScheduleRelationship.SKIPPED) {
				// Insert Skipped Stop
				const originalMergeItem = mergedList.find((m) => m.stop_sequence === s);
				if (originalMergeItem) {
					const scheduledStop = cache.getAugmentedStops(originalMergeItem.stop_id, ctx)[0];
					const scheduledParent = scheduledStop?.parent_stop_id
						? cache.getAugmentedStops(scheduledStop.parent_stop_id, ctx)[0]
						: null;
					const skipped: AugmentedStopTime = {
						_stopTime: originalMergeItem,
						trip_id: tripId,
						passing: false,
						instance_id: "",
						service_date: "",
						schedule_relationship: qdf.TripScheduleRelationship.SCHEDULED,
						service_capacity: null,
						actual_exit_side: null,
						scheduled_exit_side: null,
						actual_arrival_time: null,
						actual_departure_time: null,
						actual_stop_id: scheduledStop?.stop_id ?? null,
						actual_parent_station_id: scheduledParent?.stop_id ?? scheduledStop?.parent_stop_id ?? null,
						actual_platform_code: null,
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

		// Process the Active Stop (stopTime)
		const stopId = stopTime.stop_id;
		const rtUpdate =
			stopTimeUpdates.find((u) => u.stop_sequence === seq && !isPassing) ||
			(isPassing ? undefined : stopTimeUpdates.find((u) => u.stop_id === stopId)); // Fallback to ID match if sequence match fails (unlikely given how we built merged)

		const scheduledStop = cache.getAugmentedStops(stopId, ctx)[0];
		const scheduledParentId = scheduledStop?.parent_stop_id ?? scheduledStop?.parent_station ?? null;
		const scheduledParent = scheduledParentId ? cache.getAugmentedStops(scheduledParentId, ctx)[0] : null;

		// Timing Logic
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
			// Departure Delay
			if (rtUpdate.departure_delay !== null && rtUpdate.departure_delay !== undefined) {
				actDep = (schedDep ?? 0) + rtUpdate.departure_delay;
				delaySecs = rtUpdate.departure_delay;
				lastDelay = delaySecs;
				rtFlags.dep = true;
			} else if (rtUpdate.departure_time) {
				// Absolute time override
				const depAbs = Math.floor(Number(rtUpdate.departure_time) - serviceDayStart);
				delaySecs = depAbs - (schedDep ?? 0);
				actDep = depAbs;
				lastDelay = delaySecs;
				rtFlags.dep = true;
			} else if (lastDelay) {
				actDep = (schedDep ?? 0) + lastDelay;
				propagated = true;
			}

			// Arrival Delay
			if (rtUpdate.arrival_delay !== null && rtUpdate.arrival_delay !== undefined) {
				actArr = (schedArr ?? 0) + rtUpdate.arrival_delay;
				delaySecs = rtUpdate.arrival_delay; // Update lastDelay based on arrival too? Usually departure dictates propagation.
				rtFlags.arr = true;
			} else if (rtUpdate.arrival_time) {
				const arrAbs = Math.floor(Number(rtUpdate.arrival_time) - serviceDayStart);
				actArr = arrAbs;
				rtFlags.arr = true;
			} else if (lastDelay) {
				actArr = (schedArr ?? 0) + lastDelay;
				propagated = true;
			}

			// Platform
			const rtRawStop = cache.getRawStops(rtUpdate.stop_id, ctx)[0];
			if (rtRawStop?.platform_code) {
				platformCode = rtRawStop.platform_code;
				rtFlags.platform = true;
			}

			// Stop Change
			if (rtUpdate.stop_id && rtUpdate.stop_id !== stopId) {
				actualStop = cache.getAugmentedStops(rtUpdate.stop_id, ctx)[0];
				actualParent = actualStop?.parent_station
					? cache.getAugmentedStops(actualStop.parent_station, ctx)[0]
					: null;
				rtFlags.stop = true;
				rtFlags.parent = true;
			}
		} else {
			// Propagation Logic
			if (lastDelay !== 0) {
				if (schedArr !== null) actArr = schedArr + lastDelay;
				if (schedDep !== null) actDep = schedDep + lastDelay;
				propagated = true;
			} else if (propagateOnTime) {
				delaySecs = 0;
				propagated = true;
			}
		}

		// Construct Realtime Info
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

		// Dates
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
			trip_id: tripId,
			passing: isPassing,
			instance_id: "",
			service_date: "",
			schedule_relationship: qdf.TripScheduleRelationship.SCHEDULED,
			service_capacity: "BYA",
			actual_exit_side: null,
			scheduled_exit_side: null,

			actual_arrival_time: actArr ? actArr % 86400 : null,
			actual_departure_time: actDep ? actDep % 86400 : null,
			actual_stop_id: actualStop?.stop_id ?? stopId ?? null,
			actual_parent_station_id:
				actualParent?.stop_id ??
				actualStop?.parent_stop_id ??
				scheduledParent?.stop_id ??
				scheduledStop?.parent_stop_id ??
				null,
			actual_platform_code: isPassing ? null : (platformCode ?? scheduledStop?.platform_code ?? null),

			rt_stop_updated: rtFlags.stop,
			rt_parent_station_updated: rtFlags.parent,
			rt_platform_code_updated: rtFlags.platform,
			rt_arrival_updated: rtFlags.arr,
			rt_departure_updated: rtFlags.dep,

			scheduled_arrival_time: schedArr ? schedArr % 86400 : null,
			scheduled_departure_time: schedDep ? schedDep % 86400 : null,
			scheduled_stop_id: scheduledStop?.stop_id ?? null,
			scheduled_parent_station_id: scheduledParent?.stop_id ?? scheduledStop?.parent_stop_id ?? null,
			scheduled_platform_code: isPassing ? null : (scheduledStop?.platform_code ?? null),

			...realtimeDetails,

			scheduled_arrival_dates: [
				addDaysToDateString(
					datesServiceDate,
					(currentOffsets.schedArr ?? currentOffsets.schedDep ?? dateOffsets.schedArr) - dateOffsets.schedArr,
				),
			],
			actual_arrival_dates: [
				addDaysToDateString(
					datesServiceDate,
					(currentOffsets.actArr ?? currentOffsets.actDep ?? dateOffsets.actArr) - dateOffsets.actArr,
				),
			],
			scheduled_arrival_date_offset:
				(currentOffsets.schedArr ?? currentOffsets.schedDep ?? dateOffsets.schedArr) - dateOffsets.schedArr,
			actual_arrival_date_offset:
				(currentOffsets.actArr ?? currentOffsets.actDep ?? dateOffsets.actArr) - dateOffsets.actArr,
			scheduled_departure_dates: [
				addDaysToDateString(
					datesServiceDate,
					(currentOffsets.schedDep ?? currentOffsets.schedArr ?? dateOffsets.schedDep) - dateOffsets.schedDep,
				),
			],
			actual_departure_dates: [
				addDaysToDateString(
					datesServiceDate,
					(currentOffsets.actDep ?? currentOffsets.actArr ?? dateOffsets.actDep) - dateOffsets.actDep,
				),
			],
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
	}

	return assignPlatformSides(finalStops);
}
