import * as qdf from "qdf-gtfs";
import { AugmentedStop } from "./augmentedStop.js";
import * as cache from "../cache.js";
import { findPassingStopTimes } from "./SectionalRunningTimes/gtfs.js";
import platformData from "./platformData.js";
import logger from "./logger.js";

// --- Types & Exports ---

export type AugmentedStopTime = {
	toSerializable: () => SerializableAugmentedStopTime;
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
} & (
		| {
			realtime: true;
			realtime_info: {
				delay_secs: number;
				delay_string: string;
				delay_class: "on-time" | "scheduled" | "late" | "very-late" | "early";
				schedule_relationship: qdf.StopTimeScheduleRelationship;
				propagated: boolean;
				rt_start_date: string;
			};
		}
		| {
			realtime: false;
			realtime_info: null;
		}
	);

// Internal type for data before platform/exit side calculation
type IntermediateAST = Omit<AugmentedStopTime, "actual_exit_side" | "scheduled_exit_side" | "toSerializable">;

export type SerializableAugmentedStopTime = Omit<
	AugmentedStopTime,
	| "actual_stop"
	| "actual_parent_station"
	| "scheduled_stop"
	| "scheduled_parent_station"
	| "toSerializable"
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
		// @ts-expect-error
		toSerializable: undefined,
	};
}

// --- Internal Helper Types ---

type PassingStopSRT = {
	from: string;
	to: string;
	emu: number;
	passing: boolean;
};

// --- Helper Functions ---

