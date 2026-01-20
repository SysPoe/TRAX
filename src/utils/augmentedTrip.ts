import * as qdf from "qdf-gtfs";
import { getServiceDatesByTrip } from "./calendar.js";
import { AugmentedStopTime, augmentStopTimes } from "./augmentedStopTime.js";
import * as cache from "../cache.js";
import { getServiceCapacity, ServiceCapacity } from "./serviceCapacity.js";
import { ExpressInfo, findExpress } from "./SRT.js";

export type AugmentedTripInstance = qdf.Trip & {
	instance_id: string;
	trip_id: string;
	serviceDate: string;
	schedule_relationship: qdf.TripScheduleRelationship;
	stopTimes: AugmentedStopTime[];
	realtime_update: qdf.RealtimeTripUpdate | null;
	expressInfo: ExpressInfo[];
	run: string;
	vehicle_model: string | null;
	vehicle_id: string | null;
	vehicle_details?: any | null;
	passenger_cars: number | null;
	scheduled_passenger_cars: number | null;
	consist: string[] | null;

	scheduledTripDates: string[];
	actualTripDates: string[];

	runSeries: string | null;

	rt_start_date: string | null;
};

export type AugmentedTrip = qdf.Trip & {
	scheduledStartServiceDates: string[];
	instances: AugmentedTripInstance[];
};

export type RunSeries = {
	trips: {
		trip_start_time: number;
		trip_id: string;
		run: string;
	}[];
	vehicle_sightings: string[];
	series: string;
	date: string;
};

