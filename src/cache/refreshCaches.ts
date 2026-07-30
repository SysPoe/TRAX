import type { GTFS, Trip, Stop } from "qdf-gtfs";
import { isConsideredTrip } from "../utils/considered.js";
import { syncCalendarsToWasm } from "../utils/calendar.js";
import { augmentStop } from "../utils/augmentedStop.js";
import type { AugmentedStop } from "../utils/augmentedStop.js";
import { augmentTrip } from "../utils/augmentedTrip.js";
import { clearAugmentedStopTimeCaches } from "../utils/augmentedStopTime.js";
import { getCurrentQRTravelTrains, getPlacesWithCache } from "../region-specific/AU/SEQ/qr-travel/qr-travel-tracker.js";
import {
	buildQRTStationLookupMap,
	getQRTStations,
	normalizeQRTStationLookupKey,
} from "../region-specific/AU/SEQ/qr-travel/stations.js";
import { getRailwayStationFacilities } from "../region-specific/AU/SEQ/facilities.js";
import type { QRTPlace, QRTStationDetails, QRTTravelTrip } from "../region-specific/AU/SEQ/qr-travel/types.js";
import type { RailwayStationFacility } from "../region-specific/AU/SEQ/facilities-types.js";
import { updateAllSources as updateGTHAPlatforms } from "../region-specific/CA/GTHA/realtime.js";
import logger from "../utils/logger.js";
import { ensureServiceCapacityData } from "../utils/serviceCapacity.js";
import { isRegion, type TraxConfig } from "../config.js";
import { addWasmStop } from "../../build/release.js";
import { clearConsideredCaches } from "../utils/considered.js";
import { buildAndApplySeqDiagram, refreshSeqDiagramAfterRealtimeBatch } from "../region-specific/AU/SEQ/seq-diagram.js";
import type { CacheContext } from "./types.js";
import { createEmptyRawCache, createAugmentedCacheWithConfig } from "./factories.js";
import { registerAugmentedTrip, unregisterAugmentedTrip } from "./augmentedEntities.js";
import { clearPreviousVehicleInfo, prunePreviousVehicleInfo } from "../utils/vehicleModel.js";

function refreshQRTTrainsInBackground(ctx: CacheContext): void {
	if (ctx.augmented.qrtRefreshInFlight) return;

	logger.debug("Refreshing qrtTrains cache in background...", {
		module: "cache",
		function: "refreshRealtimeCache",
	});

	const refreshPromise = getCurrentQRTravelTrains(ctx)
		.then((trains: QRTTravelTrip[]) => {
			// Replace the snapshot atomically. Readers continue using the prior
			// successful value while this request is in flight.
			ctx.raw.regionSpecific.SEQ.qrtTrains = trains;
			logger.debug(`Loaded ${trains.length} QRT trains.`, {
				module: "cache",
				function: "refreshRealtimeCache",
			});
		})
		.catch((error) => {
			const message = error instanceof Error ? error.message : String(error);
			logger.error("Failed to load QRT trains: " + message, {
				module: "cache",
				function: "refreshRealtimeCache",
			});
		})
		.finally(() => {
			if (ctx.augmented.qrtRefreshInFlight === refreshPromise) {
				ctx.augmented.qrtRefreshInFlight = undefined;
			}
		});

	// The promise owns its rejection handler above, so callers do not need to
	// await QRT for core GTFS realtime readiness.
	ctx.augmented.qrtRefreshInFlight = refreshPromise;
}

function tripUpdateSignature(updates: readonly unknown[]): string {
	return JSON.stringify(updates);
}

function findChangedRealtimeTripIds(
	previous: ReadonlyMap<string, string>,
	next: ReadonlyMap<string, string>,
	availableTripIds: ReadonlySet<string>,
): Set<string> {
	const changed = new Set<string>();
	for (const tripId of new Set([...previous.keys(), ...next.keys()])) {
		if (previous.get(tripId) !== next.get(tripId) && availableTripIds.has(tripId)) {
			changed.add(tripId);
		}
	}
	return changed;
}

