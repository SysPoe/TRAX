import type { QualifiedEntityId, RealtimeVehiclePosition } from "qdf-gtfs";
import { augmentStop } from "../utils/augmentedStop.js";
import type { AugmentedStop } from "../utils/augmentedStop.js";
import { augmentTrip, calculateRunSeries } from "../utils/augmentedTrip.js";
import type { AugmentedTrip, AugmentedTripInstance, RunSeries } from "../utils/augmentedTrip.js";
import type { AugmentedStopTime } from "../utils/augmentedStopTime.js";
import { addVehicleModel } from "../utils/vehicleModel.js";
import { addDaysToServiceDate, getEpochDayFromServiceDate, getServiceDayStart } from "../utils/time.js";
import {
	applySeqDiagramToInstances,
	patchSeqDiagramOntoAugmentedTrip,
	revalidateSeqDiagramRealtimeEdges,
} from "../region-specific/AU/SEQ/seq-diagram.js";
import ensureQRTEnabled from "../region-specific/AU/SEQ/qr-travel/enabled.js";
import type { QRTPlace, QRTStations, QRTTravelTrip } from "../region-specific/AU/SEQ/qr-travel/types.js";
import type { RailwayStationFacility } from "../region-specific/AU/SEQ/facilities-types.js";
import type { CacheContext } from "./types.js";
import { getFeedTimeZone } from "../config.js";
import * as qdf from "qdf-gtfs";
import type { ExpressInfo, PassingStop } from "../utils/SRT.js";
import { getRawStopTimes, getStops, getTrips } from "./gtfsReads.js";
import { decodeTripInstanceId, entityKey } from "../identity.js";
import { getSeqState } from "../plugins/seq-state.js";
import { getServiceDatesByTrip } from "../utils/calendar.js";

const MAX_LAZY_SERVICE_DATES = 8;

function getMembershipSet(
	membersByBucket: Map<string, Set<string>>,
	arraysByBucket: Map<string, string[]>,
	bucket: string,
): Set<string> | undefined {
	const members = membersByBucket.get(bucket);
	if (members) return members;
	const legacyArray = arraysByBucket.get(bucket);
	if (!legacyArray) return undefined;
	const result = new Set(legacyArray);
	membersByBucket.set(bucket, result);
	return result;
}

function addOwnedMembership(
	membersByBucket: Map<string, Set<string>>,
	arraysByBucket: Map<string, string[]>,
	bucketsByTrip: Map<string, Set<string>>,
	bucket: string,
	tripKey: string,
): void {
	let members = getMembershipSet(membersByBucket, arraysByBucket, bucket);
	if (!members) {
		members = new Set();
		membersByBucket.set(bucket, members);
	}
	if (!members.has(tripKey)) {
		members.add(tripKey);
		arraysByBucket.delete(bucket);
	}

	let ownedBuckets = bucketsByTrip.get(tripKey);
	if (!ownedBuckets) {
		ownedBuckets = new Set();
		bucketsByTrip.set(tripKey, ownedBuckets);
	}
	ownedBuckets.add(bucket);
}

function removeOwnedMembership(
	membersByBucket: Map<string, Set<string>>,
	arraysByBucket: Map<string, string[]>,
	bucketsByTrip: Map<string, Set<string>>,
	bucket: string,
	tripKey: string,
): void {
	const members = getMembershipSet(membersByBucket, arraysByBucket, bucket);
	if (members) {
		members.delete(tripKey);
		if (members.size === 0) membersByBucket.delete(bucket);
	}
	arraysByBucket.delete(bucket);

	const ownedBuckets = bucketsByTrip.get(tripKey);
	if (!ownedBuckets) return;
	ownedBuckets.delete(bucket);
	if (ownedBuckets.size === 0) bucketsByTrip.delete(tripKey);
}

function materializeMembershipArray(
	membersByBucket: Map<string, Set<string>>,
	arraysByBucket: Map<string, string[]>,
	bucket: string,
): string[] {
	const members = getMembershipSet(membersByBucket, arraysByBucket, bucket);
	if (!members) return [];
	const cached = arraysByBucket.get(bucket);
	if (cached) return cached;
	const result = Array.from(members);
	arraysByBucket.set(bucket, result);
	return result;
}

function getServiceDateTripSet(ctx: CacheContext, serviceDate: string): Set<string> | undefined {
	const { augmented } = ctx;
	return getMembershipSet(augmented.serviceDateTripsSet, augmented.serviceDateTrips, serviceDate);
}

