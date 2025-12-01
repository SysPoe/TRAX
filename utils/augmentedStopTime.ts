import * as qdf from "qdf-gtfs";
import { AugmentedStop } from "./augmentedStop.js";
import * as cache from "../cache.js";
import { findExpress } from "./express.js";
import { getSRT } from "./srt.js";
import { today } from "../index.js";
import platformData from "./platformData/data.js";
import logger from "./logger.js";

// --- Types & Exports ---

export type AugmentedStopTime = {
	toSerializable: () => SerializableAugmentedStopTime;
	_stopTime: qdf.StopTime | null;
	trip_id: string;
	passing: boolean;

	// Exit sides
	actual_exit_side: "left" | "right" | "both" | null;
	scheduled_exit_side: "left" | "right" | "both" | null;

	// Actual times (Realtime if available, otherwise scheduled)
	// Seconds since midnight of the offset day
	actual_arrival_time: number | null;
	actual_departure_time: number | null;
	actual_stop: AugmentedStop | null;
	actual_parent_station: AugmentedStop | null;
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
	scheduled_stop: AugmentedStop | null;
	scheduled_parent_station: AugmentedStop | null;
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
} & ({
	realtime: true;
	realtime_info: {
		delay_secs: number;
		delay_string: string;
		delay_class: "on-time" | "scheduled" | "late" | "very-late" | "early";
		schedule_relationship: qdf.StopTimeScheduleRelationship;
		propagated: boolean;
	};
} | {
	realtime: false;
	realtime_info: null;
});

// Internal type for data before platform/exit side calculation
type IntermediateAST = Omit<AugmentedStopTime, "actual_exit_side" | "scheduled_exit_side" | "toSerializable">;

export type SerializableAugmentedStopTime = Omit<
	AugmentedStopTime,
	"actual_stop" | "actual_parent_station" | "scheduled_stop" | "scheduled_parent_station" | "toSerializable"
> & {
	actual_stop: string | null;
	actual_parent_station: string | null;
	scheduled_stop: string | null;
	scheduled_parent_station: string | null;
};

export function toSerializableAugmentedStopTime(
	st: Omit<AugmentedStopTime, "toSerializable">,
): SerializableAugmentedStopTime {
	return {
		...st,
		actual_stop: st.actual_stop?.stop_id ?? null,
		actual_parent_station: st.actual_parent_station?.stop_id ?? null,
		scheduled_stop: st.scheduled_stop?.stop_id ?? null,
		scheduled_parent_station: st.scheduled_parent_station?.stop_id ?? null,
	};
}

// --- Internal Helper Types ---

type PassingStopSRT = {
	from: string;
	to: string;
	emu: number;
	passing: boolean;
};

type PassingStopTime = qdf.StopTime & { _passing: boolean };

// --- Caching & Logging ---

const loggedMissingSRT = new Set<string>();

// --- Helper Functions ---

function getStopOrParentId(stopId: string | undefined): string | undefined {
	if (!stopId) return undefined;
	const stop = cache.getRawStops(stopId)[0];
	return stop?.parent_station ?? undefined;
}

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

// --- Passing Stop Logic ---

function findPassingStops(stops: string[]): { stop_id: string; passing: boolean }[] {
	const stopListHash = stops.join("|");
	const cached = cache.getCachedPassingStops(stopListHash);
	if (cached) return cached;

	const expressSegments = findExpress(stops);
	const allStops: { stop_id: string; passing: boolean }[] = [];

	const addStop = (id: string, passing: boolean) => {
		// Prevent duplicates at segment boundaries
		if (allStops.at(-1)?.stop_id !== id) {
			allStops.push({ stop_id: id, passing });
		}
	};

	for (const segment of expressSegments) {
		if (segment.type === "unknown_segment") {
			logger.error(`Unknown segment between ${segment.from} and ${segment.to}: ${segment.message}`, {
				module: "augmentedStopTime",
				function: "findPassingStops",
			});
			continue;
		}

		if (segment.type === "local") {
			addStop(segment.from, false);
			const startIndex = stops.indexOf(segment.from);
			// Add intermediate local stops
			for (let i = startIndex + 1; i < stops.length; i++) {
				if (stops[i] === segment.to) break;
				addStop(stops[i], false);
			}
			continue;
		}

		// Handle express segments
		addStop(segment.from, false);
		segment.skipping?.forEach((s) => addStop(s, true));
		addStop(segment.to, false);
	}

	cache.cachePassingStops(stopListHash, allStops);
	return allStops;
}

