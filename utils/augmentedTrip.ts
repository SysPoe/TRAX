import * as qdf from "qdf-gtfs";
import { getServiceDatesByTrip } from "./calendar.js";
import { AugmentedStopTime, augmentStopTimes, SerializableAugmentedStopTime } from "./augmentedStopTime.js";
import * as cache from "../cache.js";
import { getGtfs } from "../gtfsInterfaceLayer.js";
import { getServiceCapacity } from "./serviceCapacity.js";
import { ExpressInfo, findExpress } from "./SectionalRunningTimes/gtfs.js";

// --- Types ---

export type AugmentedTripInstance = qdf.Trip & {
	instance_id: string; // composite of trip_id, start_date, start_time, duplication_id
	trip_id: string;
	serviceDate: string;
	schedule_relationship: qdf.TripScheduleRelationship;
	stopTimes: AugmentedStopTime[];
	realtime_update: qdf.RealtimeTripUpdate | null;
	expressInfo: ExpressInfo[];
	run: string;

	// Dates
	scheduledTripDates: string[];
	actualTripDates: string[];

	runSeries: string | null;
	toSerializable: () => SerializableAugmentedTripInstance;

	rt_start_date: string | null;
};

export type SerializableAugmentedTripInstance = Omit<AugmentedTripInstance, "stopTimes" | "toSerializable" | "realtime_update"> & {
	stopTimes: SerializableAugmentedStopTime[];
};

