import * as cache from "../cache/index.js";
import { findExpressString } from "./SRT.js";
import { getServiceCapacity, ServiceCapacity } from "./serviceCapacity.js";
import { AugmentedStop } from "./augmentedStop.js";
import { AugmentedStopTime } from "./augmentedStopTime.js";
import { AugmentedTripInstance } from "./augmentedTrip.js";
import { addDaysToServiceDate, getEpochDayFromServiceDate, getServiceDate, getServiceDayStart } from "./time.js";
import { getFeedTimeZone } from "../config.js";

function timeSeconds(time: string): number {
	const [hours, minutes, seconds] = time.split(":").map(Number);
	return hours * 3600 + minutes * 60 + seconds;
}

type DepartureResult = AugmentedStopTime & { express_string: string; instance_id: string };

type DepartureSlice = {
	stopTimes: AugmentedStopTime[];
	dayStart: number;
};

/** Keep this order in sync with getStopDeparturesCached's sort key. */
function departureTimeSeconds(stopTime: AugmentedStopTime): number {
	return stopTime.actual_departure_time ?? stopTime.scheduled_departure_time ?? stopTime.actual_arrival_time ?? 0;
}

function lowerBound(stopTimes: readonly AugmentedStopTime[], timeSeconds: number): number {
	let low = 0;
	let high = stopTimes.length;
	while (low < high) {
		const middle = low + Math.floor((high - low) / 2);
		if (departureTimeSeconds(stopTimes[middle]) < timeSeconds) low = middle + 1;
		else high = middle;
	}
	return low;
}

function upperBound(stopTimes: readonly AugmentedStopTime[], timeSeconds: number): number {
	let low = 0;
	let high = stopTimes.length;
	while (low < high) {
		const middle = low + Math.floor((high - low) / 2);
		if (departureTimeSeconds(stopTimes[middle]) <= timeSeconds) low = middle + 1;
		else high = middle;
	}
	return low;
}

function getDepartureSlice(
	stopTimes: AugmentedStopTime[],
	dayStart: number,
	windowStartAbs: number,
	windowEndAbs: number,
): DepartureSlice {
	const first = lowerBound(stopTimes, windowStartAbs - dayStart);
	const end = upperBound(stopTimes, windowEndAbs - dayStart);
	return { stopTimes: stopTimes.slice(first, end), dayStart };
}

/** Merge the already sorted per-stop slices without sorting the combined day. */
function mergeDepartureSlices(slices: readonly DepartureSlice[]): AugmentedStopTime[] {
	const merged: AugmentedStopTime[] = [];
	const cursors = slices.map((slice) => ({ slice, index: 0 }));

	while (true) {
		let nextCursor: (typeof cursors)[number] | undefined;
		let nextTime = Number.POSITIVE_INFINITY;
		for (const cursor of cursors) {
			const stopTime = cursor.slice.stopTimes[cursor.index];
			if (!stopTime) continue;
			const time = cursor.slice.dayStart + departureTimeSeconds(stopTime);
			if (nextCursor === undefined || time < nextTime) {
				nextCursor = cursor;
				nextTime = time;
			}
		}
		if (!nextCursor) break;
		merged.push(nextCursor.slice.stopTimes[nextCursor.index]);
		nextCursor.index++;
	}

	return merged;
}

function mapDepartureResults(stopTimes: AugmentedStopTime[], ctx: cache.CacheContext): DepartureResult[] {
	const instanceCache = new Map<string, AugmentedTripInstance>();
	const seenInstanceIds = new Set<string>();
	const results: DepartureResult[] = [];
	for (const st of stopTimes) {
		if (seenInstanceIds.has(st.instance_id)) continue;
		const inst =
			instanceCache.get(st.instance_id) ??
			ctx.augmented.instancesRec.get(st.instance_id) ??
			cache.getAugmentedTripInstance(ctx, st.instance_id);
		if (!inst) continue;
		instanceCache.set(st.instance_id, inst);
		seenInstanceIds.add(st.instance_id);
		results.push({
			...st,
			express_string: findExpressString(
				inst.expressInfo,
				ctx,
				st.actual_parent_station_id || st.actual_stop_id
					? { feedId: st.feed_id, localId: st.actual_parent_station_id ?? st.actual_stop_id! }
					: null,
			),
			instance_id: inst.instance_id,
			service_capacity:
				st.service_capacity === ServiceCapacity.NOT_CALCULATED
					? getServiceCapacity(inst, st, inst.serviceDate, undefined, ctx, ctx.config)
					: st.service_capacity,
		});
	}
	return results;
}