function findPassingStopSRTs(stops: string[]): PassingStopSRT[] {
	const allStops = findPassingStops(stops);
	const results: PassingStopSRT[] = [];

	for (let i = 0; i < allStops.length - 1; i++) {
		const from = allStops[i].stop_id;
		const to = allStops[i + 1].stop_id;
		const srt = getSRT(from, to);

		if (srt === undefined) {
			const key = `${from}|${to}`;
			if (!loggedMissingSRT.has(key)) {
				logger.error(`No SRT found between ${from} and ${to}`, {
					module: "augmentedStopTime",
					function: "findPassingStopSRTs",
				});
				loggedMissingSRT.add(key);
			}
			// Default to 1 minute if missing to prevent calculation break
			results.push({ from, to, emu: 1, passing: allStops[i + 1].passing });
		} else {
			results.push({ from, to, emu: srt, passing: allStops[i + 1].passing });
		}
	}
	return results;
}

function findPassingStopTimes(stopTimes: qdf.StopTime[]): PassingStopTime[] {
	if (stopTimes.length === 0) return [];

	// Extract parent stations for SRT lookup, sorted by sequence
	const sortedStopTimes = [...stopTimes].sort((a, b) => (a.stop_sequence ?? 0) - (b.stop_sequence ?? 0));
	const stops = sortedStopTimes
		.map((st) => getStopOrParentId(st.stop_id))
		.filter((v): v is string => v !== undefined);

	const idsToTimes: Record<string, qdf.StopTime> = {};
	for (const st of stopTimes) {
		const parent = getStopOrParentId(st.stop_id);
		if (parent) idsToTimes[parent] = st;
	}

	const passingSRTs = findPassingStopSRTs(stops);
	if (!passingSRTs.length) {
		logger.error(`No passing SRTs found for stops ${stops.join(", ")}`, {
			module: "augmentedStopTime",
			function: "findPassingStopTimes",
		});
		return [];
	}

	let resultTimes: PassingStopTime[] = [{ ...idsToTimes[passingSRTs[0].from], _passing: false }];
	let currentPassingRun: PassingStopSRT[] = [];

	// Process segments
	for (const srt of passingSRTs) {
		if (srt.passing) {
			currentPassingRun.push(srt);
			continue;
		}

		if (currentPassingRun.length === 0) {
			resultTimes.push({ ...idsToTimes[srt.to], _passing: false });
			continue;
		}

		// We have a block of passing stops to interpolate
		const startTime = resultTimes.at(-1);
		const endTime = idsToTimes[srt.to];

		if (!startTime?.departure_time || !endTime?.departure_time) {
			logger.error("Missing departure times for interpolation", {
				module: "augmentedStopTime",
				function: "findPassingStopTimes",
				start: startTime,
				end: endTime,
			});
			// Skip interpolation if data invalid, but add the endpoint
			resultTimes.push({ ...idsToTimes[srt.to], _passing: false });
			currentPassingRun = [];
			continue;
		}

		const totalTimeDiff = Math.floor((endTime.departure_time - startTime.departure_time) / 60);
		const totalEmu = currentPassingRun.reduce((acc, curr) => acc + curr.emu, 0);

		let accumulatedEmu = 0;
		for (let i = 0; i < currentPassingRun.length; i++) {
			const run = currentPassingRun[i];
			// Rescale EMU based on actual scheduled difference
			const scaledEmu = Math.floor((run.emu / totalEmu) * totalTimeDiff);
			accumulatedEmu += scaledEmu;

			if (scaledEmu <= 0) continue; // Skip zero-time stops

			const interpolatedTime = startTime.departure_time + accumulatedEmu * 60;
			
			resultTimes.push({
				_passing: true,
				stop_id: run.to,
				trip_id: stopTimes[0].trip_id,
				// Interpolate sequence
				stop_sequence: stopTimes[0].stop_sequence + i / currentPassingRun.length, 
				departure_time: interpolatedTime,
				arrival_time: interpolatedTime, // Arrival = Departure for passing
				drop_off_type: qdf.DropOffType.None,
				pickup_type: qdf.PickupType.None,
				continuous_drop_off: qdf.ContinuousDropOff.None,
				continuous_pickup: qdf.ContinuousPickup.None,
				shape_dist_traveled: -1,
				stop_headsign: "",
				timepoint: -1,
			});
		}

		resultTimes.push({ ...endTime, _passing: false });
		currentPassingRun = [];
	}

	// Ensure the very last stop of the trip is included if it wasn't caught by the loop
	const lastOriginal = stopTimes.at(-1);
	const lastAdded = resultTimes.at(-1);
	if (lastOriginal && lastAdded && lastAdded.stop_sequence !== lastOriginal.stop_sequence) {
		resultTimes.push({ ...lastOriginal, _passing: false });
	}

	return resultTimes;
}

