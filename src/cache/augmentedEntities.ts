import type { QualifiedEntityId, RealtimeVehiclePosition } from "qdf-gtfs";
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
import type { QRTPlace, QRTStations, QRTTravelTrip } from "../region-specific/AU/SEQ/qr-travel/types.js";
import type { RailwayStationFacility } from "../region-specific/AU/SEQ/facilities-types.js";
import type { CacheContext } from "./types.js";
import { getFeedTimeZone, type TraxConfig } from "../config.js";
import * as qdf from "qdf-gtfs";
import type { ExpressInfo, PassingStop } from "../utils/SRT.js";
import { getStops, getTrips } from "./gtfsReads.js";
import { decodeTripInstanceId, entityKey } from "../identity.js";
import { getSeqState } from "../plugins/seq-state.js";

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

			for (const localStopId of stopsToCleanup) {
				const stopId = entityKey({ feedId: st.feed_id, localId: localStopId });
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
	const tripId = entityKey({ feedId: trip.feed_id, localId: trip.trip_id });

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

			for (const localStopId of stopsToIndex) {
				const stopId = entityKey({ feedId: st.feed_id, localId: localStopId });
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

export function getStopDeparturesCached(ctx: CacheContext, stop: QualifiedEntityId, serviceDate: string): AugmentedStopTime[] {
	const stopId = entityKey(stop);
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
				(st.feed_id === stop.feedId && st.actual_stop_id === stop.localId) ||
				(st.feed_id === stop.feedId && st.actual_parent_station_id === stop.localId) ||
				(st.feed_id === stop.feedId && st.scheduled_stop_id === stop.localId) ||
				(st.feed_id === stop.feedId && st.scheduled_parent_station_id === stop.localId)
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
			dayStart = getServiceDayStart(st.service_date, getFeedTimeZone(ctx.config, st.feed_id));
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

export function getAugmentedTrips(ctx: CacheContext, trip?: QualifiedEntityId): AugmentedTrip[] {
	const context = ctx;
	const { augmented } = context;
	if (trip) {
		const key = entityKey(trip);
		const cachedTrip = augmented.tripsRec.get(key);
		if (cachedTrip) return [addVehicleModelTrip(addSC(cachedTrip, ctx, context.config), ctx, context.config)];
		const rawTrip = getTrips(ctx, { feed_id: trip.feedId, trip_id: trip.localId })[0];
		if (rawTrip) {
			const augmentedTrip = augmentTrip(rawTrip, context);
			registerAugmentedTrip(ctx, augmentedTrip);
			augmented.tripsRec.set(key, augmentedTrip);
			patchSeqDiagramOntoAugmentedTrip(context, augmentedTrip);
			return [addVehicleModelTrip(addSC(augmentedTrip, ctx, context.config), ctx, context.config)];
		}
		return [];
	}
	const trips = Array.from(augmented.tripsRec.values());
	for (const trip of trips) {
		addVehicleModelTrip(addSC(trip, ctx, context.config), ctx, context.config);
	}
	return trips;
}

export function getAugmentedTripInstance(ctx: CacheContext, instance_id: string): AugmentedTripInstance | null {
	const context = ctx;
	const cached = ctx.augmented.instancesRec.get(instance_id);
	if (cached) return enrichAugmentedTripInstance(context, context.config, cached);

	try {
		const identity = decodeTripInstanceId(instance_id);
		if (identity.networkId !== ctx.config.network.id) return null;
		const tripRef = { feedId: identity.feedId, localId: identity.localId };
		const trip = ctx.augmented.tripsRec.get(entityKey(tripRef));
		if (trip) {
			const inst = trip.instances.find((v) => v.instance_id === instance_id);
			if (inst) {
				ctx.augmented.instancesRec.set(instance_id, inst);
				return enrichAugmentedTripInstance(context, context.config, inst);
			}
		}

		// Fallback to slow way if not in record (getAugmentedTrips already runs addSC + addVehicleModel per instance)
		let res = getAugmentedTrips(ctx, tripRef)[0]?.instances.find((v) => v.instance_id === instance_id);
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
	if (!tripId || !vehicle.feed_id) return null;

	const augmentedTrips = getAugmentedTrips(ctx, { feedId: vehicle.feed_id, localId: tripId });
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

		const serviceDayStart = getServiceDayStart(instance.serviceDate, getFeedTimeZone(ctx.config, instance.feed_id));

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

export function getAugmentedStops(ctx: CacheContext, stop?: QualifiedEntityId): AugmentedStop[] {
	const context = ctx;
	const { augmented } = context;
	if (stop) {
		const key = entityKey(stop);
		const cachedStop = augmented.stopsRec.get(key);
		if (cachedStop) return [cachedStop];
		const rawStop = getStops(ctx, { feed_id: stop.feedId, stop_id: stop.localId })[0];
		if (rawStop) {
			const augmentedStop = augmentStop(rawStop, context);
			augmented.stopsRec.set(key, augmentedStop);
			return [augmentedStop];
		}
		return [];
	}
	return augmented.stops ?? [];
}

export function getAugmentedStopTimes(ctx: CacheContext, trip?: QualifiedEntityId): AugmentedStopTime[] {
	const { augmented } = ctx;
	if (trip) return augmented.stopTimes?.[entityKey(trip)] ?? [];
	return Object.values(augmented.stopTimes ?? {}).flat();
}

export function queryAugmentedStopTimes(ctx: CacheContext, query: qdf.StopTimeQuery): AugmentedStopTime[] {
	const context = ctx;
	const { gtfs: ctxGtfs } = context;
	const results: AugmentedStopTime[] = [];
	if (!ctxGtfs) throw new Error("GTFS is not initialized for this network runtime");
	const gtfs = ctxGtfs;
	gtfs.getStopTimes(query).forEach((st: qdf.StopTime) => {
		const augmentedTrip = getAugmentedTrips(context, { feedId: st.feed_id, localId: st.trip_id })[0];
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

export function getBaseStopTimes(ctx: CacheContext, trip: QualifiedEntityId): AugmentedStopTime[] {
	const { augmented } = ctx;
	return augmented.baseStopTimes?.[entityKey(trip)] ?? [];
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

export function getPassingTrips(ctx: CacheContext, stop: QualifiedEntityId): string[] {
	const { augmented } = ctx;
	return augmented.passingTrips.get(entityKey(stop)) ?? [];
}

export function getShapes(ctx: CacheContext): { feed_id: string; shape_id: string; route_id: string }[] {
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
		augmented.serviceDateTrips.get(date)?.find((key) => augmented.tripsRec.get(key)?.trip_id.endsWith(runSeries))
	) {
		const tripKey = augmented.serviceDateTrips.get(date)?.find((key) => augmented.tripsRec.get(key)?.trip_id.endsWith(runSeries));
		if (tripKey) {
			const trip = augmented.tripsRec.get(tripKey)!;
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
	return getSeqState(ctx).qrtPlaces;
}

export function SEQgetQRTStations(ctx: CacheContext): QRTStations {
	ensureQRTEnabled(ctx.config);
	return getSeqState(ctx).qrtStations;
}

export function SEQgetQRTTrains(ctx: CacheContext): QRTTravelTrip[] {
	ensureQRTEnabled(ctx.config);
	return getSeqState(ctx).qrtTrains;
}

export function SEQgetRailwayStationFacilities(ctx: CacheContext): RailwayStationFacility[] {
	return getSeqState(ctx).railwayStationFacilities;
}
