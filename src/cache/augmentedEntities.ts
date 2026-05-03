import type { RealtimeVehiclePosition } from "qdf-gtfs";
import { augmentStop } from "../utils/augmentedStop.js";
import type { AugmentedStop } from "../utils/augmentedStop.js";
import { augmentTrip, calculateRunSeries } from "../utils/augmentedTrip.js";
import type { AugmentedTrip, AugmentedTripInstance, RunSeries } from "../utils/augmentedTrip.js";
import type { AugmentedStopTime } from "../utils/augmentedStopTime.js";
import { addSC, addSCI } from "../utils/serviceCapacity.js";
import { addVehicleModel, addVehicleModelTrip } from "../utils/vehicleModel.js";
import { getServiceDayStart } from "../utils/time.js";
import { patchSeqDiagramOntoAugmentedTrip } from "../region-specific/AU/SEQ/seq-diagram.js";
import ensureQRTEnabled from "../region-specific/AU/SEQ/qr-travel/enabled.js";
import type {
	QRTPlace,
	QRTStations,
	QRTTravelTrip,
} from "../region-specific/AU/SEQ/qr-travel/types.js";
import type { RailwayStationFacility } from "../region-specific/AU/SEQ/facilities-types.js";
import { getGtfs } from "../gtfsInterfaceLayer.js";
import type { CacheContext } from "./types.js";
import type { TraxConfig } from "../config.js";
import * as qdf from "qdf-gtfs";
import type { ExpressInfo, PassingStop } from "../utils/SRT.js";
import { getStops, getTrips } from "./gtfsReads.js";

export function unregisterAugmentedTrip(ctx: CacheContext, tripId: string): void {
	const { augmented } = ctx;
	const trip = augmented.tripsRec.get(tripId);
	if (!trip) return;

	for (const instance of trip.instances) {
		for (const st of instance.stopTimes) {
			const stopsToCleanup = new Set<string>();
			if (st.actual_stop_id) stopsToCleanup.add(st.actual_stop_id);
			if (st.actual_parent_station_id) stopsToCleanup.add(st.actual_parent_station_id);
			if (st.scheduled_stop_id) stopsToCleanup.add(st.scheduled_stop_id);
			if (st.scheduled_parent_station_id) stopsToCleanup.add(st.scheduled_parent_station_id);

			for (const stopId of stopsToCleanup) {
				const tripSet = augmented.tripsStoppingAt.get(stopId);
				if (tripSet) {
					tripSet.delete(tripId);
					// Clear all date-based caches for this stop
					augmented.stopDeparturesCached.delete(stopId);
				}
			}
		}
		augmented.instancesRec.delete(instance.instance_id);
	}
}

export function registerAugmentedTrip(ctx: CacheContext, trip: AugmentedTrip): void {
	const { augmented } = ctx;
	const tripId = trip.trip_id;

	// Populate tripsStoppingAt once per trip (from the first instance's stop times)
	// This identifies which stops this trip potentially visits.
	const firstInstance = trip.instances[0];
	if (firstInstance) {
		for (const st of firstInstance.stopTimes) {
			const stopsToIndex = new Set<string>();
			if (st.actual_stop_id) stopsToIndex.add(st.actual_stop_id);
			if (st.actual_parent_station_id) stopsToIndex.add(st.actual_parent_station_id);
			if (st.scheduled_stop_id) stopsToIndex.add(st.scheduled_stop_id);
			if (st.scheduled_parent_station_id) stopsToIndex.add(st.scheduled_parent_station_id);

			for (const stopId of stopsToIndex) {
				let tripSet = augmented.tripsStoppingAt.get(stopId);
				if (!tripSet) {
					tripSet = new Set();
					augmented.tripsStoppingAt.set(stopId, tripSet);
				}
				tripSet.add(tripId);
				// Invalidate cache for this stop across all dates (since a trip changed)
				augmented.stopDeparturesCached.delete(stopId);
			}
		}
	}

	for (const instance of trip.instances) {
		augmented.instancesRec.set(instance.instance_id, instance);
	}
}