// --- Platform & Side Logic ---

function resolveExitSide(
	stops: IntermediateAST[], 
	index: number, 
	platformDataList: any[], 
	platformCode: number
): "left" | "right" | "both" | null {
	const platform = platformDataList?.find((v) => v.platform_code === platformCode);
	if (!platform) return null;

	const prevId = index > 0 
		? (stops[index - 1].actual_parent_station?.stop_id || stops[index - 1].actual_stop?.stop_id) 
		: "";
	const nextId = index < stops.length - 1 
		? (stops[index + 1].actual_parent_station?.stop_id || stops[index + 1].actual_stop?.stop_id) 
		: "";

	const matchesNext = platform.next.includes(nextId);
	const matchesPrev = platform.from.includes(prevId);
	
	const swap = { left: "right", right: "left", both: "both" } as const;

	if (matchesNext || matchesPrev) {
		return platform.exitSide;
	}
	// If it doesn't match logical flow, swap side (legacy logic from original code)
	return swap[platform.exitSide as keyof typeof swap];
}

function assignPlatformSides(st: IntermediateAST[]): AugmentedStopTime[] {
	// We track three versions of the list to handle track code continuity
	// This replaces the complex intA/AltB/AltA swapping logic with a state object approach
	// However, to keep it structurally similar to the robust original logic while cleaning it:
	
	let resultList: AugmentedStopTime[] = [];
	
	// Track codes to maintain continuity preference
	let prevActualTrack = "";
	let prevScheduledTrack = "";

	// We'll build the list progressively. 
	// The original code used retrospective replacement of the whole list array pointer.
	// We will simplify: calculate both current platforms, check continuity against previous,
	// and update "prev" trackers.
	
	// Note: The original logic allowed "backtracking" by swapping the whole array 'intA'.
	// That is highly unusual. Assuming the intent is to prefer the track path that is consistent.
	// We will simulate the "winning path" logic.

	let pathBuffer: AugmentedStopTime[] = []; // Current committed path
	let candidatePathB: AugmentedStopTime[] = []; // Both consistent
	let candidatePathA: AugmentedStopTime[] = []; // Actual consistent
	let candidatePathS: AugmentedStopTime[] = []; // Scheduled consistent

	for (let i = 0; i < st.length; i++) {
		const item = st[i];
		const actId = item.actual_parent_station?.stop_id ?? item.actual_stop?.stop_id;
		const schId = item.scheduled_parent_station?.stop_id ?? item.scheduled_stop?.stop_id;

		const actData = getPlatformData(actId);
		const schData = getPlatformData(schId);

		// Determine Platform Objects
		let actPlat: any = null;
		let schPlat: any = null;

		if (item.passing) {
			// For passing stops, we infer platform from track code if possible
			actPlat = actData?.find((v: any) => v.trackCode === prevActualTrack) ?? null;
			schPlat = schData?.find((v: any) => v.trackCode === prevScheduledTrack) ?? null;
			
			// If we lost the track, reset
			if (!actPlat) prevActualTrack = "";
			if (!schPlat) prevScheduledTrack = "";
		} else {
			// For stopping stops, use the codes we have
			actPlat = actData?.find((v: any) => v.platform_code === parseInt(item.actual_platform_code ?? "0")) ?? null;
			schPlat = schData?.find((v: any) => v.platform_code === parseInt(item.scheduled_platform_code ?? "0")) ?? null;
		}

		// Select the best "history" based on continuity
		if (actPlat?.trackCode === prevActualTrack && schPlat?.trackCode === prevScheduledTrack) {
			pathBuffer = [...candidatePathB];
		} else if (actPlat?.trackCode === prevActualTrack) {
			pathBuffer = [...candidatePathA];
		} else if (schPlat?.trackCode === prevScheduledTrack) {
			pathBuffer = [...candidatePathS];
		}
		// Else keep current pathBuffer (continuity broken or start of trip)

		// Calculate Sides
		let actSide: "left" | "right" | "both" | null = null;
		let schSide: "left" | "right" | "both" | null = null;

		if (!item.passing) {
			// Side logic relies on next/prev connectivity
			// We need a lookahead/lookbehind.
			// Ideally this should be done after the full path is built, but we do it iteratively here
			// utilizing the incomplete array for "prev" and the source array for "next".
			
			// Note: The original code utilized `intA` (the growing result) for prev checks.
			// We replicate that by passing `st` (source) and `i` (index) to a helper,
			// acknowledging that `st` has the correct sequence of stops.
			
			if (actPlat) actSide = resolveExitSide(st, i, actData ?? [], actPlat.platform_code);
			if (schPlat) schSide = resolveExitSide(st, i, schData ?? [], schPlat.platform_code);
		}

		// Create the new entry
		const newEntry: AugmentedStopTime = {
			...item,
			actual_exit_side: actSide,
			scheduled_exit_side: schSide,
			actual_platform_code: actPlat?.platform_code?.toString() ?? item.actual_platform_code,
			scheduled_platform_code: schPlat?.platform_code?.toString() ?? item.scheduled_platform_code,
			toSerializable: () => toSerializableAugmentedStopTime(newEntry) // Circular ref handled in closure
		} as AugmentedStopTime;

		// Push to buffer
		pathBuffer.push(newEntry);

		// Update candidates for next iteration
		candidatePathB = [...pathBuffer];
		candidatePathA = [...pathBuffer];
		candidatePathS = [...pathBuffer];

		// Update Tracks
		prevActualTrack = actPlat?.trackCode ?? "";
		prevScheduledTrack = schPlat?.trackCode ?? "";
	}

	// Fix the circular reference in toSerializable now that object is fully formed? 
	// The original code did `v => ({ ...v, toSerializable: ... })` at the very end.
	return pathBuffer.map(v => ({
		...v,
		toSerializable: () => toSerializableAugmentedStopTime(v)
	}));
}