function resetRealtimeCacheIncremental(updatedTripIds: Set<string>, ctx: CacheContext): void {
	const { augmented: augmentedCache } = ctx;

	for (const tripId of updatedTripIds) {
		unregisterAugmentedTrip(ctx, tripId);
		augmentedCache.tripsRec.delete(tripId);
		delete augmentedCache.stopTimes[tripId];
		delete augmentedCache.baseStopTimes[tripId];
	}

	for (const [serviceDate, tripIds] of augmentedCache.serviceDateTrips) {
		const filteredTripIds = tripIds.filter((id) => !updatedTripIds.has(id));
		if (filteredTripIds.length === 0) {
			augmentedCache.serviceDateTrips.delete(serviceDate);
			augmentedCache.serviceDateTripsSet.delete(serviceDate);
		} else {
			augmentedCache.serviceDateTrips.set(serviceDate, filteredTripIds);
			augmentedCache.serviceDateTripsSet.set(serviceDate, new Set(filteredTripIds));
		}
	}

	for (const [stopId, tripIds] of augmentedCache.passingTrips) {
		const filteredTripIds = tripIds.filter((id) => !updatedTripIds.has(id));
		if (filteredTripIds.length === 0) {
			augmentedCache.passingTrips.delete(stopId);
		} else {
			augmentedCache.passingTrips.set(stopId, filteredTripIds);
		}
	}
}

async function loadSEQStaticMetadata(ctx: CacheContext): Promise<void> {
	const { config } = ctx;
	const seq = ctx.raw.regionSpecific.SEQ;

	const loadPlaces = async () => {
		ctx.augmented.timer.start("refreshStaticCache:loadQRTPlaces");
		try {
			return await getPlacesWithCache(config);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.error("Failed to load QRT places: " + message, {
				module: "cache",
				function: "refreshStaticCache",
			});
			return [];
		} finally {
			ctx.augmented.timer.stop("refreshStaticCache:loadQRTPlaces");
		}
	};

	const loadStations = async () => {
		ctx.augmented.timer.start("refreshStaticCache:loadQRTStations");
		try {
			return await getQRTStations(config);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.error("Failed to load QRT stations: " + message, {
				module: "cache",
				function: "refreshStaticCache",
			});
			return {};
		} finally {
			ctx.augmented.timer.stop("refreshStaticCache:loadQRTStations");
		}
	};

	const loadFacilities = async () => {
		ctx.augmented.timer.start("refreshStaticCache:loadRailwayFacilities");
		try {
			return await getRailwayStationFacilities(config);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.error("Failed to load railway station facilities: " + message, {
				module: "cache",
				function: "refreshStaticCache",
			});
			return [];
		} finally {
			ctx.augmented.timer.stop("refreshStaticCache:loadRailwayFacilities");
		}
	};

	const [places, stations, facilities] = await Promise.all([loadPlaces(), loadStations(), loadFacilities()]);
	seq.qrtPlaces = places;
	seq.qrtStations = stations;
	seq.railwayStationFacilities = facilities;

	const stationLookup = buildQRTStationLookupMap(stations);
	for (const place of places) {
		const station =
			stationLookup.get(place.qrt_PlaceCode) ?? stationLookup.get(normalizeQRTStationLookupKey(place.Title));
		if (station && !station.qrt_PlaceCode) station.qrt_PlaceCode = place.qrt_PlaceCode;
	}

	logger.debug(`Loaded ${places.length} QRT places.`, {
		module: "cache",
		function: "refreshStaticCache",
	});
	logger.debug(`Loaded ${Object.keys(stations).length} QRT stations.`, {
		module: "cache",
		function: "refreshStaticCache",
	});
	logger.debug(`Loaded ${facilities.length} railway station facilities.`, {
		module: "cache",
		function: "refreshStaticCache",
	});
}