/** Query an absolute time window while still evaluating GTFS times against each service day's DST-safe origin. */
export function getDeparturesForInstantWindow(
	stop: AugmentedStop,
	windowStartEpochSeconds: number,
	windowEndEpochSeconds: number,
	ctx: cache.CacheContext,
): DepartureResult[] {
	if (!Number.isFinite(windowStartEpochSeconds) || !Number.isFinite(windowEndEpochSeconds) || windowEndEpochSeconds < windowStartEpochSeconds) {
		throw new Error("Invalid departure instant window");
	}
	const timeZone = getFeedTimeZone(ctx.config, stop.feed_id);
	const firstLocalDate = getServiceDate(new Date(windowStartEpochSeconds * 1000), timeZone);
	const lastLocalDate = getServiceDate(new Date(windowEndEpochSeconds * 1000), timeZone);
	const dayCount = Math.max(0, getEpochDayFromServiceDate(lastLocalDate) - getEpochDayFromServiceDate(firstLocalDate));
	const validStops = new Set<string>([stop.stop_id, stop.parent_stop_id, ...stop.child_stop_ids].filter(Boolean) as string[]);
	const candidates: { stopTime: AugmentedStopTime; at: number }[] = [];

	// Long services can start several dates earlier than the requested window.
	for (let offset = -ctx.runtimeState.maxTripLookbackDays; offset <= dayCount + 1; offset++) {
		const serviceDate = addDaysToServiceDate(firstLocalDate, offset);
		const dayStart = getServiceDayStart(serviceDate, timeZone);
		for (const stopId of validStops) {
			for (const stopTime of cache.getStopDeparturesCached(ctx, { feedId: stop.feed_id, localId: stopId }, serviceDate)) {
				const seconds = stopTime.actual_departure_time ?? stopTime.actual_arrival_time ?? stopTime.scheduled_departure_time ?? 0;
				const at = dayStart + seconds;
				if (at >= windowStartEpochSeconds && at <= windowEndEpochSeconds) candidates.push({ stopTime, at });
			}
		}
	}
	candidates.sort((a, b) => a.at - b.at);
	return mapDepartureResults(candidates.map(({ stopTime }) => stopTime), ctx);
}

export function getDeparturesForStop(
	stop: AugmentedStop,
	date: string,
	start_time: string,
	end_time: string,
	ctx: cache.CacheContext,
): DepartureResult[] {
	ctx.augmented.timer.start("getDeparturesForStop");
	const startSec = timeSeconds(start_time);
	const endSec = timeSeconds(end_time);
	const parentId = stop.parent_stop_id;
	const childIds = stop.child_stop_ids;
	const validStops = new Set<string>([stop.stop_id, parentId, ...childIds].filter(Boolean) as string[]);
	const baseDayStart = getServiceDayStart(date, getFeedTimeZone(ctx.config, stop.feed_id));
	const windowStartAbs = baseDayStart + startSec;
	const windowEndAbs = baseDayStart + endSec;

	const daysForwardStart = Math.floor(startSec / 86400);
	const daysForwardEnd = Math.floor(endSec / 86400);

	ctx.augmented.timer.start("getDeparturesForStop:collect");
	const slices: DepartureSlice[] = [];

	for (let df = daysForwardStart; df <= daysForwardEnd; df++) {
		const serviceDateStr = addDaysToServiceDate(date, df);
		const dayStart = getServiceDayStart(serviceDateStr, getFeedTimeZone(ctx.config, stop.feed_id));

		for (const stopId of validStops) {
			const stopDepartures = cache.getStopDeparturesCached(
				ctx,
				{ feedId: stop.feed_id, localId: stopId },
				serviceDateStr,
			);
			slices.push(getDepartureSlice(stopDepartures, dayStart, windowStartAbs, windowEndAbs));
		}
	}
	ctx.augmented.timer.stop("getDeparturesForStop:collect");

	const mergedResults = mergeDepartureSlices(slices);
	ctx.augmented.timer.start("getDeparturesForStop:map");
	const results = mapDepartureResults(mergedResults, ctx);
	ctx.augmented.timer.stop("getDeparturesForStop:map");

	ctx.augmented.timer.stop("getDeparturesForStop");
	return results;
}

export function getServiceDateDeparturesForStop(
	stop: AugmentedStop,
	serviceDate: string,
	start_time_secs: number,
	end_time_secs: number,
	ctx: cache.CacheContext,
): DepartureResult[] {
	ctx.augmented.timer.start("getServiceDateDeparturesForStop");
	const parentId = stop.parent_stop_id;
	const childIds = stop.child_stop_ids;
	const validStops = new Set<string>([stop.stop_id, parentId, ...childIds].filter(Boolean) as string[]);
	const dayStart = getServiceDayStart(serviceDate, getFeedTimeZone(ctx.config, stop.feed_id));
	const windowStartAbs = dayStart + start_time_secs;
	const windowEndAbs = dayStart + end_time_secs;

	ctx.augmented.timer.start("getServiceDateDeparturesForStop:collect");
	const slices: DepartureSlice[] = [];

	for (const stopId of validStops) {
		const stopDepartures = cache.getStopDeparturesCached(
			ctx,
			{ feedId: stop.feed_id, localId: stopId },
			serviceDate,
		);
		slices.push(getDepartureSlice(stopDepartures, dayStart, windowStartAbs, windowEndAbs));
	}
	ctx.augmented.timer.stop("getServiceDateDeparturesForStop:collect");

	const mergedResults = mergeDepartureSlices(slices);
	ctx.augmented.timer.start("getServiceDateDeparturesForStop:map");
	const results = mapDepartureResults(mergedResults, ctx);
	ctx.augmented.timer.stop("getServiceDateDeparturesForStop:map");

	ctx.augmented.timer.stop("getServiceDateDeparturesForStop");
	return results;
}

export function attachDeparturesHelpers(stop: AugmentedStop, ctx: cache.CacheContext): AugmentedStop {
	Object.defineProperties(stop, {
		getDepartures: {
			value: (date: string, start_time: string, end_time: string) =>
				getDeparturesForStop(stop, date, start_time, end_time, ctx),
			enumerable: false,
		},
		_getSDDepartures: {
			value: (serviceDate: string, start_time_secs: number, end_time_secs: number) =>
				getServiceDateDeparturesForStop(stop, serviceDate, start_time_secs, end_time_secs, ctx),
			enumerable: false,
		},
		_getInstantDepartures: {
			value: (startEpochSeconds: number, endEpochSeconds: number) =>
				getDeparturesForInstantWindow(stop, startEpochSeconds, endEpochSeconds, ctx),
			enumerable: false,
		},
	});
	return stop;
}