// --- Main Augmentation Function ---

export function augmentStopTimes(
	stopTimes: qdf.StopTime[],
	serviceDates: string[],
): AugmentedStopTime[] {
	if (stopTimes.length === 0) return [];

	const tripId = stopTimes[0].trip_id;
	if (!stopTimes.every((v) => v.trip_id === tripId)) {
		logger.error(`Mixed trip IDs in stopTimes: ${tripId}`, {
			module: "augmentedStopTime",
			function: "augmentStopTimes",
		});
	}

	const tripUpdate = cache.getTripUpdates(tripId)[0];
	const stopTimeUpdates = tripUpdate?.stop_time_updates ?? [];
	const passingStopTimes = findPassingStopTimes(stopTimes);

	// Initial offsets (first stop)
	const firstStop = passingStopTimes[0];
	const initialScheduledArr = firstStop.arrival_time ?? 0;
	const initialScheduledDep = firstStop.departure_time ?? 0;
	// We assume actual starts same as scheduled unless updated immediately
	const initialActualArr = initialScheduledArr; 
	const initialActualDep = initialScheduledDep;

	const dateOffsets = {
		schedArr: Math.floor(initialScheduledArr / 86400),
		schedDep: Math.floor(initialScheduledDep / 86400),
		actArr: Math.floor(initialActualArr / 86400),
		actDep: Math.floor(initialActualDep / 86400)
	};

	// Propagation State
	let lastDelay = 0;
	let lastScheduleRelationship = qdf.StopTimeScheduleRelationship.NO_DATA;
	let propagateOnTime = tripUpdate?.trip.schedule_relationship === qdf.TripScheduleRelationship.SCHEDULED;

	const intermediateStops: IntermediateAST[] = [];

	for (const passingStopTime of passingStopTimes) {
		const stopId = passingStopTime.stop_id;
		const isPassing = passingStopTime._passing;

		// 1. Fetch Stop Info
		const scheduledStop = cache.getAugmentedStops(stopId)[0];
		const scheduledParent = scheduledStop?.parent_station ? cache.getAugmentedStops(scheduledStop.parent_station)[0] : null;

		// 2. Find Realtime Update
		// Logic: Match specific stop, parent station, or any child of the augmented stop
		const rtUpdate = stopTimeUpdates.find(
			(u) =>
				u.stop_id === stopId ||
				scheduledParent?.stop_id === u.stop_id ||
				scheduledStop.children.some((child) => child.stop_id === u.stop_id),
		);

		// 3. Resolve Realtime Values
		const schedArr = passingStopTime.arrival_time;
		const schedDep = passingStopTime.departure_time;
		let actArr = schedArr;
		let actDep = schedDep;

		let delaySecs = lastDelay;
		let propagated = false;
		let scheduleRelationship: qdf.StopTimeScheduleRelationship = lastScheduleRelationship;
		
		let rtFlags = {
			stop: false, parent: false, platform: false, arr: false, dep: false
		};
		
		let platformCode: string | null = null;
		let actualStop = scheduledStop;
		let actualParent = scheduledParent;

		if (rtUpdate) {
			propagated = false;
			
			// Update Delay/Times
			if (rtUpdate.departure_delay !== undefined) {
				if (schedDep !== undefined) actDep = schedDep + rtUpdate.departure_delay;
				delaySecs = rtUpdate.departure_delay;
				lastDelay = delaySecs;
				rtFlags.dep = true;
			} else if (lastDelay) {
				if (schedDep !== undefined) actDep = schedDep + lastDelay;
				propagated = true;
			}

			if (rtUpdate.arrival_delay !== undefined) {
				if (schedArr !== undefined) actArr = schedArr + rtUpdate.arrival_delay;
				delaySecs = rtUpdate.arrival_delay;
				lastDelay = delaySecs;
				rtFlags.arr = true;
			} else if (lastDelay) {
				if (schedArr !== undefined) actArr = schedArr + lastDelay;
				propagated = true;
			}

			// Update Platform/Stop
			const rtRawStop = cache.getRawStops(rtUpdate.stop_id)[0];
			if (rtRawStop?.platform_code) {
				platformCode = rtRawStop.platform_code;
				rtFlags.platform = true;
			}

			if (rtUpdate.schedule_relationship) {
				scheduleRelationship = rtUpdate.schedule_relationship;
				lastScheduleRelationship = scheduleRelationship;
			}

			if (rtUpdate.stop_id && rtUpdate.stop_id !== stopId) {
				actualStop = cache.getAugmentedStops(rtUpdate.stop_id)[0];
				actualParent = actualStop?.parent_station ? cache.getAugmentedStops(actualStop.parent_station)[0] : null;
				rtFlags.stop = true;
				rtFlags.parent = true;
			}
		} else {
			// No direct update
			if (lastDelay !== 0) {
				if (schedArr !== undefined) actArr = schedArr + lastDelay;
				if (schedDep !== undefined) actDep = schedDep + lastDelay;
				propagated = true;
			} else if (propagateOnTime) {
				delaySecs = 0;
				propagated = true;
				scheduleRelationship = qdf.StopTimeScheduleRelationship.SCHEDULED;
			}
		}

		// 4. Construct Realtime Info Object
		let realtimeInfo = null;
		const hasRealtime = rtUpdate != undefined || propagated || tripUpdate != undefined;

		if (hasRealtime) {
			const { str, cls } = calculateDelayClass(delaySecs);
			realtimeInfo = {
				delay_secs: delaySecs,
				delay_string: str,
				delay_class: cls,
				schedule_relationship: scheduleRelationship,
				propagated: propagated && !isPassing,
			};
		}

		// 5. Date Calculations
		const getOffset = (secs: number | undefined | null) => (secs ? Math.floor(secs / 86400) : 0);
		
		const currentOffsets = {
			schedArr: getOffset(schedArr),
			schedDep: getOffset(schedDep),
			actArr: getOffset(actArr),
			actDep: getOffset(actDep)
		};

		const scheduled_arrival_dates = serviceDates.map((d) => d + (currentOffsets.schedArr - dateOffsets.schedArr));
		const scheduled_departure_dates = serviceDates.map((d) => d + (currentOffsets.schedDep - dateOffsets.schedDep));
		
		// Actual dates logic: if today, use actual offset, otherwise assume scheduled offset relative to that day
		const todayStr = today();
		const actual_arrival_dates = serviceDates.map(d => 
			d === todayStr ? d + (currentOffsets.actArr - dateOffsets.actArr) : d + (currentOffsets.schedArr - dateOffsets.schedArr)
		);
		const actual_departure_dates = serviceDates.map(d => 
			d === todayStr ? d + (currentOffsets.actDep - dateOffsets.actDep) : d + (currentOffsets.schedDep - dateOffsets.schedDep)
		);

		intermediateStops.push({
			_stopTime: isPassing ? null : passingStopTime,
			trip_id: tripId,
			passing: isPassing,
			
			actual_arrival_time: actArr ? actArr % 86400 : null,
			actual_departure_time: actDep ? actDep % 86400 : null,
			actual_stop: actualStop,
			actual_parent_station: actualParent,
			actual_platform_code: isPassing ? null : (platformCode ?? scheduledStop.platform_code ?? null),
			
			rt_stop_updated: rtFlags.stop,
			rt_parent_station_updated: rtFlags.parent,
			rt_platform_code_updated: rtFlags.platform,
			rt_arrival_updated: rtFlags.arr,
			rt_departure_updated: rtFlags.dep,
			
			scheduled_arrival_time: schedArr ? schedArr % 86400 : null,
			scheduled_departure_time: schedDep ? schedDep % 86400 : null,
			scheduled_stop: scheduledStop,
			scheduled_parent_station: scheduledParent,
			scheduled_platform_code: isPassing ? null : (scheduledStop.platform_code ?? null),
			
			realtime: hasRealtime,
			realtime_info: realtimeInfo,
			
			scheduled_arrival_dates,
			actual_arrival_dates,
			scheduled_arrival_date_offset: currentOffsets.schedArr - dateOffsets.schedArr,
			actual_arrival_date_offset: currentOffsets.actArr - dateOffsets.actArr,
			scheduled_departure_dates,
			actual_departure_dates,
			scheduled_departure_date_offset: currentOffsets.schedDep - dateOffsets.schedDep,
			actual_departure_date_offset: currentOffsets.actDep - dateOffsets.actDep,
		});
	}

	return assignPlatformSides(intermediateStops);
}