import { TransferType, TripScheduleRelationship, type GTFS, type Trip, type Stop } from "qdf-gtfs";
import { isConsideredRoute, isConsideredTrip } from "../utils/considered.js";
import { syncCalendarsToWasm } from "../utils/calendar.js";
import { augmentStop } from "../utils/augmentedStop.js";
import type { AugmentedStop } from "../utils/augmentedStop.js";
import {
	augmentTrip,
	createRealtimeOnlyTrip,
	EAGER_SERVICE_DATE_FUTURE_DAYS,
	EAGER_SERVICE_DATE_PAST_DAYS,
} from "../utils/augmentedTrip.js";
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
import logger from "../utils/logger.js";
import { resolveTripNumber, type TraxConfig } from "../config.js";
import { clearConsideredCaches } from "../utils/considered.js";
import type { CacheContext } from "./types.js";
import { createEmptyRawCache, createAugmentedCacheWithConfig, createRuntimeState } from "./factories.js";
import {
	registerAugmentedTrip,
	unregisterAugmentedTrip,
	rebuildAugmentedTripArrayIndex,
	replaceAugmentedTripInArray,
	removeAugmentedTripFromArray,
} from "./augmentedEntities.js";
import { clearPreviousVehicleInfo, prunePreviousVehicleInfo } from "../utils/vehicleModel.js";
import { entityKey } from "../identity.js";
import { getSeqState } from "../plugins/seq-state.js";
import { addDaysToServiceDate, getToday } from "../utils/time.js";
import { applyRealtimeReplacementPrecedence, canonicalizeRealtimeTripUpdates } from "./realtime.js";
import { getRawStopTimes, primeRawStopTimes } from "./gtfsReads.js";
import { buildCorridorIndex } from "../utils/corridor/shapeIndex.js";

type CacheProgressReporter = (info: Parameters<TraxConfig["progressLog"]>[0] & { unit?: "bytes" | "items" }) => void;