function getStopOrParentId(stopId: string | undefined, ctx?: cache.CacheContext): string | undefined {
	if (!stopId) return undefined;
	const stop = cache.getRawStops(stopId, ctx)[0];
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

/**
 * Adds days to a YYYYMMDD string correctly.
 */
function addDaysToDateString(dateStr: string, daysToAdd: number): string {
	if (daysToAdd === 0) return dateStr;
	const y = parseInt(dateStr.slice(0, 4), 10);
	const m = parseInt(dateStr.slice(4, 6), 10) - 1; // Month is 0-indexed
	const d = parseInt(dateStr.slice(6, 8), 10);

	// Use UTC to avoid daylight saving time issues affecting the date
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

	const prevId =
		index > 0 ? stops[index - 1].actual_parent_station?.stop_id || stops[index - 1].actual_stop?.stop_id : "";
	const nextId =
		index < stops.length - 1
			? stops[index + 1].actual_parent_station?.stop_id || stops[index + 1].actual_stop?.stop_id
			: "";

	const matchesNext = platform.next.includes(nextId);
	const matchesPrev = platform.from.includes(prevId);

	const swap = { left: "right", right: "left", both: "both" } as const;

	if (matchesNext || matchesPrev) {
		return platform.exitSide;
	}
	return swap[platform.exitSide as keyof typeof swap];
}

function assignPlatformSides(st: IntermediateAST[]): AugmentedStopTime[] {
	// Track codes to maintain continuity preference
	let prevActualTrack = "";
	let prevScheduledTrack = "";

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
			schPlat =
				schData?.find((v: any) => v.platform_code === parseInt(item.scheduled_platform_code ?? "0")) ?? null;
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
			toSerializable: () => toSerializableAugmentedStopTime(newEntry), // Circular ref handled in closure
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

	return pathBuffer.map((v) => ({
		...v,
		toSerializable: () => toSerializableAugmentedStopTime(v),
	}));
}

// --- Main Augmentation Function ---

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
	let stopTimes: qdf.StopTime[] = [];

	if (staticStopTimes) {
		stopTimes = staticStopTimes;
	} else if (tripUpdate && (scheduleRelationship === qdf.TripScheduleRelationship.ADDED || scheduleRelationship === qdf.TripScheduleRelationship.UNSCHEDULED)) {
		// Generate Pseudo-Static Stop Times for ADDED/UNSCHEDULED trips
		// Sort updates by stop_sequence just in case
		const updates = [...(tripUpdate.stop_time_updates || [])].sort((a, b) => (a.stop_sequence ?? 0) - (b.stop_sequence ?? 0));

		stopTimes = updates.map(u => {
			// Convert RT time to seconds since midnight of service day (roughly)
			// We assume serviceDate (YYYYMMDD) is the base.

			let arrival_time = 0;
			let departure_time = 0;

			// Helper to get time relative to service date
			const y = parseInt(serviceDate.slice(0, 4));
			const m = parseInt(serviceDate.slice(4, 6)) - 1;
			const d = parseInt(serviceDate.slice(6, 8));
			// Construct date in AEST (+10)
			const serviceDayStart = new Date(Date.UTC(y, m, d) - 10 * 3600 * 1000).getTime() / 1000;

			if (u.arrival_time) {
				arrival_time = Math.floor(Number(u.arrival_time) - serviceDayStart);
			}
			if (u.departure_time) {
				departure_time = Math.floor(Number(u.departure_time) - serviceDayStart);
			}

			// Fallbacks if only delay is provided
			if (arrival_time === 0 && departure_time !== 0) arrival_time = departure_time;
			if (departure_time === 0 && arrival_time !== 0) departure_time = arrival_time;

			return {
				trip_id: tripUpdate.trip.trip_id,
				arrival_time,
				departure_time,
				stop_id: u.stop_id,
				stop_sequence: u.stop_sequence ?? 0,
				stop_headsign: "",
				pickup_type: 0,
				drop_off_type: 0,
				shape_dist_traveled: 0,
				timepoint: 1,
				continuous_pickup: 0,
				continuous_drop_off: 0,
			} as qdf.StopTime;
		});
	} else {
		return [];
	}

	if (stopTimes.length === 0) return [];

	const tripId = stopTimes[0].trip_id;

	const stopTimeUpdates: qdf.RealtimeStopTimeUpdate[] = tripUpdate?.stop_time_updates ?? [];
	const passingStopTimes = findPassingStopTimes(stopTimes, ctx);

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
		actDep: Math.floor(initialActualDep / 86400),
	};

	// Propagation State
	let lastDelay = 0;
	let lastScheduleRelationship = qdf.StopTimeScheduleRelationship.NO_DATA;
	// If it's ADDED, we don't "propagate on time" in the same way, as the schedule IS the realtime.
	let propagateOnTime = scheduleRelationship === qdf.TripScheduleRelationship.SCHEDULED;

	const intermediateStops: IntermediateAST[] = [];

	for (const passingStopTime of passingStopTimes) {
		const stopId = passingStopTime.stop_id;
		const isPassing = passingStopTime._passing;

		// 1. Fetch Stop Info
		const scheduledStop = cache.getAugmentedStops(stopId, ctx)[0];
		const scheduledParent = scheduledStop?.parent_station
			? cache.getAugmentedStops(scheduledStop.parent_station, ctx)[0]
			: null;

		// 2. Find Realtime Update
		// Logic: Match specific stop, parent station, or any child of the augmented stop
		const rtUpdate = stopTimeUpdates.find(
			(u) =>
				u.stop_id === stopId ||
				scheduledParent?.stop_id === u.stop_id ||
				scheduledStop?.children?.some((child) => child.stop_id === u.stop_id),
		);

		// 3. Resolve Realtime Values
		const schedArr = passingStopTime.arrival_time;
		const schedDep = passingStopTime.departure_time;
		let actArr = schedArr;
		let actDep = schedDep;

		let delaySecs = lastDelay;
		let propagated = false;
		let currentScheduleRelationship: qdf.StopTimeScheduleRelationship = lastScheduleRelationship;

		let rtFlags = {
			stop: false,
			parent: false,
			platform: false,
			arr: false,
			dep: false,
		};

		let platformCode: string | null = null;
		let actualStop = scheduledStop;
		let actualParent = scheduledParent;

		if (rtUpdate) {
			propagated = false;

			// Update Delay/Times
			if (rtUpdate.departure_delay !== null && rtUpdate.departure_delay !== undefined) {
				if (schedDep !== null) actDep = schedDep + (rtUpdate.departure_delay ?? 0);
				delaySecs = rtUpdate.departure_delay;
				lastDelay = delaySecs;
				rtFlags.dep = true;
			} else if (lastDelay) {
				if (schedDep !== null) actDep = schedDep + lastDelay;
				propagated = true;
			}

			if (rtUpdate.arrival_delay !== null && rtUpdate.arrival_delay !== undefined) {
				if (schedArr !== null) actArr = schedArr + (rtUpdate.arrival_delay ?? 0);
				delaySecs = rtUpdate.arrival_delay;
				lastDelay = delaySecs;
				rtFlags.arr = true;
			} else if (lastDelay) {
				if (schedArr !== null) actArr = schedArr + lastDelay;
				propagated = true;
			}

			// Update Platform/Stop
			const rtRawStop = cache.getRawStops(rtUpdate.stop_id, ctx)[0];
			if (rtRawStop?.platform_code) {
				platformCode = rtRawStop.platform_code;
				rtFlags.platform = true;
			}

			if (rtUpdate.schedule_relationship) {
				currentScheduleRelationship = rtUpdate.schedule_relationship;
				lastScheduleRelationship = currentScheduleRelationship;
			}

			if (rtUpdate.stop_id && rtUpdate.stop_id !== stopId) {
				actualStop = cache.getAugmentedStops(rtUpdate.stop_id, ctx)[0];
				actualParent = actualStop?.parent_station
					? cache.getAugmentedStops(actualStop.parent_station, ctx)[0]
					: null;
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
				currentScheduleRelationship = qdf.StopTimeScheduleRelationship.SCHEDULED;
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
				schedule_relationship: currentScheduleRelationship,
				propagated: propagated && !isPassing,
				rt_start_date: rtUpdate?.start_date ?? tripUpdate?.trip.start_date ?? serviceDate,
			};
		}

		// 5. Date Calculations
		const getOffset = (secs: number | undefined | null) => (secs ? Math.floor(secs / 86400) : 0);

		const currentOffsets = {
			schedArr: getOffset(schedArr),
			schedDep: getOffset(schedDep),
			actArr: getOffset(actArr),
			actDep: getOffset(actDep),
		};

		const tripUpdateStartDate = tripUpdate?.trip.start_date ?? serviceDate;
		const datesServiceDate = serviceDate;

		const scheduled_arrival_dates = [datesServiceDate].map((d) =>
			addDaysToDateString(d, currentOffsets.schedArr - dateOffsets.schedArr),
		);
		const scheduled_departure_dates = [datesServiceDate].map((d) =>
			addDaysToDateString(d, currentOffsets.schedDep - dateOffsets.schedDep),
		);

		const actual_arrival_dates = [datesServiceDate].map((d) =>
			d === tripUpdateStartDate
				? addDaysToDateString(d, currentOffsets.actArr - dateOffsets.actArr)
				: addDaysToDateString(d, currentOffsets.schedArr - dateOffsets.schedArr),
		);
		const actual_departure_dates = [datesServiceDate].map((d) =>
			d === tripUpdateStartDate
				? addDaysToDateString(d, currentOffsets.actDep - dateOffsets.actDep)
				: addDaysToDateString(d, currentOffsets.schedDep - dateOffsets.schedDep),
		);

		intermediateStops.push({
			_stopTime: isPassing ? null : passingStopTime,
			trip_id: tripId,
			passing: isPassing,

			// Initialize fields to be populated by augmentTrip
			instance_id: "",
			service_date: "",
			schedule_relationship: qdf.TripScheduleRelationship.SCHEDULED,
			service_capacity: null,

			actual_arrival_time: actArr ? actArr % 86400 : null,
			actual_departure_time: actDep ? actDep % 86400 : null,
			actual_stop: actualStop,
			actual_parent_station: actualParent,
			actual_platform_code: isPassing ? null : (platformCode ?? scheduledStop?.platform_code ?? null),

			rt_stop_updated: rtFlags.stop,
			rt_parent_station_updated: rtFlags.parent,
			rt_platform_code_updated: rtFlags.platform,
			rt_arrival_updated: rtFlags.arr,
			rt_departure_updated: rtFlags.dep,

			scheduled_arrival_time: schedArr ? schedArr % 86400 : null,
			scheduled_departure_time: schedDep ? schedDep % 86400 : null,
			scheduled_stop: scheduledStop,
			scheduled_parent_station: scheduledParent,
			scheduled_platform_code: isPassing ? null : (scheduledStop?.platform_code ?? null),

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
