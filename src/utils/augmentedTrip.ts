import * as qdf from "qdf-gtfs";
import { getServiceDatesByTrip } from "./calendar.js";
import { AugmentedStopTime, augmentStopTimes } from "./augmentedStopTime.js";
import * as cache from "../cache/index.js";
import { getServiceCapacity, ServiceCapacity } from "./serviceCapacity.js";
import { ExpressInfo, findExpress } from "./SRT.js";
import { isRegion } from "../config.js";
import { getToday } from "./time.js";

export type AugmentedTripInstance = qdf.Trip & {
	instance_id: string;
	trip_id: string;
	serviceDate: string;
	schedule_relationship: qdf.TripScheduleRelationship;
	stopTimes: AugmentedStopTime[];
	realtime_update: qdf.RealtimeTripUpdate | null;
	expressInfo: ExpressInfo[];
	vehicle_model: string | null;
	vehicle_id: string | null;
	vehicle_details?: unknown | null;
	_seq_direction_data?: { centralIndex: number; romaIndex: number; firstCityIndex: number } | null;
	passenger_cars: number | null;
	scheduled_passenger_cars: number | null;
	consist: string[] | null;

	scheduledTripDates: string[];
	actualTripDates: string[];

	trip_number: string;

	rt_start_date: string | null;

	/** AU/SEQ diagram (same vehicle / line-of-route block), static + realtime validity */
	seq_diagram_prev_trip_id: string | null;
	seq_diagram_next_trip_id: string | null;
	/** Inferred diagram block id (string; same type as GTFS `trips.block_id`). */
	seq_diagram_block_id: string | null;
	seq_diagram_prev_instance_id: string | null;
	seq_diagram_next_instance_id: string | null;
	seq_diagram_prev_link_broken: boolean;
	seq_diagram_next_link_broken: boolean;
};

export type AugmentedTrip = qdf.Trip & {
	scheduledStartServiceDates: string[];
	instances: AugmentedTripInstance[];
};

export type RunSeries = {
	series: string;
	date: string;
	trips: string[];
	vehicle_sightings: { vehicle_id: string; trip_id: string }[];
};

function dateToEpochDays(ymd: number | string): number {
	const ymdStr = ymd.toString();
	let y = Number.parseInt(ymdStr.slice(0, 4));
	let m = Number.parseInt(ymdStr.slice(4, 6));
	let d = Number.parseInt(ymdStr.slice(6, 8));
	m = (m + 9) % 12;
	y = y - Math.floor(m / 10);
	return (
		365 * y +
		Math.floor(y / 4) -
		Math.floor(y / 100) +
		Math.floor(y / 400) +
		Math.floor((m * 306 + 5) / 10) +
		(d - 1)
	);
}