export function getStopDeparturesCached(ctx: CacheContext, stopId: string, serviceDate: string): AugmentedStopTime[] {
	const timer = ctx.augmented.timer;
	timer.start("getStopDeparturesCached");
	const { augmented } = ctx;
	const cachedByStop = augmented.stopDeparturesCached.get(stopId);
	const cached = cachedByStop?.get(serviceDate);
	if (cached) {
		timer.stop("getStopDeparturesCached");
		return cached;
	}

	timer.start("getStopDeparturesCached:idIntersection");
	const tripIdsForStop = augmented.tripsStoppingAt.get(stopId);
	let tripIdsForDate = augmented.serviceDateTripsSet.get(serviceDate);
	if (!tripIdsForDate) {
		const tripIdsList = augmented.serviceDateTrips.get(serviceDate);
		if (tripIdsList) {
			tripIdsForDate = new Set(tripIdsList);
			augmented.serviceDateTripsSet.set(serviceDate, tripIdsForDate);
		}
	}

	if (!tripIdsForStop || !tripIdsForDate) {
		timer.stop("getStopDeparturesCached:idIntersection");
		timer.stop("getStopDeparturesCached");
		return [];
	}

	// Intersect trips for stop and trips for date
	const relevantTripIds: string[] = [];
	if (tripIdsForStop.size < tripIdsForDate.size) {
		for (const id of tripIdsForStop) {
			if (tripIdsForDate.has(id)) relevantTripIds.push(id);
		}
	} else {
		for (const id of tripIdsForDate) {
			if (tripIdsForStop.has(id)) relevantTripIds.push(id);
		}
	}
	timer.stop("getStopDeparturesCached:idIntersection");

	timer.start("getStopDeparturesCached:processInstances");
	const results: AugmentedStopTime[] = [];
	for (const tripId of relevantTripIds) {
		const trip = augmented.tripsRec.get(tripId);
		if (!trip) continue;
		const instance = trip.instances.find((i) => i.serviceDate === serviceDate);
		if (!instance) continue;

		for (const st of instance.stopTimes) {
			if (
				st.actual_stop_id === stopId ||
				st.actual_parent_station_id === stopId ||
				st.scheduled_stop_id === stopId ||
				st.scheduled_parent_station_id === stopId
			) {
				results.push(st);
			}
		}
	}
	timer.stop("getStopDeparturesCached:processInstances");

	// Sort by absolute time for fast window queries
	const serviceDayStartCache = new Map<string, number>();
	const getAbsTime = (st: AugmentedStopTime) => {
		let dayStart = serviceDayStartCache.get(st.service_date);
		if (dayStart === undefined) {
			dayStart = getServiceDayStart(st.service_date, ctx.config.timezone);
			serviceDayStartCache.set(st.service_date, dayStart);
		}
		return (st.actual_departure_time ?? st.scheduled_departure_time ?? st.actual_arrival_time ?? 0) + dayStart;
	};

	timer.start("getStopDeparturesCached:sort");
	results.sort((a, b) => getAbsTime(a) - getAbsTime(b));
	timer.stop("getStopDeparturesCached:sort");

	let stopCache = augmented.stopDeparturesCached.get(stopId);
	if (!stopCache) {
		stopCache = new Map();
		augmented.stopDeparturesCached.set(stopId, stopCache);
	}
	stopCache.set(serviceDate, results);
	timer.stop("getStopDeparturesCached");
	return results;
}

/** {@link addSCI} + {@link addVehicleModel} — instance cache entries are registered without these passes (unlike {@link getAugmentedTrips} return values). */
function enrichAugmentedTripInstance(
	ctx: CacheContext,
	config: TraxConfig,
	inst: AugmentedTripInstance,
): AugmentedTripInstance {
	return addVehicleModel(addSCI(inst, ctx, config), ctx, config);
}

export function getAugmentedTrips(ctx: CacheContext, trip_id?: string): AugmentedTrip[] {
	const context = ctx;
	const { augmented } = context;
	if (trip_id) {
		const trip = augmented.tripsRec.get(trip_id);
		if (trip) return [addVehicleModelTrip(addSC(trip, ctx, context.config), ctx, context.config)];
		const rawTrip = getTrips(ctx, trip_id)[0];
		if (rawTrip) {
			const augmentedTrip = augmentTrip(rawTrip, context);
			registerAugmentedTrip(ctx, augmentedTrip);
			augmented.tripsRec.set(trip_id, augmentedTrip);
			patchSeqDiagramOntoAugmentedTrip(context, augmentedTrip);
			return [addVehicleModelTrip(addSC(augmentedTrip, ctx, context.config), ctx, context.config)];
		}
		return [];
	}
	return Array.from(augmented.tripsRec.values()).map((v) =>
		addVehicleModelTrip(addSC(v, ctx, context.config), ctx, context.config),
	);
}

