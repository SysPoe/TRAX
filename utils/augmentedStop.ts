import type * as qdf from "qdf-gtfs";
import * as cache from "../cache.js";
import { AugmentedStopTime } from "./augmentedStopTime.js";
import { getAugmentedTrips, getPassingTrips } from "../cache.js";
import { findExpressString } from "./express.js";
import { getGtfs } from "../gtfsInterfaceLayer.js";

export type AugmentedStop = qdf.Stop & {
	qrt_Place: boolean;
	qrt_PlaceCode?: string;
	parent: AugmentedStop | null;
	children: AugmentedStop[];
	getDepartures: (
		date: string,
		start_time: string,
		end_time: string,
	) => (AugmentedStopTime & { express_string: string })[];
	_getSDDepartures: (
		serviceDate: string,
		start_time_secs: number,
		end_time_secs: number,
	) => (AugmentedStopTime & { express_string: string })[];
	toSerializable: () => SerializableAugmentedStop;
};

export type SerializableAugmentedStop = qdf.Stop & {
	qrt_Place: boolean;
	qrt_PlaceCode?: string;
	parent: string | null;
	children: string[];
};

export function toSerializableAugmentedStop(
	stop: Omit<AugmentedStop, "toSerializable" | "getDepartures" | "_getSDDepartures">,
): SerializableAugmentedStop {
	return {
		...stop,
		parent: stop.parent_station ?? null,
		children: stop.children.map((child) => child.stop_id),
	};
}