export type AugmentedTrip = qdf.Trip & {
	scheduledStartServiceDates: string[];
	instances: AugmentedTripInstance[];
	toSerializable: () => SerializableAugmentedTrip;
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

export type SerializableAugmentedTrip = qdf.Trip & {
	scheduledStartServiceDates: string[];
	instances: SerializableAugmentedTripInstance[];
};

// --- Serialization ---

export function toSerializableAugmentedTripInstance(
	inst: AugmentedTripInstance
): SerializableAugmentedTripInstance {
	return {
		...inst,
		stopTimes: inst.stopTimes.map((st) => st.toSerializable()),
		// @ts-expect-error
		realtime_update: undefined,
		toSerializable: undefined,
	};
}

export function toSerializableAugmentedTrip(
	trip: AugmentedTrip
): SerializableAugmentedTrip {
	return {
		...trip,
		scheduledStartServiceDates: trip.scheduledStartServiceDates,
		instances: trip.instances.map(i => i.toSerializable()),
		// @ts-expect-error
		toSerializable: undefined,
	};
}

// --- Augmentation Logic ---

export function augmentTrip(trip: qdf.Trip, ctx?: cache.CacheContext): AugmentedTrip {
	const serviceDates = getServiceDatesByTrip(trip.trip_id, ctx);
	const rawStopTimes = cache.getRawStopTimes(trip.trip_id).sort((a, b) => a.stop_sequence - b.stop_sequence);

	let parentStops = rawStopTimes.map((st) => cache.getRawStops(st.stop_id, ctx)[0]?.parent_station ?? "");
	let expressInfo = findExpress(parentStops.filter((id): id is string => !!id));

	const updates = cache.getTripUpdates(trip.trip_id, ctx);

	const createInstance = (
		serviceDate: string,
		update: qdf.RealtimeTripUpdate | null,
		scheduleRelationship: qdf.TripScheduleRelationship
	): AugmentedTripInstance => {
		const startDate = update?.trip.start_date ?? serviceDate;
		const startTime = update?.trip.start_time ?? "";

		const instance_id = btoa(JSON.stringify([trip.trip_id, startDate, startTime, scheduleRelationship]));


		const stopTimes = augmentStopTimes(
			scheduleRelationship === qdf.TripScheduleRelationship.ADDED || scheduleRelationship === qdf.TripScheduleRelationship.UNSCHEDULED ? null : rawStopTimes,
			{
				serviceDate,
				tripUpdate: update,
				scheduleRelationship
			},
			ctx
		);

		const scheduledTripDates = [
			...new Set(
				stopTimes
					.map((st) => [...(st.scheduled_arrival_dates || []), ...(st.scheduled_departure_dates || [])])
					.flat(),
			),
		].sort((a, b) => Number.parseInt(a) - Number.parseInt(b));

		const actualTripDates = [
			...new Set(
				stopTimes
					.map((st) => [...(st.actual_arrival_dates || []), ...(st.actual_departure_dates || [])])
					.flat(),
			),
		].sort((a, b) => Number.parseInt(a) - Number.parseInt(b));

		const instance: AugmentedTripInstance = {
			...trip,
			instance_id,
			serviceDate,
			schedule_relationship: scheduleRelationship,
			stopTimes,
			realtime_update: update,
			expressInfo,
			run: trip.trip_id.slice(-4),
			scheduledTripDates,
			actualTripDates,
			runSeries: null,
			rt_start_date: update?.trip.start_date || null,
			toSerializable: function () { return toSerializableAugmentedTripInstance(this); }
		};

		let prev_cap = null;

		for (let i = 0; i < instance.stopTimes.length; i++) {
			const st = instance.stopTimes[i];
			if (!st.passing) {
				st.service_capacity = getServiceCapacity(instance, st, serviceDate);
				if (st.service_capacity) prev_cap = st.service_capacity;
				else st.service_capacity = prev_cap
			}

			// Bake in instance info
			st.instance_id = instance.instance_id;
			st.service_date = instance.serviceDate;
			st.schedule_relationship = instance.schedule_relationship;
		}

		return instance;
	};

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

	const augmentedTrip: AugmentedTrip = {
		...trip,
		scheduledStartServiceDates: serviceDates,
		instances,
		toSerializable: function () { return toSerializableAugmentedTrip(this); }
	};

	return augmentedTrip;
}

const RS_TOLERATE_SECS = 30 * 60;

function trackBackwards(instance: AugmentedTripInstance, ctx?: cache.CacheContext): string {
	const gtfs = getGtfs();
	let run = instance.run;
	let prevInstances: AugmentedTripInstance[] = [instance];
	let currentInstance = instance;

	const serviceDate = currentInstance.serviceDate;

	for (let _break = 0; _break < 100; _break++) {
		if (currentInstance.stopTimes.length === 0) break;
		let st = currentInstance.stopTimes[0];

		const time = st.scheduled_departure_time || st.scheduled_arrival_time;
		if (time === null) break;

		if ((time || 0) < RS_TOLERATE_SECS) break;

		let deps_ids = gtfs.queryStopTimes({
			stop_id: st.scheduled_stop?.stop_id,
			date: serviceDate.toString(),
			start_time: (time || 0) - RS_TOLERATE_SECS,
			end_time: time || 0,
		});

		let candidateInstances: AugmentedTripInstance[] = [];
		for (const d of deps_ids) {
			const trips = cache.getAugmentedTrips(d.trip_id, ctx);
			if (!trips.length) continue;
			const t = trips[0];
			const inst = t.instances.find(i => i.serviceDate === serviceDate && i.schedule_relationship === qdf.TripScheduleRelationship.SCHEDULED);
			if (inst) candidateInstances.push(inst);
		}

		let deps = candidateInstances
			.map((inst) => inst.stopTimes.find((v) => v.scheduled_stop?.stop_id == st.scheduled_stop?.stop_id))
			.filter((v): v is AugmentedStopTime => !!v);

		deps = deps.filter((v) => v.trip_id.slice(-4)[0] == run[0] && v.trip_id.slice(-4) != run);

		deps = deps.sort(
			(a, b) =>
				(a.scheduled_departure_time || a.scheduled_arrival_time || Infinity) -
				(b.scheduled_departure_time || b.scheduled_arrival_time || Infinity),
		);

		if (deps.length === 0) break;

		const bestMatchStopTime = deps.at(-1);
		if (!bestMatchStopTime) break;

		const matchTrip = cache.getAugmentedTrips(bestMatchStopTime.trip_id, ctx)[0];
		const matchInstance = matchTrip.instances.find(i => i.serviceDate === serviceDate);

		if (!matchInstance) break;
		if (bestMatchStopTime._stopTime?.stop_sequence != matchInstance.stopTimes.at(-1)?._stopTime?.stop_sequence) break;

		prevInstances.push(matchInstance);
		run = matchInstance.run;
		currentInstance = matchInstance;
	}

	let rs = cache.getRunSeries(serviceDate, run, false, ctx);
	for (const prevInst of prevInstances) {
		prevInst.runSeries = run;
		if (!rs.trips.some((v) => v.trip_id === prevInst.trip_id))
			rs.trips = [
				{
					trip_id: prevInst.trip_id,
					trip_start_time:
						prevInst.stopTimes[0].scheduled_departure_time ||
						prevInst.stopTimes[0].scheduled_arrival_time ||
						0,
					run: prevInst.run,
				},
				...rs.trips,
			];
	}
	cache.setRunSeries(serviceDate, run, rs, ctx);
	return run;
}

function trackForwards(instance: AugmentedTripInstance, runSeries: string, ctx?: cache.CacheContext): void {
	const gtfs = getGtfs();
	let run = instance.run;
	const serviceDate = instance.serviceDate;

	let rs = cache.getRunSeries(serviceDate, runSeries, false, ctx);
	let currentInstance = instance;

	for (let _break = 0; _break < 100; _break++) {
		if (currentInstance.stopTimes.length === 0) break;
		let st = currentInstance.stopTimes.at(-1) as AugmentedStopTime;
		const time = st.scheduled_departure_time || st.scheduled_arrival_time;
		if (time === null) break;

		let deps_ids = gtfs.queryStopTimes({
			stop_id: st.scheduled_stop?.stop_id,
			date: serviceDate.toString(),
			start_time: time || 0,
			end_time: (time || 0) + RS_TOLERATE_SECS,
		});

		let candidateInstances: AugmentedTripInstance[] = [];
		for (const d of deps_ids) {
			const trips = cache.getAugmentedTrips(d.trip_id, ctx);
			if (!trips.length) continue;
			const inst = trips[0].instances.find(i => i.serviceDate === serviceDate && i.schedule_relationship === qdf.TripScheduleRelationship.SCHEDULED);
			if (inst) candidateInstances.push(inst);
		}

		let deps = candidateInstances
			.map((inst) => inst.stopTimes.find((v) => v.scheduled_stop?.stop_id == st.scheduled_stop?.stop_id))
			.filter((v): v is AugmentedStopTime => !!v);

		deps = deps.filter((v) => v.trip_id.slice(-4)[0] == run[0] && v.trip_id.slice(-4) != run);

		deps = deps.sort(
			(a, b) =>
				(a.scheduled_departure_time || a.scheduled_arrival_time || Infinity) -
				(b.scheduled_departure_time || b.scheduled_arrival_time || Infinity),
		);

		if (deps.length === 0) break;

		const bestMatchStopTime = deps[0];
		const matchTrip = cache.getAugmentedTrips(bestMatchStopTime.trip_id, ctx)[0];
		const matchInstance = matchTrip.instances.find(i => i.serviceDate === serviceDate);

		if (!matchInstance) break;
		if (bestMatchStopTime._stopTime?.stop_sequence != 1) break;

		matchInstance.runSeries = runSeries;
		run = matchInstance.run;

		if (!rs.trips.some((v) => v.trip_id === matchInstance.trip_id))
			rs.trips.push({
				trip_id: matchInstance.trip_id,
				trip_start_time:
					matchInstance.stopTimes[0].scheduled_departure_time || matchInstance.stopTimes[0].scheduled_arrival_time || 0,
				run,
			});

		currentInstance = matchInstance;
	}
	cache.setRunSeries(serviceDate, runSeries, rs, ctx);
}

export function calculateRunSeries(instance: AugmentedTripInstance, ctx?: cache.CacheContext): void {
	if (instance.runSeries != null) return;
	let runSeries = trackBackwards(instance, ctx);
	trackForwards(instance, runSeries, ctx);
}