export function rebuildAugmentedTripArrayIndex(ctx: CacheContext): void {
	const { augmented } = ctx;
	augmented.tripArrayIndex.clear();
	for (let index = 0; index < augmented.trips.length; index += 1) {
		const trip = augmented.trips[index];
		augmented.tripArrayIndex.set(entityKey({ feedId: trip.feed_id, localId: trip.trip_id }), index);
	}
}

export function replaceAugmentedTripInArray(ctx: CacheContext, trip: AugmentedTrip): void {
	const { augmented } = ctx;
	const tripKey = entityKey({ feedId: trip.feed_id, localId: trip.trip_id });
	const index = augmented.tripArrayIndex.get(tripKey);
	if (index === undefined) {
		augmented.tripArrayIndex.set(tripKey, augmented.trips.length);
		augmented.trips.push(trip);
	} else {
		augmented.trips[index] = trip;
	}
}

export function removeAugmentedTripFromArray(ctx: CacheContext, tripKey: string): void {
	const { augmented } = ctx;
	const index = augmented.tripArrayIndex.get(tripKey);
	if (index === undefined) return;

	const lastIndex = augmented.trips.length - 1;
	if (index !== lastIndex) {
		const movedTrip = augmented.trips[lastIndex];
		augmented.trips[index] = movedTrip;
		augmented.tripArrayIndex.set(entityKey({ feedId: movedTrip.feed_id, localId: movedTrip.trip_id }), index);
	}
	augmented.trips.pop();
	augmented.tripArrayIndex.delete(tripKey);
}

export function unregisterAugmentedTrip(ctx: CacheContext, tripId: string): void {
	const { augmented } = ctx;
	const trip = augmented.tripsRec.get(tripId);
	if (!trip) return;

	const serviceDates = augmented.serviceDatesByTrip.get(tripId);
	if (serviceDates) {
		for (const date of [...serviceDates]) {
			removeOwnedMembership(
				augmented.serviceDateTripsSet,
				augmented.serviceDateTrips,
				augmented.serviceDatesByTrip,
				date,
				tripId,
			);
		}
	} else {
		const fallbackDates = new Set(trip.instances.flatMap((instance) => instance.actualTripDates));
		for (const date of fallbackDates) {
			removeOwnedMembership(
				augmented.serviceDateTripsSet,
				augmented.serviceDateTrips,
				augmented.serviceDatesByTrip,
				date,
				tripId,
			);
		}
	}

	const passingStops = augmented.passingStopsByTrip.get(tripId);
	if (passingStops) {
		for (const stopKey of [...passingStops]) {
			removeOwnedMembership(
				augmented.passingTripsSet,
				augmented.passingTrips,
				augmented.passingStopsByTrip,
				stopKey,
				tripId,
			);
		}
	} else {
		const fallbackStops = new Set(
			trip.instances.flatMap((instance) =>
				instance.stopTimes
					.filter((stopTime) => stopTime.passing && stopTime.actual_stop_id)
					.map((stopTime) => entityKey({ feedId: stopTime.feed_id, localId: stopTime.actual_stop_id! })),
			),
		);
		for (const stopKey of fallbackStops) {
			removeOwnedMembership(
				augmented.passingTripsSet,
				augmented.passingTrips,
				augmented.passingStopsByTrip,
				stopKey,
				tripId,
			);
		}
	}

	const stopsToCleanup = new Set<string>();
	for (const instance of trip.instances) {
		for (const st of instance.stopTimes) {
			if (st.actual_stop_id) stopsToCleanup.add(entityKey({ feedId: st.feed_id, localId: st.actual_stop_id }));
			if (st.actual_parent_station_id)
				stopsToCleanup.add(entityKey({ feedId: st.feed_id, localId: st.actual_parent_station_id }));
			if (st.scheduled_stop_id)
				stopsToCleanup.add(entityKey({ feedId: st.feed_id, localId: st.scheduled_stop_id }));
			if (st.scheduled_parent_station_id)
				stopsToCleanup.add(entityKey({ feedId: st.feed_id, localId: st.scheduled_parent_station_id }));
		}
		augmented.instancesRec.delete(instance.instance_id);
	}
	for (const stopId of stopsToCleanup) {
		const tripSet = augmented.tripsStoppingAt.get(stopId);
		if (tripSet) {
			tripSet.delete(tripId);
			if (tripSet.size === 0) augmented.tripsStoppingAt.delete(stopId);
		}
		augmented.stopDeparturesCached.delete(stopId);
	}
}

/**
 * Provider vehicle lookup can lazily materialize another service date. Drain
 * those nested registrations as a queue instead of growing the JS call stack.
 */