export function refreshQRTTrainsInBackground(ctx: CacheContext): void {
	if (ctx.augmented.qrtRefreshInFlight) return;

	logger.debug("Refreshing qrtTrains cache in background...", {
		module: "cache",
		function: "refreshRealtimeCache",
	});

	const refreshPromise = getCurrentQRTravelTrains(ctx)
		.then((trains: QRTTravelTrip[]) => {
			// Replace the snapshot atomically. Readers continue using the prior
			// successful value while this request is in flight.
			getSeqState(ctx).qrtTrains = trains;
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

function isRealtimeOnlyRelationship(relationship: TripScheduleRelationship): boolean {
	return (
		relationship === TripScheduleRelationship.ADDED ||
		relationship === TripScheduleRelationship.UNSCHEDULED ||
		relationship === TripScheduleRelationship.REPLACEMENT
	);
}

function createRealtimeOnlyTrips(
	updatesByTrip: ReadonlyMap<string, readonly import("qdf-gtfs").RealtimeTripUpdate[]>,
	ctx: CacheContext,
	usableStaticTripKeys?: ReadonlySet<string>,
): Trip[] {
	const result: Trip[] = [];
	for (const [tripKey, updates] of updatesByTrip) {
		if (
			usableStaticTripKeys?.has(tripKey) ||
			(ctx.augmented.rawTripsRec.has(tripKey) && !ctx.raw.realtimeOnlyTripKeys.has(tripKey))
		)
			continue;
		const update = updates.find(
			(candidate) =>
				isRealtimeOnlyRelationship(candidate.trip.schedule_relationship) &&
				candidate.stop_time_updates.filter((stopTime) => Boolean(stopTime.stop_id)).length > 1,
		);
		if (!update) continue;
		const route = ctx.raw.routesByKey.get(entityKey({ feedId: update.feed_id, localId: update.trip.route_id }));
		if (!route || !isConsideredRoute(route, ctx)) continue;
		result.push(createRealtimeOnlyTrip(update));
	}
	return result;
}

function findChangedRealtimeTripIds(
	previous: ReadonlyMap<string, string>,
	next: ReadonlyMap<string, string>,
	isAvailable: ReadonlySet<string> | ((tripId: string) => boolean),
): Set<string> {
	const changed = new Set<string>();
	for (const tripId of new Set([...previous.keys(), ...next.keys()])) {
		const available = typeof isAvailable === "function" ? isAvailable(tripId) : isAvailable.has(tripId);
		if (previous.get(tripId) !== next.get(tripId) && available) {
			changed.add(tripId);
		}
	}
	return changed;
}

function registerTripNumber(ctx: CacheContext, trip: Trip): void {
	const tripKey = entityKey({ feedId: trip.feed_id, localId: trip.trip_id });
	const tripNumber = resolveTripNumber(ctx.config.network, trip);
	const previousTripNumber = ctx.augmented.tripNumberByTrip.get(tripKey);
	if (previousTripNumber !== undefined && previousTripNumber !== tripNumber) {
		const previousTrips = ctx.augmented.tripNumberTrips.get(previousTripNumber);
		previousTrips?.delete(tripKey);
		if (previousTrips?.size === 0) ctx.augmented.tripNumberTrips.delete(previousTripNumber);
	}

	const tripNumberIds = ctx.augmented.tripNumberTrips.get(tripNumber) ?? new Set<string>();
	tripNumberIds.add(tripKey);
	ctx.augmented.tripNumberTrips.set(tripNumber, tripNumberIds);
	ctx.augmented.tripNumberByTrip.set(tripKey, tripNumber);
}

function resetRealtimeTripIncremental(tripId: string, ctx: CacheContext): void {
	const { augmented: augmentedCache } = ctx;

	unregisterAugmentedTrip(ctx, tripId);
	augmentedCache.tripsRec.delete(tripId);
	removeAugmentedTripFromArray(ctx, tripId);
	delete augmentedCache.stopTimes[tripId];
	delete augmentedCache.baseStopTimes[tripId];
}

function removeRealtimeOnlyTrip(ctx: CacheContext, tripKey: string): void {
	if (!ctx.raw.realtimeOnlyTripKeys.delete(tripKey)) return;

	ctx.raw.tripsByKey.delete(tripKey);
	ctx.raw.tripServiceIds?.delete(tripKey);
	ctx.augmented.rawTripsRec.delete(tripKey);

	const tripNumber = ctx.augmented.tripNumberByTrip.get(tripKey);
	if (tripNumber !== undefined) {
		const tripKeys = ctx.augmented.tripNumberTrips.get(tripNumber);
		tripKeys?.delete(tripKey);
		if (tripKeys?.size === 0) ctx.augmented.tripNumberTrips.delete(tripNumber);
	}
	ctx.augmented.tripNumberByTrip.delete(tripKey);
}

export async function loadSEQStaticMetadata(ctx: CacheContext): Promise<void> {
	const { config } = ctx;
	const seq = getSeqState(ctx);

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
	const newAugmentedCache = createAugmentedCacheWithConfig(config);
	const ctx: CacheContext = {
		raw: newRawCache,
		augmented: newAugmentedCache,
		config,
		gtfs,
		pluginState: new Map(),
		runtimeState: createRuntimeState(),
	};
	for (const feed of config.network.feeds) {
		const timezone = config.feedTimeZones.get(feed.id);
		if (!timezone) continue;
		const today = getToday(timezone);
		for (let offset = -EAGER_SERVICE_DATE_PAST_DAYS; offset <= EAGER_SERVICE_DATE_FUTURE_DAYS; offset++) {
			ctx.runtimeState.operationalServiceDates.add(addDaysToServiceDate(today, offset));
		}
	}
	if (previousCtx) getSeqState(ctx).qrtTrains = getSeqState(previousCtx).qrtTrains;
	const startTotal = Date.now();
	ctx.augmented.timer.clear();
	ctx.augmented.timer.start("refreshStaticCache");
	clearConsideredCaches(ctx);
	clearAugmentedStopTimeCaches(ctx);
	clearPreviousVehicleInfo(ctx);
	const { resetNetworkTopologyForStaticFeed } = await import("../utils/SRT.js");
	resetNetworkTopologyForStaticFeed(ctx);
	for (const plugin of config.network.plugins) await plugin.afterStaticLoad?.(ctx);

	ctx.augmented.timer.start("refreshStaticCache:preloadTripUpdates");
	const allUpdates = gtfs.getRealtimeTripUpdates();
	const injected = ctx.raw.injectedTripUpdates ?? [];
	for (const update of allUpdates.concat(injected)) {
		const tripId = update.trip.trip_id;
		if (!tripId || !update.feed_id) continue;
		const key = entityKey({ feedId: update.feed_id, localId: tripId });

		const existing = ctx.augmented.tripUpdatesCache.get(key);
		if (existing) {
			existing.push(update);
		} else {
			ctx.augmented.tripUpdatesCache.set(key, [update]);
		}
	}
	for (const [tripId, updates] of ctx.augmented.tripUpdatesCache) {
		ctx.augmented.tripUpdateSignatures.set(tripId, tripUpdateSignature(updates));
	}
	ctx.augmented.timer.stop("refreshStaticCache:preloadTripUpdates");

	ctx.augmented.timer.start("refreshStaticCache:loadStops");
	const stops = gtfs.getStops();
	for (const stop of stops) {
		const key = entityKey({ feedId: stop.feed_id, localId: stop.stop_id });
		newRawCache.stopsByKey.set(key, stop);
		const feedStops = newRawCache.stopsByFeed.get(stop.feed_id) ?? [];
		feedStops.push(stop);
		newRawCache.stopsByFeed.set(stop.feed_id, feedStops);
	}
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
	for (const route of routes) {
		newRawCache.routesByKey.set(entityKey({ feedId: route.feed_id, localId: route.route_id }), route);
	}
	ctx.augmented.timer.stop("refreshStaticCache:loadRoutes");
	logger.debug(`Loaded ${routes.length} routes.`, {
		module: "cache",
		function: "refreshStaticCache",
	});

	ctx.augmented.timer.start("refreshStaticCache:loadTrips");
	const allTrips = gtfs.getTrips();
	for (const trip of allTrips) {
		newRawCache.tripsByKey.set(entityKey({ feedId: trip.feed_id, localId: trip.trip_id }), trip);
	}
	const consideredTrips = allTrips.filter((v: Trip) => isConsideredTrip(v, ctx));
	newRawCache.consideredTrips = consideredTrips;
	ctx.augmented.timer.stop("refreshStaticCache:loadTrips");

	ctx.augmented.timer.start("refreshStaticCache:loadStopTimes");
	primeRawStopTimes(ctx, consideredTrips);
	const trips = consideredTrips.filter(
		(trip) => getRawStopTimes(ctx, { feedId: trip.feed_id, localId: trip.trip_id }).length > 0,
	);
	const realtimeOnlyTrips = createRealtimeOnlyTrips(
		ctx.augmented.tripUpdatesCache,
		ctx,
		new Set(trips.map((trip) => entityKey({ feedId: trip.feed_id, localId: trip.trip_id }))),
	);
	for (const trip of realtimeOnlyTrips) {
		const key = entityKey({ feedId: trip.feed_id, localId: trip.trip_id });
		newRawCache.realtimeOnlyTripKeys.add(key);
		newRawCache.tripsByKey.set(key, trip);
	}
	const tripsToAugment = [...trips, ...realtimeOnlyTrips];
	ctx.augmented.timer.stop("refreshStaticCache:loadStopTimes");
	ctx.augmented.timer.start("refreshStaticCache:buildCorridorIndex");
	newAugmentedCache.corridorIndex = buildCorridorIndex(ctx);
	ctx.augmented.timer.stop("refreshStaticCache:buildCorridorIndex");
	for (const t of allTrips) {
		newRawCache.tripServiceIds!.set(
			entityKey({ feedId: t.feed_id, localId: t.trip_id }),
			entityKey({ feedId: t.feed_id, localId: t.service_id }),
		);
	}
	for (const trip of tripsToAugment)
		newAugmentedCache.rawTripsRec.set(entityKey({ feedId: trip.feed_id, localId: trip.trip_id }), trip);
	for (const trip of tripsToAugment) registerTripNumber(ctx, trip);
	logger.debug(
		`Loaded ${tripsToAugment.length} usable considered trips out of ${allTrips.length} static rows; skipped ${consideredTrips.length - trips.length} static trip rows without stop times.`,
		{
			module: "cache",
			function: "refreshStaticCache",
		},
	);

	ctx.augmented.timer.start("refreshStaticCache:loadLinkedTransfers");
	for (const transfer of gtfs.getTransfers()) {
		if (
			!transfer.from_trip_id ||
			(transfer.transfer_type !== TransferType.InSeat && transfer.transfer_type !== TransferType.NoInSeat)
		)
			continue;
		const key = entityKey({ feedId: transfer.feed_id, localId: transfer.from_trip_id });
		const linked = newAugmentedCache.linkedTransfersFromTrip.get(key) ?? [];
		linked.push(transfer);
		newAugmentedCache.linkedTransfersFromTrip.set(key, linked);
	}
	ctx.augmented.timer.stop("refreshStaticCache:loadLinkedTransfers");

	if (config.preloadStopTimes) {
		ctx.augmented.timer.start("refreshStaticCache:preloadStopTimes");
		for (const trip of trips) {
			getRawStopTimes(ctx, { feedId: trip.feed_id, localId: trip.trip_id });
		}
		ctx.augmented.timer.stop("refreshStaticCache:preloadStopTimes");
	}

	ctx.augmented.timer.start("refreshStaticCache:processShapes");
	const shapeSet = new Set<string>();
	for (const trip of trips) {
		const shapeKey = trip.shape_id ? entityKey({ feedId: trip.feed_id, localId: trip.shape_id }) : null;
		if (trip.shape_id && shapeKey && !shapeSet.has(shapeKey)) {
			shapeSet.add(shapeKey);
			newAugmentedCache.shapes.push({ feed_id: trip.feed_id, shape_id: trip.shape_id, route_id: trip.route_id });
		}
	}
	ctx.augmented.timer.stop("refreshStaticCache:processShapes");

	ctx.augmented.timer.start("refreshStaticCache:prepAugmentStops");
	const childrenByParent = new Map<string, Stop[]>();
	for (const s of stops) {
		if (!s.parent_station) continue;
		const parentKey = entityKey({ feedId: s.feed_id, localId: s.parent_station });
		const list = childrenByParent.get(parentKey) ?? [];
		list.push(s);
		childrenByParent.set(parentKey, list);
	}

	const qrtPlacesByName = new Map<string, QRTPlace>();
	const qrtStationsByKey = new Map<string, QRTStationDetails>();
	const facilitiesByStopId = new Map<string, RailwayStationFacility>();
	const seqState = getSeqState(ctx);
	if (seqState.qrtPlaces.length || Object.keys(seqState.qrtStations).length) {
		for (const p of seqState.qrtPlaces) {
			if (!p?.Title) continue;
			const key = p.Title.toLowerCase().replace("station", "").trim();
			qrtPlacesByName.set(key, p);
		}
		for (const [key, station] of buildQRTStationLookupMap(seqState.qrtStations)) {
			if (!qrtStationsByKey.has(key)) qrtStationsByKey.set(key, station);
		}
		const facilities = seqState.railwayStationFacilities;
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
	for (const stop of newAugmentedCache.stops) {
		newAugmentedCache.stopsRec.set(entityKey({ feedId: stop.feed_id, localId: stop.stop_id }), stop);
	}

	// Link parents and children
	for (const stop of newAugmentedCache.stops) {
		if (stop.parent_stop_id) {
			stop.parent =
				newAugmentedCache.stopsRec.get(entityKey({ feedId: stop.feed_id, localId: stop.parent_stop_id })) ??
				null;
		}
		if (stop.child_stop_ids) {
			stop.children = stop.child_stop_ids
				.map((id) => newAugmentedCache.stopsRec.get(entityKey({ feedId: stop.feed_id, localId: id })))
				.filter((s): s is AugmentedStop => !!s);
		}
	}
	ctx.augmented.timer.stop("refreshStaticCache:primeStopMap");

	ctx.augmented.timer.start("refreshStaticCache:augmentTrips");
	const tripUpdatesCache = ctx.augmented.tripUpdatesCache;
	newAugmentedCache.trips = await processWithProgress(
		tripsToAugment,
		"Augmenting trips",
		(trip) => {
			const augmentedTrip = augmentTrip(trip, ctx, tripUpdatesCache);

			const tripKey = entityKey({ feedId: augmentedTrip.feed_id, localId: augmentedTrip.trip_id });
			newAugmentedCache.tripsRec.set(tripKey, augmentedTrip);
			registerAugmentedTrip(ctx, augmentedTrip);

			const allStopTimes = augmentedTrip.instances.flatMap((i) => i.stopTimes);
			newAugmentedCache.stopTimes[tripKey] = allStopTimes;
			newAugmentedCache.baseStopTimes[tripKey] = [...allStopTimes];

			return augmentedTrip;
		},
		config.progressLog,
	);
	ctx.augmented.timer.stop("refreshStaticCache:augmentTrips");

	rebuildAugmentedTripArrayIndex(ctx);

	for (const plugin of config.network.plugins) await plugin.afterSnapshotBuilt?.(ctx);

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

	logger.debug("Loading realtime updates...", {
		module: "cache",
		function: "refreshRealtimeCache",
	});

	const tripUpdates = await getRealtimeTripUpdatesByFeed(gtfs, config);
	const timer = ctx.augmented.timer;
	timer.start("refreshRealtimeCache:collectChangedIds");
	const allTripUpdates = applyRealtimeReplacementPrecedence(
		canonicalizeRealtimeTripUpdates(tripUpdates.concat(ctx.raw.injectedTripUpdates ?? []), ctx),
	);
	const nextUpdatesByTrip = new Map<string, typeof allTripUpdates>();
	for (const update of allTripUpdates) {
		const tripId = update.trip.trip_id;
		if (!tripId || !update.feed_id) continue;
		const tripKey = entityKey({ feedId: update.feed_id, localId: tripId });
		const updates = nextUpdatesByTrip.get(tripKey);
		if (updates) updates.push(update);
		else nextUpdatesByTrip.set(tripKey, [update]);
	}
	const nextSignatures = new Map<string, string>();
	for (const [tripId, updates] of nextUpdatesByTrip) {
		nextSignatures.set(tripId, tripUpdateSignature(updates));
	}
	const realtimeOnlyTrips = createRealtimeOnlyTrips(nextUpdatesByTrip, ctx);
	const nextRealtimeOnlyTripKeys = new Set<string>();
	for (const trip of realtimeOnlyTrips) {
		const tripKey = entityKey({ feedId: trip.feed_id, localId: trip.trip_id });
		nextRealtimeOnlyTripKeys.add(tripKey);
		ctx.raw.realtimeOnlyTripKeys.add(tripKey);
		ctx.raw.tripsByKey.set(tripKey, trip);
		augmentedCache.rawTripsRec.set(tripKey, trip);
		registerTripNumber(ctx, trip);
	}

	logger.debug(
		`Loaded ${tripUpdates.length} trip updates with ${tripUpdates.flatMap((v) => v.stop_time_updates).length} stop time updates.`,
		{
			module: "cache",
			function: "refreshRealtimeCache",
		},
	);
	const updatedTripIds = findChangedRealtimeTripIds(augmentedCache.tripUpdateSignatures, nextSignatures, (tripKey) =>
		augmentedCache.rawTripsRec.has(tripKey),
	);
	for (const tripKey of nextRealtimeOnlyTripKeys) {
		if (!augmentedCache.tripsRec.has(tripKey)) updatedTripIds.add(tripKey);
	}

	const realtimeUpdateKeys = new Set([...augmentedCache.tripUpdateSignatures.keys(), ...nextSignatures.keys()]);
	for (const tripKey of realtimeUpdateKeys) {
		const updates = nextUpdatesByTrip.get(tripKey);
		if (updates) {
			augmentedCache.tripUpdatesCache.set(tripKey, updates);
			augmentedCache.tripUpdateSignatures.set(tripKey, nextSignatures.get(tripKey)!);
		} else {
			augmentedCache.tripUpdatesCache.delete(tripKey);
			augmentedCache.tripUpdateSignatures.delete(tripKey);
		}
	}
	timer.stop("refreshRealtimeCache:collectChangedIds");

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
		logger.debug("Re-augmenting updated trips...", {
			module: "cache",
			function: "refreshRealtimeCache",
		});

		const tripKeys = Array.from(updatedTripIds);
		const total = tripKeys.length;
		const startedAt = Date.now();
		ctx.config.progressLog({
			task: "Re-augmenting updated trips",
			current: 0,
			total,
			speed: 0,
			eta: 0,
			percent: 0,
			unit: "items",
		});

		for (let index = 0; index < total; index += 1) {
			const tripKey = tripKeys[index];
			const reusableTrip = augmentedCache.tripsRec.get(tripKey);

			timer.start("refreshRealtimeCache:unregisterChangedTrips");
			resetRealtimeTripIncremental(tripKey, ctx);
			const removeRealtimeOnly =
				ctx.raw.realtimeOnlyTripKeys.has(tripKey) && !nextRealtimeOnlyTripKeys.has(tripKey);
			if (removeRealtimeOnly) removeRealtimeOnlyTrip(ctx, tripKey);
			timer.stop("refreshRealtimeCache:unregisterChangedTrips");

			timer.start("refreshRealtimeCache:fetchRawChangedTrips");
			const rawTrip = removeRealtimeOnly
				? undefined
				: (ctx.raw.tripsByKey.get(tripKey) ?? augmentedCache.rawTripsRec.get(tripKey));
			timer.stop("refreshRealtimeCache:fetchRawChangedTrips");

			if (rawTrip) {
				timer.start("refreshRealtimeCache:reaugmentChangedTrips");
				const updatedTrip = augmentTrip(rawTrip, ctx, ctx.augmented.tripUpdatesCache, reusableTrip);
				timer.stop("refreshRealtimeCache:reaugmentChangedTrips");

				timer.start("refreshRealtimeCache:reregisterIndexes");
				augmentedCache.tripsRec.set(tripKey, updatedTrip);
				registerAugmentedTrip(ctx, updatedTrip);
				replaceAugmentedTripInArray(ctx, updatedTrip);

				const allStopTimes = updatedTrip.instances.flatMap((instance) => instance.stopTimes);
				augmentedCache.stopTimes[tripKey] = allStopTimes;
				augmentedCache.baseStopTimes[tripKey] = [...allStopTimes];
				timer.stop("refreshRealtimeCache:reregisterIndexes");
			}

			const current = index + 1;
			if (current % 10 === 0 || current === total) {
				await new Promise((resolve) => setImmediate(resolve));
				const elapsed = (Date.now() - startedAt) / 1000;
				const speed = elapsed > 0 ? current / elapsed : 0;
				ctx.config.progressLog({
					task: "Re-augmenting updated trips",
					current,
					total,
					speed,
					eta: speed > 0 ? (total - current) / speed : 0,
					percent: (current / total) * 100,
					unit: "items",
				});
			}
		}

		logger.debug(`Re-augmented ${updatedTripIds.size} trips.`, {
			module: "cache",
			function: "refreshRealtimeCache",
		});
	}

	for (const plugin of config.network.plugins) {
		const isSeqPlugin = plugin.id === "au-seq";
		if (isSeqPlugin) {
			timer.start("refreshRealtimeCache:SEQ diagram realtime update");
			timer.start("refreshRealtimeCache:QRT auxiliary refresh");
		}
		try {
			await plugin.afterRealtime?.(ctx, updatedTripIds);
		} finally {
			if (isSeqPlugin) {
				timer.stop("refreshRealtimeCache:QRT auxiliary refresh");
				timer.stop("refreshRealtimeCache:SEQ diagram realtime update");
			}
		}
	}
	prunePreviousVehicleInfo(ctx, augmentedCache.instancesRec.keys());

	ctx.augmented.timer.stop("refreshRealtimeCache");
	ctx.augmented.timer.log("Realtime Cache Refresh", true);

	logger.info(`Realtime GTFS cache refreshed in ${((Date.now() - startTotal) / 1000).toFixed(2)}s.`, {
		module: "cache",
		function: "refreshRealtimeCache",
	});
}

async function getRealtimeTripUpdatesByFeed(gtfs: GTFS, config: TraxConfig) {
	const feedIds = [...new Set(config.network.feeds.map((feed) => feed.id))];
	if (feedIds.length === 0) return gtfs.getRealtimeTripUpdates();
	const updates: ReturnType<GTFS["getRealtimeTripUpdates"]> = [];
	for (const feedId of feedIds) {
		updates.push(...gtfs.getRealtimeTripUpdates({ feed_id: feedId }));
		await new Promise((resolve) => setImmediate(resolve));
	}
	return updates;
}

async function processWithProgress<T, U>(
	items: T[],
	taskName: string,
	processFn: (item: T) => U,
	reportProgress: CacheProgressReporter = (info) => logger.progress(info),
	chunkSize = 250,
): Promise<U[]> {
	const results: U[] = [];
	let current = 0;
	const total = items.length;
	const startTime = Date.now();

	if (total === 0) return results;

	reportProgress({
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

		reportProgress({
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
	getRealtimeTripUpdatesByFeed,
};