export function augmentTrip(
	trip: qdf.Trip,
	ctx: cache.CacheContext,
	tripUpdatesCache?: Map<string, qdf.RealtimeTripUpdate[]>,
): AugmentedTrip {
	ctx.augmented.timer.start("augmentTrip");
	const todayEpoch = dateToEpochDays(getToday(ctx.config));
	const serviceDates = getServiceDatesByTrip(trip.trip_id, ctx, todayEpoch - 15, todayEpoch + 60);

	ctx.augmented.timer.start("augmentTrip:getRawStopTimes");
	const rawStopTimes = cache.getRawStopTimes(ctx, trip.trip_id).sort((a, b) => a.stop_sequence - b.stop_sequence);
	ctx.augmented.timer.stop("augmentTrip:getRawStopTimes");

	ctx.augmented.timer.start("augmentTrip:getParentStops");
	const parentStops = new Array<string>(rawStopTimes.length);
	const stopsRec = ctx.augmented.stopsRec;
	for (let i = 0; i < rawStopTimes.length; i++) {
		const cached = stopsRec.get(rawStopTimes[i].stop_id);
		parentStops[i] = cached?.parent_stop_id ?? "";
	}
	ctx.augmented.timer.stop("augmentTrip:getParentStops");

	ctx.augmented.timer.start("augmentTrip:findExpress");
	const parentStopSignature = parentStops.join("|");
	let expressInfo = ctx.augmented.expressInfoCache.get(parentStopSignature);
	if (!expressInfo) {
		expressInfo = findExpress(
			parentStops.filter((id): id is string => !!id),
			ctx,
		);
		ctx.augmented.expressInfoCache.set(parentStopSignature, expressInfo);
	}
	ctx.augmented.timer.stop("augmentTrip:findExpress");

	ctx.augmented.timer.start("augmentTrip:getTripUpdates");
	const updates = tripUpdatesCache
		? (tripUpdatesCache.get(trip.trip_id) ?? [])
		: cache.getTripUpdates(ctx, trip.trip_id);
	ctx.augmented.timer.stop("augmentTrip:getTripUpdates");

	const createInstance = (
		serviceDate: string,
		update: qdf.RealtimeTripUpdate | null,
		scheduleRelationship: qdf.TripScheduleRelationship,
	): AugmentedTripInstance => {
		ctx.augmented.timer.start("createInstance");
		const startDate = update?.trip.start_date ?? serviceDate;
		const startTime = update?.trip.start_time ?? "";

		const instance_id = btoa(JSON.stringify([trip.trip_id, startDate, startTime]));

		ctx.augmented.timer.start("createInstance:augmentStopTimes");
		const stopTimes = augmentStopTimes(
			scheduleRelationship === qdf.TripScheduleRelationship.ADDED ||
				scheduleRelationship === qdf.TripScheduleRelationship.UNSCHEDULED
				? null
				: rawStopTimes,
			{
				serviceDate,
				tripUpdate: update,
				scheduleRelationship,
			},
			ctx,
		);
		ctx.augmented.timer.stop("createInstance:augmentStopTimes");

		ctx.augmented.timer.start("createInstance:calculateTripDates");
		const getUniqueDates = (times: AugmentedStopTime[], type: "scheduled" | "actual") => {
			const dates = new Set<string>();
			for (let i = 0; i < times.length; i++) {
				const st = times[i];
				const arr = type === "scheduled" ? st.scheduled_arrival_dates : st.actual_arrival_dates;
				const dep = type === "scheduled" ? st.scheduled_departure_dates : st.actual_departure_dates;
				if (arr) for (let j = 0; j < arr.length; j++) dates.add(arr[j]);
				if (dep) for (let j = 0; j < dep.length; j++) dates.add(dep[j]);
			}
			if (dates.size === 1) {
				const singleDate = dates.values().next().value as string;
				if (singleDate === serviceDate)
					return (type === "scheduled" ? scheduled_dates : actual_dates) ?? [singleDate];
				return [singleDate];
			}
			return Array.from(dates).sort((a, b) => Number.parseInt(a) - Number.parseInt(b));
		};

		// Common case pre-check to avoid Set creation
		let scheduled_dates: string[] | null = null;
		let actual_dates: string[] | null = null;

		const scheduledTripDates = getUniqueDates(stopTimes, "scheduled");
		const actualTripDates = getUniqueDates(stopTimes, "actual");
		ctx.augmented.timer.stop("createInstance:calculateTripDates");

		let trip_number = "";

		if (isRegion(ctx.config.region, "CA")) {
			trip_number = trip.trip_id.slice(-4);
			if (trip.trip_short_name && /^\d{1,3}$/.test(trip.trip_short_name)) trip_number = trip.trip_short_name; // VIA rail
		} else {
			trip_number = trip.trip_id.slice(-4);
		}

		const instance: AugmentedTripInstance = {
			...trip,
			instance_id,
			serviceDate,
			schedule_relationship: scheduleRelationship,
			stopTimes,
			realtime_update: update,
			expressInfo,
			trip_number,
			vehicle_model: null,
			vehicle_id: null,
			passenger_cars: null,
			scheduled_passenger_cars: null,
			consist: null,
			scheduledTripDates,
			actualTripDates,
			rt_start_date: update?.trip.start_date ?? null,
			seq_diagram_prev_trip_id: null,
			seq_diagram_next_trip_id: null,
			seq_diagram_block_id: null,
			seq_diagram_prev_instance_id: null,
			seq_diagram_next_instance_id: null,
			seq_diagram_prev_link_broken: false,
			seq_diagram_next_link_broken: false,
		};

		ctx.augmented.timer.start("createInstance:serviceCapacity");
		let prev_cap: ServiceCapacity = ServiceCapacity.UNKNOWN;

		for (let i = 0; i < instance.stopTimes.length; i++) {
			const st = instance.stopTimes[i];
			if (!st.passing) {
				st.service_capacity = getServiceCapacity(instance, st, serviceDate, undefined, ctx, ctx.config);
				if (st.service_capacity !== ServiceCapacity.NOT_CALCULATED) prev_cap = st.service_capacity;
				else st.service_capacity = prev_cap;
			}

			st.instance_id = instance.instance_id;
			st.service_date = instance.serviceDate;
			st.schedule_relationship = instance.schedule_relationship;
		}
		ctx.augmented.timer.stop("createInstance:serviceCapacity");

		ctx.augmented.timer.stop("createInstance");
		return instance;
	};

	ctx.augmented.timer.start("augmentTrip:createInstances");
	const instances: AugmentedTripInstance[] = [];
	const coveredServiceDates = new Set<string>();

	for (const update of updates) {
		const rel = update.trip.schedule_relationship;
		const startDate = update.trip.start_date;

		if (!startDate) continue;

		if (rel === qdf.TripScheduleRelationship.SCHEDULED) {
			coveredServiceDates.add(startDate);
			instances.push(createInstance(startDate, update, rel));
		} else if (rel === qdf.TripScheduleRelationship.UNSCHEDULED) {
			instances.push(createInstance(startDate, update, rel));
		} else if (rel === qdf.TripScheduleRelationship.CANCELED) {
			coveredServiceDates.add(startDate);
			instances.push(createInstance(startDate, update, rel));
		} else if (rel === qdf.TripScheduleRelationship.REPLACEMENT || rel === qdf.TripScheduleRelationship.ADDED) {
			coveredServiceDates.add(startDate);
			instances.push(createInstance(startDate, update, rel));
		}
	}

	for (const sDate of serviceDates) {
		if (!coveredServiceDates.has(sDate)) {
			instances.push(createInstance(sDate, null, qdf.TripScheduleRelationship.SCHEDULED));
		}
	}
	ctx.augmented.timer.stop("augmentTrip:createInstances");

	const augmentedTrip: AugmentedTrip = {
		...trip,
		scheduledStartServiceDates: serviceDates,
		instances,
	};

	ctx.augmented.timer.stop("augmentTrip");
	return augmentedTrip;
}

export function calculateRunSeries(instance: AugmentedTripInstance, ctx: cache.CacheContext): RunSeries {
	const seriesRaw = instance.trip_number || instance.trip_id.slice(-4);
	const series = seriesRaw.toUpperCase();
	const vehicle_sightings: { vehicle_id: string; trip_id: string }[] = [];
	if (instance.vehicle_id) vehicle_sightings.push({ vehicle_id: instance.vehicle_id, trip_id: instance.trip_id });
	if (instance.consist) {
		for (const carId of instance.consist) {
			vehicle_sightings.push({ vehicle_id: carId, trip_id: instance.trip_id });
		}
	}
	const runSeries: RunSeries = {
		series,
		date: instance.serviceDate,
		trips: [instance.trip_id],
		vehicle_sightings,
	};
	cache.setRunSeries(instance.serviceDate, series, runSeries, ctx);
	return runSeries;
}