function enrichRegisteredTripInstances(ctx: CacheContext, instances: readonly AugmentedTripInstance[]): void {
	const runtime = ctx.runtimeState;
	for (const instance of instances) runtime.vehicleEnrichmentQueue.set(instance.instance_id, instance);
	if (runtime.vehicleEnrichmentActive) return;

	runtime.vehicleEnrichmentActive = true;
	try {
		while (runtime.vehicleEnrichmentQueue.size > 0) {
			const next = runtime.vehicleEnrichmentQueue.entries().next().value as
				| [string, AugmentedTripInstance]
				| undefined;
			if (!next) break;
			const [instanceId, instance] = next;
			runtime.vehicleEnrichmentQueue.delete(instanceId);
			if (ctx.augmented.instancesRec.get(instanceId) !== instance) continue;
			addVehicleModel(instance, ctx, ctx.config);
		}
	} finally {
		runtime.vehicleEnrichmentActive = false;
	}
}

export function registerAugmentedTrip(ctx: CacheContext, trip: AugmentedTrip): void {
	const { augmented } = ctx;
	const tripId = entityKey({ feedId: trip.feed_id, localId: trip.trip_id });

	for (const instance of trip.instances) {
		augmented.instancesRec.set(instance.instance_id, instance);
		for (const date of instance.actualTripDates) {
			addOwnedMembership(
				augmented.serviceDateTripsSet,
				augmented.serviceDateTrips,
				augmented.serviceDatesByTrip,
				date,
				tripId,
			);
		}

		for (const st of instance.stopTimes) {
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
				augmented.stopDeparturesCached.delete(stopId);
			}

			if (st.passing && st.actual_stop_id) {
				const stopKey = entityKey({ feedId: st.feed_id, localId: st.actual_stop_id });
				addOwnedMembership(
					augmented.passingTripsSet,
					augmented.passingTrips,
					augmented.passingStopsByTrip,
					stopKey,
					tripId,
				);
			}
		}
	}

	enrichRegisteredTripInstances(ctx, trip.instances);
}

function refreshDiagramAfterInstanceChange(ctx: CacheContext, affectedTripIds: Set<string>): void {
	const topology = ctx.augmented.seqDiagram;
	if (!topology) return;
	applySeqDiagramToInstances(ctx, topology);
	revalidateSeqDiagramRealtimeEdges(ctx, affectedTripIds);
}

function evictStartServiceDate(ctx: CacheContext, serviceDate: string): void {
	if (ctx.runtimeState.operationalServiceDates.has(serviceDate)) return;
	const affectedDates = new Set<string>([serviceDate]);
	const affectedTripIds = new Set<string>();
	const tripIds = getServiceDateTripSet(ctx, serviceDate);
	if (!tripIds) return;

	for (const tripKey of tripIds) {
		const trip = ctx.augmented.tripsRec.get(tripKey);
		if (!trip) continue;
		const removed = trip.instances.filter((instance) => instance.serviceDate === serviceDate);
		if (removed.length === 0) continue;
		for (const instance of removed) {
			for (const date of instance.actualTripDates) affectedDates.add(date);
		}
		unregisterAugmentedTrip(ctx, tripKey);
		trip.instances = trip.instances.filter((instance) => instance.serviceDate !== serviceDate);
		trip.scheduledStartServiceDates = trip.scheduledStartServiceDates.filter((date) => date !== serviceDate);
		registerAugmentedTrip(ctx, trip);
		affectedTripIds.add(trip.trip_id);
	}

	for (const date of affectedDates) ctx.augmented.runSeriesCache.delete(date);
	refreshDiagramAfterInstanceChange(ctx, affectedTripIds);
}

function touchLazyServiceDate(ctx: CacheContext, serviceDate: string): void {
	const lru = ctx.runtimeState.lazyServiceDates;
	lru.delete(serviceDate);
	lru.set(serviceDate, true);
	while (lru.size > MAX_LAZY_SERVICE_DATES) {
		const oldest = lru.keys().next().value as string | undefined;
		if (oldest === undefined) break;
		lru.delete(oldest);
		evictStartServiceDate(ctx, oldest);
	}
}

