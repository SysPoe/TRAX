import * as cache from "../cache.js";
import { getGtfs } from "../gtfsInterfaceLayer.js";
import { findExpressString } from "./SRT.js";
import { getServiceCapacity } from "./serviceCapacity.js";
import { AugmentedStop } from "./augmentedStop.js";
import { AugmentedStopTime } from "./augmentedStopTime.js";
import { AugmentedTripInstance } from "./augmentedTrip.js";

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
	ctx?: cache.CacheContext,
): DepartureResult[] {
	const startSec = timeSeconds(start_time);
	const endSec = timeSeconds(end_time);
	const parentId = stop.parent_stop_id;
	const childIds = stop.child_stop_ids;
	const validStops = new Set<string>([stop.stop_id, parentId, ...childIds].filter(Boolean) as string[]);
	const tripCache = new Map<string, ReturnType<typeof cache.getAugmentedTrips>[0]>();
	const results: { st: AugmentedStopTime; inst: AugmentedTripInstance }[] = [];

	const daysForwardStart = Math.floor(startSec / 86400);
	const daysForwardEnd = Math.floor(endSec / 86400);

	const toDate = (d: string): Date => {
		const dstr = d.padStart(8, "0");
		return new Date(dstr.slice(0, 4) + "-" + dstr.slice(4, 6) + "-" + dstr.slice(6, 8));
	};

	const getMatchingTripDate = (tripDates: string[]): string | null => {
		for (let df = daysForwardStart; df <= daysForwardEnd; df++) {
			const checkDate = toDate(date);
			checkDate.setDate(checkDate.getDate() + df);
			const checkDateNum = checkDate.toISOString().slice(0, 10).replace(/-/g, "");
			if (tripDates.includes(checkDateNum)) return checkDateNum;
		}
		return null;
	};

	// Query static GTFS for stop times at this station (optimized)
	const rawStopTimes = Array.from(validStops).flatMap((id) => getGtfs().queryStopTimes({ stop_id: id }));
	const passingTrips = Array.from(validStops).flatMap((id) => cache.getPassingTrips(id, ctx));
	const allTripIds = new Set([...rawStopTimes.map((st) => st.trip_id), ...passingTrips]);

	for (const tripId of allTripIds) {
		let trip = tripCache.get(tripId);
		if (!trip) {
			const trips = cache.getAugmentedTrips(tripId, ctx);
			if (trips.length > 0) {
				trip = trips[0];
				tripCache.set(tripId, trip);
			}
		}
		if (!trip) continue;

		for (const instance of trip.instances) {
			const matchingStopTimes = instance.stopTimes.filter(
				(s) => s.actual_stop_id && validStops.has(s.actual_stop_id),
			);

			for (const st of matchingStopTimes) {
				const matchingDate = getMatchingTripDate(
					(st?.actual_departure_dates ?? []).concat(st?.actual_arrival_dates ?? []),
				);
				if (matchingDate === null) continue;

				const ts =
					(st.actual_departure_time ?? st.actual_arrival_time ?? 0) +
					(toDate(matchingDate).getTime() - toDate(date).getTime()) / 1000;
				if (ts == null || ts < startSec || ts > endSec) continue;

				results.push({ st, inst: instance });
			}
		}
	}

	return results
		.sort((a, b) => (a.st.actual_departure_time ?? 0) - (b.st.actual_departure_time ?? 0))
		.map(({ st, inst }) => {
			const expressString = findExpressString(
				inst.expressInfo,
				st.actual_parent_station_id ?? st.actual_stop_id ?? "",
			);
			return {
				...st,
				express_string: expressString,
				instance_id: inst.instance_id,
				service_capacity:
					st.service_capacity === null
						? getServiceCapacity(inst, st, inst.serviceDate, undefined, ctx)
						: st.service_capacity,
			};
		});
}

export function getServiceDateDeparturesForStop(
	stop: AugmentedStop,
	serviceDate: string,
	start_time_secs: number,
	end_time_secs: number,
	ctx?: cache.CacheContext,
): DepartureResult[] {
	const parentId = stop.parent_stop_id;
	const childIds = stop.child_stop_ids;
	const validStops = new Set<string>([stop.stop_id, parentId, ...childIds].filter(Boolean) as string[]);
	const tripCache = new Map<string, ReturnType<typeof cache.getAugmentedTrips>[0]>();
	const results: { st: AugmentedStopTime; inst: AugmentedTripInstance }[] = [];

	const rawStopTimes = Array.from(validStops).flatMap((id) => getGtfs().queryStopTimes({ stop_id: id }));
	const passingTrips = Array.from(validStops).flatMap((id) => cache.getPassingTrips(id, ctx));
	const allTripIds = new Set([...rawStopTimes.map((st) => st.trip_id), ...passingTrips]);

	for (const tripId of allTripIds) {
		let trip = tripCache.get(tripId);
		if (!trip) {
			const trips = cache.getAugmentedTrips(tripId, ctx);
			if (trips.length > 0) {
				trip = trips[0];
				tripCache.set(tripId, trip);
			}
		}
		if (!trip) continue;

		if (!trip?.scheduledStartServiceDates?.includes(serviceDate)) continue;

		for (const instance of trip.instances) {
			if (instance.serviceDate !== serviceDate) continue;

			const matchingStopTimes = instance.stopTimes.filter(
				(s) => s.actual_stop_id && validStops.has(s.actual_stop_id),
			);

			for (const st of matchingStopTimes) {
				const ts = st.actual_departure_time;
				if (ts == null || ts < start_time_secs || ts > end_time_secs) continue;
				results.push({ st, inst: instance });
			}
		}
	}
	return results
		.sort((a, b) => (a.st.actual_departure_time ?? 0) - (b.st.actual_departure_time ?? 0))
		.map(({ st, inst }) => {
			const expressString = findExpressString(
				inst.expressInfo,
				st.actual_parent_station_id ?? st.actual_stop_id ?? "",
			);
			return {
				...st,
				express_string: expressString,
				instance_id: inst.instance_id,
				service_capacity:
					st.service_capacity === null
						? getServiceCapacity(inst, st, inst.serviceDate, undefined, ctx)
						: st.service_capacity,
			};
		});
}

export function attachDeparturesHelpers(stop: AugmentedStop, ctx?: cache.CacheContext): AugmentedStop {
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