export async function refreshStaticCache(
	gtfs: GTFS,
	config: TraxConfig,
	previousCtx?: CacheContext,
): Promise<CacheContext> {
	logger.debug("Refreshing static GTFS cache...", {
		module: "cache",
		function: "refreshStaticCache",
	});

	const newRawCache = createEmptyRawCache();
	newRawCache.regionSpecific.SEQ.qrtTrains = previousCtx?.raw.regionSpecific.SEQ.qrtTrains ?? [];
	const newAugmentedCache = createAugmentedCacheWithConfig(config);
	const ctx: CacheContext = { raw: newRawCache, augmented: newAugmentedCache, config, gtfs };
	const startTotal = Date.now();
	ctx.augmented.timer.clear();
	ctx.augmented.timer.start("refreshStaticCache");
	clearConsideredCaches();
	clearAugmentedStopTimeCaches();
	clearPreviousVehicleInfo();
	const { resetNetworkTopologyForStaticFeed } = await import("../utils/SRT.js");
	resetNetworkTopologyForStaticFeed(config);

	const serviceDateTripsMap = new Map<string, Set<string>>();
	const passingTripsMap = new Map<string, Set<string>>();
	const seqStaticMetadataPromise = isRegion(config.region, "AU/SEQ") ? loadSEQStaticMetadata(ctx) : Promise.resolve();

	ctx.augmented.timer.start("refreshStaticCache:preloadTripUpdates");
	const allUpdates = gtfs.getRealtimeTripUpdates();
	const injected = ctx.raw.injectedTripUpdates ?? [];
	for (const update of allUpdates.concat(injected)) {
		const tripId = update.trip.trip_id;
		if (!tripId) continue;

		const existing = ctx.augmented.tripUpdatesCache.get(tripId);
		if (existing) {
			existing.push(update);
		} else {
			ctx.augmented.tripUpdatesCache.set(tripId, [update]);
		}
	}
	for (const [tripId, updates] of ctx.augmented.tripUpdatesCache) {
		ctx.augmented.tripUpdateSignatures.set(tripId, tripUpdateSignature(updates));
	}
	ctx.augmented.timer.stop("refreshStaticCache:preloadTripUpdates");

	ctx.augmented.timer.start("refreshStaticCache:loadStops");
	const stops = gtfs.getStops();
	ctx.augmented.timer.stop("refreshStaticCache:loadStops");
	logger.debug(`Loaded ${stops.length} stops.`, {
		module: "cache",
		function: "refreshStaticCache",
	});

	ctx.augmented.timer.start("refreshStaticCache:loadCalendars");
	const calendars = gtfs.getCalendars();
	ctx.augmented.timer.stop("refreshStaticCache:loadCalendars");
	logger.debug(`Loaded ${calendars.length} calendars.`, {
		module: "cache",
		function: "refreshStaticCache",
	});

	ctx.augmented.timer.start("refreshStaticCache:loadCalendarDates");
	const calendarDates = gtfs.getCalendarDates();
	ctx.augmented.timer.stop("refreshStaticCache:loadCalendarDates");
	logger.debug(`Loaded ${calendarDates.length} calendar dates.`, {
		module: "cache",
		function: "refreshStaticCache",
	});

	ctx.augmented.timer.start("refreshStaticCache:syncToWasm");
	syncCalendarsToWasm(ctx);
	ctx.augmented.timer.stop("refreshStaticCache:syncToWasm");

	ctx.augmented.timer.start("refreshStaticCache:loadRoutes");
	const routes = gtfs.getRoutes();
	ctx.augmented.timer.stop("refreshStaticCache:loadRoutes");
	logger.debug(`Loaded ${routes.length} routes.`, {
		module: "cache",
		function: "refreshStaticCache",
	});

	ctx.augmented.timer.start("refreshStaticCache:loadTrips");
	const allTrips = gtfs.getTrips();
	const trips = allTrips.filter((v: Trip) => isConsideredTrip(v, gtfs));
	for (const t of allTrips) {
		newRawCache.tripServiceIds!.set(t.trip_id, t.service_id);
	}
	for (const trip of trips) newAugmentedCache.rawTripsRec.set(trip.trip_id, trip);
	ctx.augmented.timer.stop("refreshStaticCache:loadTrips");
	logger.debug(`Loaded ${trips.length} considered trips out of ${allTrips.length} total.`, {
		module: "cache",
		function: "refreshStaticCache",
	});

	if (config.preloadStopTimes) {
		ctx.augmented.timer.start("refreshStaticCache:preloadStopTimes");
		for (const trip of trips) {
			const stopTimes = gtfs.getStopTimes({ trip_id: trip.trip_id });
			ctx.augmented.rawStopTimesCache.set(trip.trip_id, stopTimes);
		}
		ctx.augmented.timer.stop("refreshStaticCache:preloadStopTimes");
	}

	ctx.augmented.timer.start("refreshStaticCache:processShapes");
	const shapeSet = new Set<string>();
	for (const trip of trips) {
		if (trip.shape_id && !shapeSet.has(trip.shape_id)) {
			shapeSet.add(trip.shape_id);
			newAugmentedCache.shapes.push({ shape_id: trip.shape_id, route_id: trip.route_id });
		}
	}
	ctx.augmented.timer.stop("refreshStaticCache:processShapes");

	ctx.augmented.timer.start("refreshStaticCache:ensureServiceCapacity");
	await Promise.all([ensureServiceCapacityData(config), seqStaticMetadataPromise]);
	ctx.augmented.timer.stop("refreshStaticCache:ensureServiceCapacity");

	ctx.augmented.timer.start("refreshStaticCache:prepAugmentStops");
	// Sync stops into WASM for downstream augmentation (passing stop detection, parent lookup)
	for (let i = 0; i < stops.length; i++) {
		const s = stops[i];
		addWasmStop(s.stop_id, s.parent_station ?? "", s.platform_code ?? "");
	}

	const childrenByParent = new Map<string, Stop[]>();
	for (const s of stops) {
		if (!s.parent_station) continue;
		const list = childrenByParent.get(s.parent_station) ?? [];
		list.push(s);
		childrenByParent.set(s.parent_station, list);
	}

	const qrtPlacesByName = new Map<string, QRTPlace>();
	const qrtStationsByKey = new Map<string, QRTStationDetails>();
	const facilitiesByStopId = new Map<string, RailwayStationFacility>();
	if (isRegion(config.region, "AU/SEQ")) {
		for (const p of newRawCache.regionSpecific.SEQ.qrtPlaces ?? []) {
			if (!p?.Title) continue;
			const key = p.Title.toLowerCase().replace("station", "").trim();
			qrtPlacesByName.set(key, p);
		}
		for (const [key, station] of buildQRTStationLookupMap(newRawCache.regionSpecific.SEQ.qrtStations ?? {})) {
			if (!qrtStationsByKey.has(key)) qrtStationsByKey.set(key, station);
		}
		const facilities = newRawCache.regionSpecific.SEQ.railwayStationFacilities ?? [];
		for (const f of facilities) {
			if (!f?.stops) continue;
			for (const sId of f.stops) {
				if (!facilitiesByStopId.has(sId)) facilitiesByStopId.set(sId, f);
			}
		}
	}
	ctx.augmented.timer.stop("refreshStaticCache:prepAugmentStops");

	ctx.augmented.timer.start("refreshStaticCache:augmentStops");
	newAugmentedCache.stops = stops.map((stop) =>
		augmentStop(stop, ctx, {
			childrenByParent,
			qrtPlacesByName: qrtPlacesByName.size ? qrtPlacesByName : undefined,
			qrtStationsByKey: qrtStationsByKey.size ? qrtStationsByKey : undefined,
			facilitiesByStopId: facilitiesByStopId.size ? facilitiesByStopId : undefined,
		}),
	);
	ctx.augmented.timer.stop("refreshStaticCache:augmentStops");
	logger.debug(`Augmented ${newAugmentedCache.stops.length} stops.`, {
		module: "cache",
		function: "refreshStaticCache",
	});

	// Prime stop lookup map
	ctx.augmented.timer.start("refreshStaticCache:primeStopMap");
	for (const stop of newAugmentedCache.stops) newAugmentedCache.stopsRec.set(stop.stop_id, stop);

	// Link parents and children
	for (const stop of newAugmentedCache.stops) {
		if (stop.parent_stop_id) {
			stop.parent = newAugmentedCache.stopsRec.get(stop.parent_stop_id) ?? null;
		}
		if (stop.child_stop_ids) {
			stop.children = stop.child_stop_ids
				.map((id) => newAugmentedCache.stopsRec.get(id))
				.filter((s): s is AugmentedStop => !!s);
		}
	}
	ctx.augmented.timer.stop("refreshStaticCache:primeStopMap");

	ctx.augmented.timer.start("refreshStaticCache:augmentTrips");
	const tripUpdatesCache = ctx.augmented.tripUpdatesCache;
	newAugmentedCache.trips = await processWithProgress(trips, "Augmenting trips", (trip) => {
		const augmentedTrip = augmentTrip(trip, ctx, tripUpdatesCache);

		newAugmentedCache.tripsRec.set(augmentedTrip.trip_id, augmentedTrip);
		registerAugmentedTrip(ctx, augmentedTrip);

		const allStopTimes = augmentedTrip.instances.flatMap((i) => i.stopTimes);
		newAugmentedCache.stopTimes[augmentedTrip.trip_id] = allStopTimes;
		newAugmentedCache.baseStopTimes[augmentedTrip.trip_id] = [...allStopTimes];

		for (const instance of augmentedTrip.instances) {
			for (const date of instance.actualTripDates) {
				let tripIdSet = serviceDateTripsMap.get(date);
				if (!tripIdSet) {
					tripIdSet = new Set();
					serviceDateTripsMap.set(date, tripIdSet);
				}
				tripIdSet.add(augmentedTrip.trip_id);
			}

			for (const st of instance.stopTimes) {
				if (st.passing && st.actual_stop_id) {
					const stopId = st.actual_stop_id;
					let tripIdSet = passingTripsMap.get(stopId);
					if (!tripIdSet) {
						tripIdSet = new Set();
						passingTripsMap.set(stopId, tripIdSet);
					}
					tripIdSet.add(augmentedTrip.trip_id);
				}
			}
		}

		return augmentedTrip;
	});
	ctx.augmented.timer.stop("refreshStaticCache:augmentTrips");

	ctx.augmented.timer.start("refreshStaticCache:buildServiceDateTrips");
	for (const [date, set] of serviceDateTripsMap) {
		newAugmentedCache.serviceDateTrips.set(date, Array.from(set));
		newAugmentedCache.serviceDateTripsSet.set(date, set);
	}
	ctx.augmented.timer.stop("refreshStaticCache:buildServiceDateTrips");

	ctx.augmented.timer.start("refreshStaticCache:buildPassingTrips");
	for (const [stopId, set] of passingTripsMap) {
		newAugmentedCache.passingTrips.set(stopId, Array.from(set));
	}
	ctx.augmented.timer.stop("refreshStaticCache:buildPassingTrips");

	if (isRegion(config.region, "AU/SEQ")) {
		ctx.augmented.timer.start("refreshStaticCache:seqDiagram");
		buildAndApplySeqDiagram(ctx, gtfs, trips);
		ctx.augmented.timer.stop("refreshStaticCache:seqDiagram");
	}

	ctx.augmented.timer.stop("refreshStaticCache");
	ctx.augmented.timer.log("Static Cache Refresh", true);

	logger.info(`Static GTFS cache refreshed in ${((Date.now() - (startTotal as number)) / 1000).toFixed(2)}s.`, {
		module: "cache",
		function: "refreshStaticCache",
	});

	return ctx;
}