/** Materialize one calendar start date into the authoritative augmented indexes. */
export function ensureStartServiceDateMaterialized(ctx: CacheContext, serviceDate: string): void {
	if (!/^\d{8}$/.test(serviceDate) || !Number.isFinite(getEpochDayFromServiceDate(serviceDate))) return;
	if (ctx.runtimeState.operationalServiceDates.has(serviceDate)) return;
	if (ctx.runtimeState.lazyServiceDates.has(serviceDate)) {
		touchLazyServiceDate(ctx, serviceDate);
		return;
	}

	const epochDay = getEpochDayFromServiceDate(serviceDate);
	const affectedTripIds = new Set<string>();
	for (const [tripKey, rawTrip] of ctx.augmented.rawTripsRec) {
		const tripRef = { feedId: rawTrip.feed_id, localId: rawTrip.trip_id };
		const scheduled = getServiceDatesByTrip(tripRef, ctx, epochDay, epochDay).includes(serviceDate);
		const hasRealtime = (ctx.augmented.tripUpdatesCache.get(tripKey) ?? []).some(
			(update) => update.trip.start_date === serviceDate,
		);
		if (!scheduled && !hasRealtime) continue;

		const existing = ctx.augmented.tripsRec.get(tripKey);
		const dateTrip = augmentTrip(rawTrip, ctx, ctx.augmented.tripUpdatesCache, existing, {
			serviceDates: scheduled ? [serviceDate] : [],
			realtimeDates: [serviceDate],
		});
		const nextInstances = dateTrip.instances.filter((instance) => instance.serviceDate === serviceDate);
		if (nextInstances.length === 0) continue;
		if (!existing) {
			dateTrip.instances = nextInstances;
			ctx.augmented.tripsRec.set(tripKey, dateTrip);
			replaceAugmentedTripInArray(ctx, dateTrip);
			registerAugmentedTrip(ctx, dateTrip);
			patchSeqDiagramOntoAugmentedTrip(ctx, dateTrip);
			affectedTripIds.add(dateTrip.trip_id);
			continue;
		}

		unregisterAugmentedTrip(ctx, tripKey);
		existing.instances = existing.instances
			.filter((instance) => instance.serviceDate !== serviceDate)
			.concat(nextInstances)
			.sort((a, b) => a.serviceDate.localeCompare(b.serviceDate) || a.instance_id.localeCompare(b.instance_id));
		if (scheduled && !existing.scheduledStartServiceDates.includes(serviceDate)) {
			existing.scheduledStartServiceDates.push(serviceDate);
			existing.scheduledStartServiceDates.sort();
		}
		registerAugmentedTrip(ctx, existing);
		affectedTripIds.add(existing.trip_id);
	}

	touchLazyServiceDate(ctx, serviceDate);
	refreshDiagramAfterInstanceChange(ctx, affectedTripIds);
}

/** Date-filter index. The previous start date is included for GTFS times beyond 24:00. */
export function getTripIdsByServiceDate(ctx: CacheContext, serviceDate: string): string[] {
	for (let offset = -ctx.runtimeState.maxTripLookbackDays; offset <= 0; offset++) {
		ensureStartServiceDateMaterialized(ctx, addDaysToServiceDate(serviceDate, offset));
	}
	return materializeMembershipArray(ctx.augmented.serviceDateTripsSet, ctx.augmented.serviceDateTrips, serviceDate);
}

/** Calendar availability without eagerly constructing trip instances. */
export function getAvailableServiceDates(ctx: CacheContext): string[] {
	if (ctx.runtimeState.availableServiceDates) return ctx.runtimeState.availableServiceDates;
	const representativeByService = new Map<string, qdf.Trip>();
	for (const [tripKey, trip] of ctx.augmented.rawTripsRec) {
		const serviceKey = ctx.raw.tripServiceIds?.get(tripKey);
		if (serviceKey && !representativeByService.has(serviceKey)) representativeByService.set(serviceKey, trip);
	}
	const dates = new Set<string>();
	for (const trip of representativeByService.values()) {
		for (const date of getServiceDatesByTrip({ feedId: trip.feed_id, localId: trip.trip_id }, ctx)) dates.add(date);
	}
	ctx.runtimeState.availableServiceDates = Array.from(dates).sort();
	return ctx.runtimeState.availableServiceDates;
}