export function getAugmentedTripInstance(ctx: CacheContext, instance_id: string): AugmentedTripInstance | null {
	const context = ctx;
	const cached = ctx.augmented.instancesRec.get(instance_id);
	if (cached) return enrichAugmentedTripInstance(context, context.config, cached);

	try {
		const tripId = JSON.parse(atob(instance_id))[0];
		const trip = ctx.augmented.tripsRec.get(tripId);
		if (trip) {
			const inst = trip.instances.find((v) => v.instance_id === instance_id);
			if (inst) {
				ctx.augmented.instancesRec.set(instance_id, inst);
				return enrichAugmentedTripInstance(context, context.config, inst);
			}
		}

		// Fallback to slow way if not in record (getAugmentedTrips already runs addSC + addVehicleModel per instance)
		let res = getAugmentedTrips(ctx, tripId)[0]?.instances.find((v) => v.instance_id === instance_id);
		return res ?? null;
	} catch {
		return null;
	}
}

export function getVehicleTripInstance(
	ctx: CacheContext,
	vehicle: RealtimeVehiclePosition,
): AugmentedTripInstance | null {
	const tripId = vehicle.trip.trip_id;
	if (!tripId) return null;

	const augmentedTrips = getAugmentedTrips(ctx, tripId);
	if (augmentedTrips.length === 0) return null;
	const augmentedTrip = augmentedTrips[0];

	const startDate = vehicle.trip.start_date;
	if (startDate) {
		return augmentedTrip.instances.find((i) => i.serviceDate === startDate) || null;
	}

	const now = Date.now() / 1000;
	let bestInstance: AugmentedTripInstance | null = null;
	let minDiff = Infinity;

	for (const instance of augmentedTrip.instances) {
		if (instance.stopTimes.length === 0) continue;

		const serviceDayStart = getServiceDayStart(instance.serviceDate, ctx.config.timezone);

		const startTime =
			serviceDayStart +
			(instance.stopTimes[0].actual_departure_time ?? instance.stopTimes[0].actual_arrival_time ?? 0);
		const endTime =
			serviceDayStart +
			(instance.stopTimes.at(-1)!.actual_arrival_time ?? instance.stopTimes.at(-1)!.actual_departure_time ?? 0);

		if (now >= startTime && now <= endTime) {
			return instance;
		}

		const diff = Math.min(Math.abs(now - startTime), Math.abs(now - endTime));
		if (diff < minDiff) {
			minDiff = diff;
			bestInstance = instance;
		}
	}

	return bestInstance;
}

export function getAugmentedStops(ctx: CacheContext, stop_id?: string): AugmentedStop[] {
	const context = ctx;
	const { augmented } = context;
	if (stop_id) {
		const stop = augmented.stopsRec.get(stop_id);
		if (stop) return [stop];
		const rawStop = getStops(ctx, stop_id)[0];
		if (rawStop) {
			const augmentedStop = augmentStop(rawStop, context);
			augmented.stopsRec.set(stop_id, augmentedStop);
			return [augmentedStop];
		}
		return [];
	}
	return augmented.stops ?? [];
}

export function getAugmentedStopTimes(ctx: CacheContext, trip_id?: string): AugmentedStopTime[] {
	const { augmented } = ctx;
	if (trip_id) return augmented.stopTimes?.[trip_id] ?? [];
	return Object.values(augmented.stopTimes ?? {}).flat();
}