export async function refreshRealtimeCache(gtfs: GTFS, config: TraxConfig, ctx: CacheContext): Promise<void> {
	const startTotal = Date.now();
	ctx.augmented.timer.start("refreshRealtimeCache");
	const { augmented: augmentedCache } = ctx;

	logger.debug("Refreshing realtime GTFS cache...", {
		module: "cache",
		function: "refreshRealtimeCache",
	});

	if (isRegion(config.region, "AU/SEQ")) {
		refreshQRTTrainsInBackground(ctx);
	}

	logger.debug("Loading realtime updates...", {
		module: "cache",
		function: "refreshRealtimeCache",
	});

	const tripUpdates = gtfs.getRealtimeTripUpdates();
	const allTripUpdates = tripUpdates.concat(ctx.raw.injectedTripUpdates ?? []);
	const nextUpdatesByTrip = new Map<string, typeof allTripUpdates>();
	for (const update of allTripUpdates) {
		const tripId = update.trip.trip_id;
		if (!tripId) continue;
		const updates = nextUpdatesByTrip.get(tripId);
		if (updates) updates.push(update);
		else nextUpdatesByTrip.set(tripId, [update]);
	}
	const nextSignatures = new Map<string, string>();
	for (const [tripId, updates] of nextUpdatesByTrip) {
		nextSignatures.set(tripId, tripUpdateSignature(updates));
	}

	logger.debug(
		`Loaded ${tripUpdates.length} trip updates with ${tripUpdates.flatMap((v) => v.stop_time_updates).length} stop time updates.`,
		{
			module: "cache",
			function: "refreshRealtimeCache",
		},
	);
	const availableTripIds = new Set<string>();
	for (const tripId of augmentedCache.tripsRec.keys()) {
		if (augmentedCache.rawTripsRec.has(tripId)) availableTripIds.add(tripId);
	}
	const updatedTripIds = findChangedRealtimeTripIds(
		augmentedCache.tripUpdateSignatures,
		nextSignatures,
		availableTripIds,
	);
	augmentedCache.tripUpdatesCache.clear();
	for (const [tripId, updates] of nextUpdatesByTrip) {
		augmentedCache.tripUpdatesCache.set(tripId, updates);
	}
	augmentedCache.tripUpdateSignatures.clear();
	for (const [tripId, signature] of nextSignatures) {
		augmentedCache.tripUpdateSignatures.set(tripId, signature);
	}

	logger.debug(`Found ${updatedTripIds.size} augmented trips with changed realtime state.`, {
		module: "cache",
		function: "refreshRealtimeCache",
	});

	if (updatedTripIds.size === 0) {
		logger.debug("No trips have realtime updates, skipping re-augmentation.", {
			module: "cache",
			function: "refreshRealtimeCache",
		});
	} else {
		const reusableTrips = new Map<string, ReturnType<typeof augmentTrip>>();
		for (const tripId of updatedTripIds) {
			const existing = augmentedCache.tripsRec.get(tripId);
			if (existing) reusableTrips.set(tripId, existing);
		}
		resetRealtimeCacheIncremental(updatedTripIds, ctx);

		logger.debug("Re-augmenting updated trips...", {
			module: "cache",
			function: "refreshRealtimeCache",
		});

		const tripsToUpdate = Array.from(updatedTripIds, (tripId) => augmentedCache.rawTripsRec.get(tripId)).filter(
			(t): t is Trip => t !== undefined,
		);

		const updatedAugmented = await processWithProgress(tripsToUpdate, "Re-augmenting updated trips", (t) =>
			augmentTrip(t, ctx, ctx.augmented.tripUpdatesCache, reusableTrips.get(t.trip_id)),
		);

		for (const at of updatedAugmented) {
			augmentedCache.tripsRec.set(at.trip_id, at);
			registerAugmentedTrip(ctx, at);
		}

		augmentedCache.trips = Array.from(augmentedCache.tripsRec.values());

		logger.debug(`Re-augmented ${updatedTripIds.size} trips.`, {
			module: "cache",
			function: "refreshRealtimeCache",
		});

		logger.debug("Building augmented cache records for updated trips...", {
			module: "cache",
			function: "refreshRealtimeCache",
		});

		for (const tripId of updatedTripIds) {
			const trip = augmentedCache.tripsRec.get(tripId);
			if (!trip) continue;

			const allStopTimes = trip.instances.flatMap((i) => i.stopTimes);

			augmentedCache.stopTimes[trip.trip_id] = allStopTimes;
			augmentedCache.baseStopTimes[trip.trip_id] = [...allStopTimes];

			for (const instance of trip.instances) {
				for (const date of instance.actualTripDates) {
					let tripIds = augmentedCache.serviceDateTrips.get(date);
					if (!tripIds) {
						tripIds = [];
						augmentedCache.serviceDateTrips.set(date, tripIds);
					}
					if (!tripIds.includes(trip.trip_id)) tripIds.push(trip.trip_id);

					let tripSet = augmentedCache.serviceDateTripsSet.get(date);
					if (!tripSet) {
						tripSet = new Set(tripIds);
						augmentedCache.serviceDateTripsSet.set(date, tripSet);
					}
					tripSet.add(trip.trip_id);
				}

				for (const st of instance.stopTimes) {
					if (st.passing && st.actual_stop_id) {
						const stopId = st.actual_stop_id;
						let tripIds = augmentedCache.passingTrips.get(stopId);
						if (!tripIds) {
							tripIds = [];
							augmentedCache.passingTrips.set(stopId, tripIds);
						}
						if (!tripIds.includes(trip.trip_id)) tripIds.push(trip.trip_id);
					}
				}
			}
		}
		for (const stop of augmentedCache.stops) augmentedCache.stopsRec.set(stop.stop_id, stop);

		if (isRegion(config.region, "AU/SEQ")) {
			ctx.augmented.timer.start("refreshRealtimeCache:seqDiagram");
			refreshSeqDiagramAfterRealtimeBatch(ctx, updatedTripIds);
			ctx.augmented.timer.stop("refreshRealtimeCache:seqDiagram");
		}
	}

	if (isRegion(ctx.config.region, "CA/GTHA")) {
		await updateGTHAPlatforms(ctx, gtfs);
	}
	prunePreviousVehicleInfo(augmentedCache.instancesRec.keys());

	ctx.augmented.timer.stop("refreshRealtimeCache");
	ctx.augmented.timer.log("Realtime Cache Refresh", true);

	logger.info(`Realtime GTFS cache refreshed in ${((Date.now() - startTotal) / 1000).toFixed(2)}s.`, {
		module: "cache",
		function: "refreshRealtimeCache",
	});
}

async function processWithProgress<T, U>(
	items: T[],
	taskName: string,
	processFn: (item: T) => U,
	chunkSize = 250,
): Promise<U[]> {
	const results: U[] = [];
	let current = 0;
	const total = items.length;
	const startTime = Date.now();

	if (total === 0) return results;

	logger.progress({
		task: taskName,
		current: 0,
		total,
		speed: 0,
		eta: 0,
		percent: 0,
		unit: "items",
	});

	for (let i = 0; i < total; i += chunkSize) {
		const end = Math.min(i + chunkSize, total);
		for (let j = i; j < end; j++) {
			results.push(processFn(items[j]));
		}
		current = end;

		await new Promise((resolve) => setImmediate(resolve));

		const elapsed = (Date.now() - startTime) / 1000;
		const speed = elapsed > 0 ? current / elapsed : 0;

		logger.progress({
			task: taskName,
			current,
			total,
			speed,
			eta: speed > 0 ? (total - current) / speed : 0,
			percent: (current / total) * 100,
			unit: "items",
		});
	}

	return results;
}

export const _test = {
	tripUpdateSignature,
	findChangedRealtimeTripIds,
};
