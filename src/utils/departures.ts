import * as cache from "../cache.js";
import { findExpressString } from "./SRT.js";
import { getServiceCapacity, ServiceCapacity } from "./serviceCapacity.js";
import { AugmentedStop } from "./augmentedStop.js";
import { AugmentedStopTime } from "./augmentedStopTime.js";
import { AugmentedTripInstance } from "./augmentedTrip.js";
import { addDaysToServiceDate, getServiceDayStart } from "./time.js";
import { filterAndSortDepartures } from "../../build/release.js";

function timeSeconds(time: string): number {
	const [hours, minutes, seconds] = time.split(":").map(Number);
	return hours * 3600 + minutes * 60 + seconds;
}

type DepartureResult = AugmentedStopTime & { express_string: string; instance_id: string };

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
	const instanceCache = new Map<string, AugmentedTripInstance>();
	const baseDayStart = getServiceDayStart(date, ctx.config.timezone);
	const windowStartAbs = baseDayStart + startSec;
	const windowEndAbs = baseDayStart + endSec;

	const daysForwardStart = Math.floor(startSec / 86400);
	const daysForwardEnd = Math.floor(endSec / 86400);

	const getInstance = (instanceId: string): AugmentedTripInstance | null => {
		if (instanceCache.has(instanceId)) return instanceCache.get(instanceId) ?? null;
		const cached = ctx.augmented.instancesRec.get(instanceId) ?? cache.getAugmentedTripInstance(ctx, instanceId);
		if (cached) instanceCache.set(instanceId, cached);
		return cached ?? null;
	};

	ctx.augmented.timer.start("getDeparturesForStop:collect");
	const allTimestamps: number[] = [];
	const allStopsAndInsts: { st: AugmentedStopTime; inst: AugmentedTripInstance | null }[] = [];

	for (let df = daysForwardStart; df <= daysForwardEnd; df++) {
		const serviceDateStr = addDaysToServiceDate(date, df);
		const dayStart = getServiceDayStart(serviceDateStr, ctx.config.timezone);

		for (const stopId of validStops) {
			const stopDepartures = cache.getStopDeparturesCached(ctx, stopId, serviceDateStr);
			for (const st of stopDepartures) {
				const timeSecs = st.actual_departure_time ?? st.actual_arrival_time ?? st.scheduled_departure_time ?? 0;
				const absTs = dayStart + timeSecs;

				allTimestamps.push(absTs);
				allStopsAndInsts.push({ st, inst: null }); // inst will be fetched later for filtered results
			}
		}
	}
	ctx.augmented.timer.stop("getDeparturesForStop:collect");

	ctx.augmented.timer.start("getDeparturesForStop:wasm");
	const originalIndices: number[] = new Array(allTimestamps.length);
	for (let i = 0; i < allTimestamps.length; i++) originalIndices[i] = i;

	const filteredIndicesBig = filterAndSortDepartures(allTimestamps, originalIndices, windowStartAbs, windowEndAbs);
	const filteredIndices = filteredIndicesBig.map(Number);
	ctx.augmented.timer.stop("getDeparturesForStop:wasm");

	ctx.augmented.timer.start("getDeparturesForStop:instantiate");
	const finalResults: { st: AugmentedStopTime; inst: AugmentedTripInstance }[] = [];
	for (const idx of filteredIndices) {
		const entry = allStopsAndInsts[idx];
		const inst = getInstance(entry.st.instance_id);
		if (inst) {
			finalResults.push({ st: entry.st, inst });
		}
	}
	ctx.augmented.timer.stop("getDeparturesForStop:instantiate");

	ctx.augmented.timer.start("getDeparturesForStop:map");
	const sortedResults = finalResults.map(({ st, inst }) => {
		const expressString = findExpressString(
			inst.expressInfo,
			ctx,
			st.actual_parent_station_id ?? st.actual_stop_id ?? "",
		);
		return {
			...st,
			express_string: expressString,
			instance_id: inst.instance_id,
			service_capacity:
				st.service_capacity === ServiceCapacity.NOT_CALCULATED
					? getServiceCapacity(inst, st, inst.serviceDate, undefined, ctx, ctx.config)
					: st.service_capacity,
		};
	});
	ctx.augmented.timer.stop("getDeparturesForStop:map");

	const seenInstanceIds = new Set<string>();
	const dedupedResults = sortedResults.filter((dep) => {
		if (seenInstanceIds.has(dep.instance_id)) return false;
		seenInstanceIds.add(dep.instance_id);
		return true;
	});

	ctx.augmented.timer.stop("getDeparturesForStop");
	return dedupedResults;
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
	const instanceCache = new Map<string, AugmentedTripInstance>();
	const dayStart = getServiceDayStart(serviceDate, ctx.config.timezone);
	const windowStartAbs = dayStart + start_time_secs;
	const windowEndAbs = dayStart + end_time_secs;
	const results: { st: AugmentedStopTime; inst: AugmentedTripInstance }[] = [];

	const getInstance = (instanceId: string): AugmentedTripInstance | null => {
		if (instanceCache.has(instanceId)) return instanceCache.get(instanceId) ?? null;
		const cached = ctx.augmented.instancesRec.get(instanceId) ?? cache.getAugmentedTripInstance(ctx, instanceId);
		if (cached) instanceCache.set(instanceId, cached);
		return cached ?? null;
	};

	ctx.augmented.timer.start("getServiceDateDeparturesForStop:collect");
	const allTimestamps: number[] = [];
	const allStopsAndInsts: { st: AugmentedStopTime; inst: AugmentedTripInstance | null }[] = [];

	for (const stopId of validStops) {
		const stopDepartures = cache.getStopDeparturesCached(ctx, stopId, serviceDate);
		for (const st of stopDepartures) {
			const timeSecs = st.actual_departure_time ?? st.actual_arrival_time ?? st.scheduled_departure_time ?? 0;
			const absTs = dayStart + timeSecs;

			allTimestamps.push(absTs);
			allStopsAndInsts.push({ st, inst: null });
		}
	}
	ctx.augmented.timer.stop("getServiceDateDeparturesForStop:collect");

	ctx.augmented.timer.start("getServiceDateDeparturesForStop:wasm");
	const originalIndices: number[] = new Array(allTimestamps.length);
	for (let i = 0; i < allTimestamps.length; i++) originalIndices[i] = i;

	const filteredIndicesBig = filterAndSortDepartures(allTimestamps, originalIndices, windowStartAbs, windowEndAbs);
	const filteredIndices = filteredIndicesBig.map(Number);
	ctx.augmented.timer.stop("getServiceDateDeparturesForStop:wasm");

	ctx.augmented.timer.start("getServiceDateDeparturesForStop:instantiate");
	const finalResults: { st: AugmentedStopTime; inst: AugmentedTripInstance }[] = [];
	for (const idx of filteredIndices) {
		const entry = allStopsAndInsts[idx];
		const inst = getInstance(entry.st.instance_id);
		if (inst) {
			finalResults.push({ st: entry.st, inst });
		}
	}
	ctx.augmented.timer.stop("getServiceDateDeparturesForStop:instantiate");

	ctx.augmented.timer.start("getServiceDateDeparturesForStop:map");
	const sortedResults = finalResults.map(({ st, inst }) => {
		const expressString = findExpressString(
			inst.expressInfo,
			ctx,
			st.actual_parent_station_id ?? st.actual_stop_id ?? "",
		);
		return {
			...st,
			express_string: expressString,
			instance_id: inst.instance_id,
			service_capacity:
				st.service_capacity === ServiceCapacity.NOT_CALCULATED
					? getServiceCapacity(inst, st, inst.serviceDate, undefined, ctx, ctx.config)
					: st.service_capacity,
		};
	});
	ctx.augmented.timer.stop("getServiceDateDeparturesForStop:map");

	const seenInstanceIds = new Set<string>();
	const dedupedResults = sortedResults.filter((dep) => {
		if (seenInstanceIds.has(dep.instance_id)) return false;
		seenInstanceIds.add(dep.instance_id);
		return true;
	});

	ctx.augmented.timer.stop("getServiceDateDeparturesForStop");
	return dedupedResults;
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
	});
	return stop;
}
