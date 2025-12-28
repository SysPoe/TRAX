import * as cache from "../cache.js";
import { getGtfs } from "../gtfsInterfaceLayer.js";
import { findExpressString } from "./SRT.js";
import { getServiceCapacity, ServiceCapacity } from "./serviceCapacity.js";
import { AugmentedStop } from "./augmentedStop.js";
import { AugmentedStopTime } from "./augmentedStopTime.js";
import { AugmentedTripInstance } from "./augmentedTrip.js";
import { getServiceDayStart } from "./time.js";

function timeSeconds(time: string | number): number {
	if (typeof time === "number") return time;
	const [hours, minutes, seconds] = time.split(":").map(Number);
	return hours * 3600 + (minutes ?? 0) * 60 + (seconds ?? 0);
}

type DepartureResult = AugmentedStopTime & { express_string: string; instance_id: string };

export function getDeparturesForStop(
	stop: AugmentedStop,
	date: string,
	start_time: string | number,
	end_time: string | number,
	ctx: cache.CacheContext,
): DepartureResult[] {
	const startSec = timeSeconds(start_time);
	const endSec = timeSeconds(end_time);
	const parentId = stop.parent_stop_id;
	const childIds = stop.child_stop_ids;
	const validStops = new Set<string>([stop.stop_id, parentId, ...(childIds ?? [])].filter(Boolean) as string[]);
	const timer = ctx.augmented.timer;
	timer.start("getDeparturesForStop");

	const timingStart = Date.now();
	const results: { st: AugmentedStopTime; ts: number }[] = [];
	const seenStopTimes = new Set<AugmentedStopTime>();

	const baseServiceDayStart = getServiceDayStart(date, ctx.config.timezone);
	const absStart = baseServiceDayStart + startSec;
	const absEnd = baseServiceDayStart + endSec;

	// Local cache for service day starts to avoid expensive Intl.DateTimeFormat calls
	const serviceDayStartCache = new Map<string, number>();
	serviceDayStartCache.set(date, baseServiceDayStart);

	let candidateCount = 0;
	timer.start("getDeparturesForStop:search");
	for (const stopId of validStops) {
		const candidates = cache.getStopDeparturesCached(ctx, stopId, date);
		candidateCount += candidates.length;

		for (const st of candidates) {
			const time =
				st.actual_departure_time ??
				st.actual_arrival_time ??
				st.scheduled_departure_time ??
				st.scheduled_arrival_time;
			if (time === null) continue;

			let dayStart = serviceDayStartCache.get(st.service_date);
			if (dayStart === undefined) {
				dayStart = getServiceDayStart(st.service_date, ctx.config.timezone);
				serviceDayStartCache.set(st.service_date, dayStart);
			}

			const ts = time + dayStart;

			if (ts < absStart || ts > absEnd) continue;

			// Deduplicate if the same AugmentedStopTime is indexed under multiple stop IDs (e.g. parent and child)
			if (!seenStopTimes.has(st)) {
				results.push({ st, ts });
				seenStopTimes.add(st);
			}
		}
	}
	timer.stop("getDeparturesForStop:search");

	// Cache for express strings per trip and stop to avoid redundant findExpressString calls
	const expressStringCache = new Map<string, string>();

	timer.start("getDeparturesForStop:mapping");
	const finalResults = results
		.sort((a, b) => a.ts - b.ts)
		.map(({ st, ts }, index) => {
			timer.start("getDeparturesForStop:mapping:getInstance");
			const instance = cache.getAugmentedTripInstance(ctx, st.instance_id);
			timer.stop("getDeparturesForStop:mapping:getInstance");
			
			if (!instance) return null;

			const stopId = st.actual_parent_station_id ?? st.actual_stop_id ?? "";
			// Cache key includes trip ID and the stop it's departing from
			const expressCacheKey = `${instance.trip_id}-${stopId}`;
			
			let expressString = expressStringCache.get(expressCacheKey);
			if (expressString === undefined) {
				timer.start("getDeparturesForStop:mapping:expressString");
				expressString = findExpressString(instance.expressInfo, ctx, stopId);
				expressStringCache.set(expressCacheKey, expressString);
				timer.stop("getDeparturesForStop:mapping:expressString");
			}

			return {
				...st,
				express_string: expressString,
				service_capacity:
					st.service_capacity === ServiceCapacity.NOT_CALCULATED
						? getServiceCapacity(instance, st, instance.serviceDate, undefined, ctx, ctx.config)
						: st.service_capacity,
			};
		})
		.filter((v): v is NonNullable<typeof v> => v !== null);
	timer.stop("getDeparturesForStop:mapping");

	timer.stop("getDeparturesForStop");
	timer.log("Departure Lookup");

	return finalResults;
}

export function attachDeparturesHelpers(stop: AugmentedStop, ctx: cache.CacheContext): AugmentedStop {
	Object.defineProperties(stop, {
		getDepartures: {
			value: (date: string, start_time: string | number, end_time: string | number) =>
				getDeparturesForStop(stop, date, start_time, end_time, ctx),
			enumerable: false,
		}
	});
	return stop;
}
