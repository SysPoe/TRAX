import * as cache from "../cache.js";
import { getGtfs } from "../gtfsInterfaceLayer.js";
import { findExpressString } from "./SRT.js";
import { getServiceCapacity, ServiceCapacity } from "./serviceCapacity.js";
import { AugmentedStop } from "./augmentedStop.js";
import { AugmentedStopTime } from "./augmentedStopTime.js";
import { AugmentedTripInstance } from "./augmentedTrip.js";
import { getServiceDayStart } from "./time.js";

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
	const results: { st: AugmentedStopTime; inst: AugmentedTripInstance }[] = [];

	const toDate = (d: string): Date => {
		const dstr = d.padStart(8, "0");
		return new Date(dstr.slice(0, 4) + "-" + dstr.slice(4, 6) + "-" + dstr.slice(6, 8));
	};

	const baseDate = toDate(date);
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
	for (let df = daysForwardStart; df <= daysForwardEnd; df++) {
		const checkDate = new Date(baseDate);
		checkDate.setDate(checkDate.getDate() + df);
		const serviceDateStr = checkDate.toISOString().slice(0, 10).replace(/-/g, "");
		const dayStart = getServiceDayStart(serviceDateStr, ctx.config.timezone);
		const windowStart = windowStartAbs - df * 86400;
		const windowEnd = windowEndAbs - df * 86400;

		for (const stopId of validStops) {
			const stopDepartures = cache.getStopDeparturesCached(ctx, stopId, serviceDateStr);
			for (const st of stopDepartures) {
				const timeSecs = st.actual_departure_time ?? st.actual_arrival_time ?? st.scheduled_departure_time ?? 0;
				const absTs = dayStart + timeSecs;
				if (absTs < windowStart || absTs > windowEnd) continue;
				const inst = getInstance(st.instance_id);
				if (!inst) continue;
				results.push({ st, inst });
			}
		}
	}
	ctx.augmented.timer.stop("getDeparturesForStop:collect");

	ctx.augmented.timer.start("getDeparturesForStop:sortAndMap");
	const sortedResults = results
		.sort((a, b) => (a.st.actual_departure_time ?? 0) - (b.st.actual_departure_time ?? 0))
		.map(({ st, inst }) => {
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
	ctx.augmented.timer.stop("getDeparturesForStop:sortAndMap");

	ctx.augmented.timer.stop("getDeparturesForStop");
	return sortedResults;
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
	for (const stopId of validStops) {
		const stopDepartures = cache.getStopDeparturesCached(ctx, stopId, serviceDate);
		for (const st of stopDepartures) {
			const timeSecs = st.actual_departure_time ?? st.actual_arrival_time ?? st.scheduled_departure_time ?? 0;
			const absTs = dayStart + timeSecs;
			if (absTs < windowStartAbs || absTs > windowEndAbs) continue;
			const inst = getInstance(st.instance_id);
			if (!inst) continue;
			results.push({ st, inst });
		}
	}
	ctx.augmented.timer.stop("getServiceDateDeparturesForStop:collect");

	ctx.augmented.timer.start("getServiceDateDeparturesForStop:sortAndMap");
	const sortedResults = results
		.sort((a, b) => (a.st.actual_departure_time ?? 0) - (b.st.actual_departure_time ?? 0))
		.map(({ st, inst }) => {
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
	ctx.augmented.timer.stop("getServiceDateDeparturesForStop:sortAndMap");

	ctx.augmented.timer.stop("getServiceDateDeparturesForStop");
	return sortedResults;
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