export function augmentStop(stop: qdf.Stop, ctx?: cache.CacheContext): AugmentedStop {
	// Cache children lookup to avoid repeated expensive operations
	let cachedChildren: AugmentedStop[] | null = null;

	const getChildren = (): AugmentedStop[] => {
		if (cachedChildren) return cachedChildren;

		const childStops = cache.getRawStops(undefined, ctx).filter((s) => s.parent_station === stop.stop_id);
		cachedChildren = childStops.map((s) => cache.getAugmentedStops(s.stop_id, ctx)[0] || augmentStop(s, ctx));
		return cachedChildren;
	};

	let qrt_Places = cache.getQRTPlaces(ctx);
	let trimmedStopName = stop.stop_name?.toLowerCase().replace("station", "").trim();
	let myPlace = qrt_Places.find(
		(v) =>
			v.Title?.toLowerCase().trim() === trimmedStopName ||
			(trimmedStopName === "roma street" && v.Title?.toLowerCase().trim().includes("roma street")),
	);

	const getParent = (): AugmentedStop | null => {
		if (!stop.parent_station) return null;
		return cache.getAugmentedStops(stop.parent_station, ctx)[0];
	};

	return {
		...stop,
		qrt_Place: !!myPlace,
		qrt_PlaceCode: myPlace?.qrt_PlaceCode,
		get parent(): AugmentedStop | null {
			return getParent();
		},
		get children(): AugmentedStop[] {
			return getChildren();
		},
		toSerializable() {
			return toSerializableAugmentedStop({
				...stop,
				qrt_Place: !!myPlace,
				qrt_PlaceCode: myPlace?.qrt_PlaceCode,
				get parent(): AugmentedStop | null {
					return getParent();
				},
				get children(): AugmentedStop[] {
					return getChildren();
				},
			});
		},
		getDepartures: (date: string, start_time: string, end_time: string) => {
			const startSec = timeSeconds(start_time);
			const endSec = timeSeconds(end_time);
			const parentId = getParent()?.stop_id;
			const childIds = getChildren().map((c) => c.stop_id);
			const validStops = new Set<string>([stop.stop_id, parentId, ...childIds].filter(Boolean) as string[]);
			const tripCache = new Map<string, ReturnType<typeof getAugmentedTrips>[0]>();
			const results: { st: AugmentedStopTime; trip: any }[] = [];

			let daysForwardStart = Math.floor(startSec / 86400);
			let daysForwardEnd = Math.floor(endSec / 86400);

			let toDate: (d: string) => Date = (d) => {
				let dstr = d.padStart(8, "0");
				return new Date(dstr.slice(0, 4) + "-" + dstr.slice(4, 6) + "-" + dstr.slice(6, 8));
			};

			let getMatchingTripDate: (tripDates: string[]) => string | null = (tripDates) => {
				for (let df = daysForwardStart; df <= daysForwardEnd; df++) {
					let checkDate = toDate(date);
					checkDate.setDate(checkDate.getDate() + df);
					let checkDateNum = checkDate.toISOString().slice(0, 10).replace(/-/g, "");
					if (tripDates.includes(checkDateNum)) return checkDateNum;
				}
				return null;
			};

			// Query static GTFS for stop times at this station (optimized)
			const rawStopTimes = Array.from(validStops).flatMap((id) => getGtfs().queryStopTimes({ stop_id: id }));
			const passingTrips = Array.from(validStops).flatMap((id) => getPassingTrips(id, ctx));
			const allTripIds = new Set([...rawStopTimes.map((st) => st.trip_id), ...passingTrips]);

			for (const tripId of allTripIds) {
				// 1. Resolve Trip
				let trip = tripCache.get(tripId);
				if (!trip) {
					const trips = getAugmentedTrips(tripId, ctx);
					if (trips.length > 0) {
						trip = trips[0];
						tripCache.set(tripId, trip);
					}
				}
				if (!trip) continue;

				// 2. Resolve Augmented Stop Time
				// We need to find all stop times for this trip that match one of our valid stops
				// This handles loops where a trip visits the station multiple times
				const matchingStopTimes = trip.stopTimes.filter(
					(s) => s.actual_stop && validStops.has(s.actual_stop.stop_id),
				);

				for (const st of matchingStopTimes) {
					// 4. Date Logic
					let matchingDate = getMatchingTripDate(
						(st?.actual_departure_dates || []).concat(st?.actual_arrival_dates || []),
					);
					if (matchingDate === null) continue;

					// 5. Time Logic
					const ts =
						(st.actual_departure_time ?? st.actual_arrival_time ?? 0) +
						(toDate(matchingDate).getTime() - toDate(date).getTime()) / 1000;
					if (ts == null || ts < startSec || ts > endSec) continue;

					results.push({ st, trip });
				}
			}
			return results
				.sort((a, b) => (a.st.actual_departure_time ?? 0) - (b.st.actual_departure_time ?? 0))
				.map(({ st, trip }) => {
					const expressString = findExpressString(
						trip.expressInfo,
						st.actual_parent_station?.stop_id ||
							st.actual_stop?.parent_station ||
							st.actual_stop?.stop_id ||
							"",
					);
					return {
						...st,
						express_string: expressString,
					};
				});
		},
		_getSDDepartures: (serviceDate: string, start_time_secs: number, end_time_secs: number) => {
			const parentId = getParent()?.stop_id;
			const childIds = getChildren().map((c) => c.stop_id);
			const validStops = new Set<string>([stop.stop_id, parentId, ...childIds].filter(Boolean) as string[]);
			const tripCache = new Map<string, ReturnType<typeof getAugmentedTrips>[0]>();
			const results: { st: AugmentedStopTime; trip: any }[] = [];

			// Query static GTFS for stop times at this station (optimized)
			const rawStopTimes = Array.from(validStops).flatMap((id) => getGtfs().queryStopTimes({ stop_id: id }));
			const passingTrips = Array.from(validStops).flatMap((id) => getPassingTrips(id, ctx));
			const allTripIds = new Set([...rawStopTimes.map((st) => st.trip_id), ...passingTrips]);

			for (const tripId of allTripIds) {
				let trip = tripCache.get(tripId);
				if (!trip) {
					const trips = getAugmentedTrips(tripId, ctx);
					if (trips.length > 0) {
						trip = trips[0];
						tripCache.set(tripId, trip);
					}
				}
				if (!trip) continue;

				if (!trip?.scheduledStartServiceDates?.includes(serviceDate)) continue;

				// Resolve Augmented Stop Time
				const matchingStopTimes = trip.stopTimes.filter(
					(s) => s.actual_stop && validStops.has(s.actual_stop.stop_id),
				);

				for (const st of matchingStopTimes) {
					const ts = st.actual_departure_time;
					if (ts == null || ts < start_time_secs || ts > end_time_secs) continue;
					results.push({ st, trip });
				}
			}
			return results
				.sort((a, b) => (a.st.actual_departure_time ?? 0) - (b.st.actual_departure_time ?? 0))
				.map(({ st, trip }) => {
					const expressString = findExpressString(
						trip.expressInfo,
						st.actual_parent_station?.stop_id ||
							st.actual_stop?.parent_station ||
							st.actual_stop?.stop_id ||
							"",
					);
					return {
						...st,
						express_string: expressString,
					};
				});
		},
	};
}

function timeSeconds(time: string): number {
	const [hours, minutes, seconds] = time.split(":").map(Number);
	return hours * 3600 + minutes * 60 + seconds;
}