export function augmentTrip(trip: qdf.Trip, ctx: cache.CacheContext): AugmentedTrip {
	ctx.augmented.timer.start("augmentTrip");
	const serviceDates = getServiceDatesByTrip(trip.trip_id, ctx);

	ctx.augmented.timer.start("augmentTrip:getRawStopTimes");
	const rawStopTimes = cache.getRawStopTimes(ctx, trip.trip_id).sort((a, b) => a.stop_sequence - b.stop_sequence);
	ctx.augmented.timer.stop("augmentTrip:getRawStopTimes");

	ctx.augmented.timer.start("augmentTrip:getParentStops");
	const getParentStationId = (stopId: string): string => {
		const cached = ctx.augmented.stopsRec.get(stopId);
		if (cached) return cached.parent_stop_id ?? "";
		const aug = cache.getAugmentedStops(ctx, stopId)[0];
		return aug?.parent_stop_id ?? "";
	};

	let parentStops = rawStopTimes.map((st) => getParentStationId(st.stop_id));
	ctx.augmented.timer.stop("augmentTrip:getParentStops");

	ctx.augmented.timer.start("augmentTrip:findExpress");
	let expressInfo = findExpress(
		parentStops.filter((id): id is string => !!id),
		ctx,
	);
	ctx.augmented.timer.stop("augmentTrip:findExpress");

	ctx.augmented.timer.start("augmentTrip:getTripUpdates");
	const updates = cache.getTripUpdates(ctx, trip.trip_id);
	ctx.augmented.timer.stop("augmentTrip:getTripUpdates");

	const createInstance = (
		serviceDate: string,
		update: qdf.RealtimeTripUpdate | null,
		scheduleRelationship: qdf.TripScheduleRelationship,
	): AugmentedTripInstance => {
		ctx.augmented.timer.start("createInstance");
		const startDate = update?.trip.start_date ?? serviceDate;
		const startTime = update?.trip.start_time ?? "";

		const instance_id = btoa(JSON.stringify([trip.trip_id, startDate, startTime, scheduleRelationship]));

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
				if (singleDate === serviceDate) return (type === "scheduled" ? scheduled_dates : actual_dates) ?? [singleDate];
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

		const instance: AugmentedTripInstance = {
			...trip,
			instance_id,
			serviceDate,
			schedule_relationship: scheduleRelationship,
			stopTimes,
			realtime_update: update,
			expressInfo,
			run: trip.trip_id.slice(-4),
			vehicle_model: null,
			vehicle_id: null,
			passenger_cars: null,
			scheduled_passenger_cars: null,
			consist: null,
			scheduledTripDates,
			actualTripDates,
			runSeries: null,
			rt_start_date: update?.trip.start_date ?? null,
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

const RS_TOLERATE_SECS = 30 * 60;

function trackBackwards(instance: AugmentedTripInstance, ctx: cache.CacheContext): string {
	if (!ctx.gtfs) throw new Error("GTFS not initialized!");
	let run = instance.run;
	let prevInstances: AugmentedTripInstance[] = [instance];
	let currentInstance = instance;

	const serviceDate = currentInstance.serviceDate;

	for (let _break = 0; _break < 100; _break++) {
		if (currentInstance.stopTimes.length === 0) break;
		let st = currentInstance.stopTimes[0];

		const time = st.scheduled_departure_time ?? st.scheduled_arrival_time;
		if (time === null) break;

		if ((time ?? 0) < RS_TOLERATE_SECS) break;

		let deps_ids = ctx.gtfs.getStopTimes({
			stop_id: st.scheduled_stop_id ?? undefined,
			date: serviceDate.toString(),
			start_time: (time ?? 0) - RS_TOLERATE_SECS,
			end_time: time ?? 0,
		});

		let candidateInstances: AugmentedTripInstance[] = [];
		for (const d of deps_ids) {
			const trips = cache.getAugmentedTrips(ctx, d.trip_id);
			if (!trips.length) continue;
			const t = trips[0];
			const inst = t.instances.find(
				(i) =>
					i.serviceDate === serviceDate && i.schedule_relationship === qdf.TripScheduleRelationship.SCHEDULED,
			);
			if (inst) candidateInstances.push(inst);
		}

		let deps = candidateInstances
			.map((inst) => inst.stopTimes.find((v) => v.scheduled_stop_id === st.scheduled_stop_id))
			.filter((v): v is AugmentedStopTime => !!v);

		deps = deps.filter((v) => v.trip_id.slice(-4)[0] == run[0] && v.trip_id.slice(-4) != run);

		deps = deps.sort(
			(a, b) =>
				(a.scheduled_departure_time ?? a.scheduled_arrival_time ?? Infinity) -
				(b.scheduled_departure_time ?? b.scheduled_arrival_time ?? Infinity),
		);

		if (deps.length === 0) break;

		const bestMatchStopTime = deps.at(-1);
		if (!bestMatchStopTime) break;

		const matchTrip = cache.getAugmentedTrips(ctx, bestMatchStopTime.trip_id)[0];
		const matchInstance = matchTrip.instances.find((i) => i.serviceDate === serviceDate);

		if (!matchInstance) break;
		if (bestMatchStopTime._stopTime?.stop_sequence != matchInstance.stopTimes.at(-1)?._stopTime?.stop_sequence)
			break;

		prevInstances.push(matchInstance);
		run = matchInstance.run;
		currentInstance = matchInstance;
	}

	let rs = cache.getRunSeries(ctx, serviceDate, run, false);
	for (const prevInst of prevInstances) {
		prevInst.runSeries = run;
		if (!rs.trips.some((v) => v.trip_id === prevInst.trip_id))
			rs.trips = [
				{
					trip_id: prevInst.trip_id,
					trip_start_time:
						prevInst.stopTimes[0].scheduled_departure_time ??
						prevInst.stopTimes[0].scheduled_arrival_time ??
						0,
					run: prevInst.run,
				},
				...rs.trips,
			];
	}
	cache.setRunSeries(serviceDate, run, rs, ctx);
	return run;
}

function trackForwards(instance: AugmentedTripInstance, runSeries: string, ctx: cache.CacheContext): void {
	if (!ctx.gtfs) throw new Error("GTFS not initialized!");
	let run = instance.run;
	const serviceDate = instance.serviceDate;

	let rs = cache.getRunSeries(ctx, serviceDate, runSeries, false);
	let currentInstance = instance;

	for (let _break = 0; _break < 100; _break++) {
		if (currentInstance.stopTimes.length === 0) break;
		let st = currentInstance.stopTimes.at(-1) as AugmentedStopTime;
		const time = st.scheduled_departure_time ?? st.scheduled_arrival_time;
		if (time === null) break;

		let deps_ids = ctx.gtfs.getStopTimes({
			stop_id: st.scheduled_stop_id ?? undefined,
			date: serviceDate.toString(),
			start_time: time ?? 0,
			end_time: (time ?? 0) + RS_TOLERATE_SECS,
		});

		let candidateInstances: AugmentedTripInstance[] = [];
		for (const d of deps_ids) {
			const trips = cache.getAugmentedTrips(ctx, d.trip_id);
			if (!trips.length) continue;
			const inst = trips[0].instances.find(
				(i) =>
					i.serviceDate === serviceDate && i.schedule_relationship === qdf.TripScheduleRelationship.SCHEDULED,
			);
			if (inst) candidateInstances.push(inst);
		}

		let deps = candidateInstances
			.map((inst) => inst.stopTimes.find((v) => v.scheduled_stop_id === st.scheduled_stop_id))
			.filter((v): v is AugmentedStopTime => !!v);

		deps = deps.filter((v) => v.trip_id.slice(-4)[0] == run[0] && v.trip_id.slice(-4) != run);

		deps = deps.sort(
			(a, b) =>
				(a.scheduled_departure_time ?? a.scheduled_arrival_time ?? Infinity) -
				(b.scheduled_departure_time ?? b.scheduled_arrival_time ?? Infinity),
		);

		if (deps.length === 0) break;

		const bestMatchStopTime = deps[0];
		const matchTrip = cache.getAugmentedTrips(ctx, bestMatchStopTime.trip_id)[0];
		const matchInstance = matchTrip.instances.find((i) => i.serviceDate === serviceDate);

		if (!matchInstance) break;
		if (bestMatchStopTime._stopTime?.stop_sequence != 1) break;

		matchInstance.runSeries = runSeries;
		run = matchInstance.run;

		if (!rs.trips.some((v) => v.trip_id === matchInstance.trip_id))
			rs.trips.push({
				trip_id: matchInstance.trip_id,
				trip_start_time:
					matchInstance.stopTimes[0].scheduled_departure_time ??
					matchInstance.stopTimes[0].scheduled_arrival_time ??
					0,
				run,
			});

		currentInstance = matchInstance;
	}
	cache.setRunSeries(serviceDate, runSeries, rs, ctx);
}

export function calculateRunSeries(instance: AugmentedTripInstance, ctx: cache.CacheContext): void {
	if (instance.runSeries != null) return;
	let runSeries = trackBackwards(instance, ctx);
	trackForwards(instance, runSeries, ctx);
}