export function getStopDeparturesCached(
	ctx: CacheContext,
	stop: QualifiedEntityId,
	serviceDate: string,
): AugmentedStopTime[] {
	ensureStartServiceDateMaterialized(ctx, serviceDate);
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
	const tripIdsForDate = getServiceDateTripSet(ctx, serviceDate);

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

/**
 * Realtime updates can replace a scheduled instance ID while a client still
 * has the old URL open. Only follow that replacement when the trip/date has a
 * single instance, so frequency services cannot be silently misidentified.
 */
export function findUniqueTripInstanceForServiceDate(
	instances: readonly AugmentedTripInstance[],
	serviceDate: string,
): AugmentedTripInstance | null {
	let match: AugmentedTripInstance | null = null;
	for (const instance of instances) {
		if (instance.serviceDate !== serviceDate) continue;
		if (match) return null;
		match = instance;
	}
	return match;
}

export function getAugmentedTrips(ctx: CacheContext, trip?: QualifiedEntityId): AugmentedTrip[] {
	const context = ctx;
	const { augmented } = context;
	if (trip) {
		const key = entityKey(trip);
		const cachedTrip = augmented.tripsRec.get(key);
		if (cachedTrip) return [cachedTrip];
		const rawTrip = getTrips(ctx, { feed_id: trip.feedId, trip_id: trip.localId })[0];
		if (rawTrip && getRawStopTimes(ctx, trip).length > 0) {
			const augmentedTrip = augmentTrip(rawTrip, context);
			registerAugmentedTrip(ctx, augmentedTrip);
			augmented.tripsRec.set(key, augmentedTrip);
			replaceAugmentedTripInArray(ctx, augmentedTrip);
			patchSeqDiagramOntoAugmentedTrip(context, augmentedTrip);
			return [augmentedTrip];
		}
		return [];
	}
	return Array.from(augmented.tripsRec.values());
}

export function getAugmentedTripInstance(ctx: CacheContext, instance_id: string): AugmentedTripInstance | null {
	const cached = ctx.augmented.instancesRec.get(instance_id);
	if (cached) return cached;

	try {
		const identity = decodeTripInstanceId(instance_id);
		if (identity.networkId !== ctx.config.network.id) return null;
		ensureStartServiceDateMaterialized(ctx, identity.serviceDate);
		const tripRef = { feedId: identity.feedId, localId: identity.localId };
		const trip = ctx.augmented.tripsRec.get(entityKey(tripRef));
		if (trip) {
			const inst = trip.instances.find((v) => v.instance_id === instance_id);
			if (inst) {
				ctx.augmented.instancesRec.set(instance_id, inst);
				return inst;
			}
			const replacement = findUniqueTripInstanceForServiceDate(trip.instances, identity.serviceDate);
			if (replacement) return replacement;
		}

		// Fallback for lazily materialized or replaced instance identifiers.
		const instances = getAugmentedTrips(ctx, tripRef)[0]?.instances ?? [];
		return (
			instances.find((v) => v.instance_id === instance_id) ??
			findUniqueTripInstanceForServiceDate(instances, identity.serviceDate)
		);
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
		ensureStartServiceDateMaterialized(ctx, startDate);
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
	if (trip) return augmented.tripsRec.get(entityKey(trip))?.instances.flatMap((instance) => instance.stopTimes) ?? [];
	return Array.from(augmented.tripsRec.values()).flatMap((value) =>
		value.instances.flatMap((instance) => instance.stopTimes),
	);
}

/** Scan augmented stop-times without first flattening the full dated graph. */
export function getAugmentedRawStopTimePage(
	ctx: CacheContext,
	options: {
		offset: number;
		limit: number;
		predicate?: (value: qdf.StopTime | null) => boolean;
	},
): { values: Array<qdf.StopTime | null>; totalCount: number } {
	const values: Array<qdf.StopTime | null> = [];
	let totalCount = 0;
	for (const trip of ctx.augmented.tripsRec.values()) {
		for (const instance of trip.instances) {
			for (const stopTime of instance.stopTimes) {
				const value = stopTime._stopTime;
				if (options.predicate && !options.predicate(value)) continue;
				if (totalCount >= options.offset && values.length < options.limit) values.push(value);
				totalCount++;
			}
		}
	}
	return { values, totalCount };
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
	return getAugmentedStopTimes(ctx, trip);
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
	return materializeMembershipArray(augmented.passingTripsSet, augmented.passingTrips, entityKey(stop));
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
	ensureStartServiceDateMaterialized(ctx, date);
	const context = ctx;
	const { augmented } = context;

	let dateMap = augmented.runSeriesCache.get(date);
	if (!dateMap) {
		dateMap = new Map();
		augmented.runSeriesCache.set(date, dateMap);
	}
	const tripIdsForDate = getServiceDateTripSet(ctx, date);
	let matchingTripKey: string | undefined;
	if (!dateMap.get(runSeries) && calcIfNotFound && tripIdsForDate) {
		for (const key of tripIdsForDate) {
			if (augmented.tripsRec.get(key)?.trip_id.endsWith(runSeries)) {
				matchingTripKey = key;
				break;
			}
		}
	}
	if (matchingTripKey) {
		const trip = augmented.tripsRec.get(matchingTripKey)!;
		const instance = trip.instances.find((i) => i.serviceDate === date);
		if (instance) {
			calculateRunSeries(instance, context);
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