export function queryAugmentedStopTimes(ctx: CacheContext, query: qdf.StopTimeQuery): AugmentedStopTime[] {
	const context = ctx;
	const { gtfs: ctxGtfs } = context;
	const results: AugmentedStopTime[] = [];
	const gtfs = ctxGtfs ?? getGtfs();
	gtfs.getStopTimes(query).forEach((st: qdf.StopTime) => {
		const augmentedTrip = getAugmentedTrips(context, st.trip_id)[0];
		if (augmentedTrip) {
			for (const instance of augmentedTrip.instances) {
				const augmentedStopTime = instance.stopTimes.find(
					(ast) => ast._stopTime?.stop_sequence === st.stop_sequence && ast.scheduled_stop_id === st.stop_id,
				);
				if (augmentedStopTime) {
					results.push(augmentedStopTime);
				}
			}
		}
	});
	return results;
}

export function getBaseStopTimes(ctx: CacheContext, trip_id: string): AugmentedStopTime[] {
	const { augmented } = ctx;
	return augmented.baseStopTimes?.[trip_id] ?? [];
}

export function cacheExpressInfo(ctx: CacheContext, stopListHash: string, expressInfo: ExpressInfo[]) {
	const { augmented } = ctx;
	augmented.expressInfoCache.set(stopListHash, expressInfo);
}

export function getCachedExpressInfo(ctx: CacheContext, stopListHash: string): ExpressInfo[] | undefined {
	const { augmented } = ctx;
	return augmented.expressInfoCache.get(stopListHash);
}

export function cachePassingStops(ctx: CacheContext, stopListHash: string, passingStops: PassingStop[]) {
	const { augmented } = ctx;
	augmented.passingStopsCache.set(stopListHash, passingStops);
}

export function getCachedPassingStops(ctx: CacheContext, stopListHash: string): PassingStop[] | undefined {
	const { augmented } = ctx;
	return augmented.passingStopsCache.get(stopListHash);
}

export function getPassingTrips(ctx: CacheContext, stopId: string): string[] {
	const { augmented } = ctx;
	return augmented.passingTrips.get(stopId) ?? [];
}

export function getShapes(ctx: CacheContext): { shape_id: string; route_id: string }[] {
	return ctx.augmented.shapes;
}

export function getRunSeries(
	ctx: CacheContext,
	date: string,
	runSeries: string,
	calcIfNotFound: boolean = true,
): RunSeries {
	const context = ctx;
	const { augmented } = context;

	let dateMap = augmented.runSeriesCache.get(date);
	if (!dateMap) {
		dateMap = new Map();
		augmented.runSeriesCache.set(date, dateMap);
	}
	if (
		!dateMap.get(runSeries) &&
		calcIfNotFound &&
		augmented.serviceDateTrips.get(date)?.find((v) => v.endsWith(runSeries))
	) {
		const tripId = augmented.serviceDateTrips.get(date)?.find((v) => v.endsWith(runSeries));
		if (tripId) {
			const trip = getAugmentedTrips(context, tripId)[0];
			const instance = trip.instances.find((i) => i.serviceDate === date);
			if (instance) {
				calculateRunSeries(instance, context);
			}
		}
	} else if (!dateMap.get(runSeries))
		dateMap.set(runSeries, {
			trips: [],
			vehicle_sightings: [],
			series: runSeries.toUpperCase(),
			date,
		});
	return dateMap.get(runSeries)!;
}

export function setRunSeries(date: string, runSeries: string, data: RunSeries, ctx: CacheContext): void {
	const { augmented } = ctx;
	let dateMap = augmented.runSeriesCache.get(date);
	if (!dateMap) {
		dateMap = new Map();
		augmented.runSeriesCache.set(date, dateMap);
	}
	dateMap.set(runSeries, data);
}

export function SEQgetQRTPlaces(ctx: CacheContext): QRTPlace[] {
	ensureQRTEnabled(ctx.config);
	const { raw } = ctx;
	return raw.regionSpecific.SEQ.qrtPlaces;
}

export function SEQgetQRTStations(ctx: CacheContext): QRTStations {
	ensureQRTEnabled(ctx.config);
	const { raw } = ctx;
	return raw.regionSpecific.SEQ.qrtStations;
}

export function SEQgetQRTTrains(ctx: CacheContext): QRTTravelTrip[] {
	ensureQRTEnabled(ctx.config);
	const { raw } = ctx;
	return raw.regionSpecific.SEQ.qrtTrains;
}

export function SEQgetRailwayStationFacilities(ctx: CacheContext): RailwayStationFacility[] {
	const { raw } = ctx;
	return raw.regionSpecific.SEQ.railwayStationFacilities;
}
