import { TransferType, type GTFS, type Trip, type Stop } from "qdf-gtfs";
import { isConsideredTrip } from "../utils/considered.js";
import { syncCalendarsToWasm } from "../utils/calendar.js";
import { augmentStop } from "../utils/augmentedStop.js";
import type { AugmentedStop } from "../utils/augmentedStop.js";
import { augmentTrip, EAGER_SERVICE_DATE_FUTURE_DAYS, EAGER_SERVICE_DATE_PAST_DAYS } from "../utils/augmentedTrip.js";
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
import { type TraxConfig } from "../config.js";
import { clearConsideredCaches } from "../utils/considered.js";
import type { CacheContext } from "./types.js";
import { createEmptyRawCache, createAugmentedCacheWithConfig, createRuntimeState } from "./factories.js";
import { registerAugmentedTrip, unregisterAugmentedTrip } from "./augmentedEntities.js";
import { clearPreviousVehicleInfo, prunePreviousVehicleInfo } from "../utils/vehicleModel.js";
import { entityKey } from "../identity.js";
import { getSeqState } from "../plugins/seq-state.js";
import { addDaysToServiceDate, getToday } from "../utils/time.js";
import { applyRealtimeReplacementPrecedence, canonicalizeRealtimeTripUpdates } from "./realtime.js";
import { getRawStopTimes, primeRawStopTimes } from "./gtfsReads.js";

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

	const serviceDateTripsMap = new Map<string, Set<string>>();
	const passingTripsMap = new Map<string, Set<string>>();

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
	const trips = consideredTrips.filter((trip) =>
		getRawStopTimes(ctx, { feedId: trip.feed_id, localId: trip.trip_id }).length > 0,
	);
	ctx.augmented.timer.stop("refreshStaticCache:loadStopTimes");
	for (const t of allTrips) {
		newRawCache.tripServiceIds!.set(
			entityKey({ feedId: t.feed_id, localId: t.trip_id }),
			entityKey({ feedId: t.feed_id, localId: t.service_id }),
		);
	}
	for (const trip of trips)
		newAugmentedCache.rawTripsRec.set(entityKey({ feedId: trip.feed_id, localId: trip.trip_id }), trip);
	for (const trip of trips) {
		const tripNumber =
			trip.trip_short_name && /^\d{1,3}$/.test(trip.trip_short_name)
				? trip.trip_short_name
				: trip.trip_id.slice(-4);
		const keys = newAugmentedCache.tripNumberTrips.get(tripNumber) ?? new Set<string>();
		keys.add(entityKey({ feedId: trip.feed_id, localId: trip.trip_id }));
		newAugmentedCache.tripNumberTrips.set(tripNumber, keys);
	}
	logger.debug(
		`Loaded ${trips.length} usable considered trips out of ${allTrips.length} total; skipped ${consideredTrips.length - trips.length} trip rows without stop times.`,
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
		trips,
		"Augmenting trips",
		(trip) => {
			const augmentedTrip = augmentTrip(trip, ctx, tripUpdatesCache);

			const tripKey = entityKey({ feedId: augmentedTrip.feed_id, localId: augmentedTrip.trip_id });
			newAugmentedCache.tripsRec.set(tripKey, augmentedTrip);
			registerAugmentedTrip(ctx, augmentedTrip);

			const allStopTimes = augmentedTrip.instances.flatMap((i) => i.stopTimes);
			newAugmentedCache.stopTimes[tripKey] = allStopTimes;
			newAugmentedCache.baseStopTimes[tripKey] = [...allStopTimes];

			for (const instance of augmentedTrip.instances) {
				for (const date of instance.actualTripDates) {
					let tripIdSet = serviceDateTripsMap.get(date);
					if (!tripIdSet) {
						tripIdSet = new Set();
						serviceDateTripsMap.set(date, tripIdSet);
					}
					tripIdSet.add(tripKey);
				}

				for (const st of instance.stopTimes) {
					if (st.passing && st.actual_stop_id) {
						const stopId = entityKey({ feedId: st.feed_id, localId: st.actual_stop_id });
						let tripIdSet = passingTripsMap.get(stopId);
						if (!tripIdSet) {
							tripIdSet = new Set();
							passingTripsMap.set(stopId, tripIdSet);
						}
						tripIdSet.add(tripKey);
					}
				}
			}

			return augmentedTrip;
		},
		config.progressLog,
	);
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

	const tripUpdates = gtfs.getRealtimeTripUpdates();
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

		const updatedAugmented = await processWithProgress(
			tripsToUpdate,
			"Re-augmenting updated trips",
			(t) =>
				augmentTrip(
					t,
					ctx,
					ctx.augmented.tripUpdatesCache,
					reusableTrips.get(entityKey({ feedId: t.feed_id, localId: t.trip_id })),
				),
			ctx.config.progressLog,
		);

		for (const at of updatedAugmented) {
			augmentedCache.tripsRec.set(entityKey({ feedId: at.feed_id, localId: at.trip_id }), at);
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

			augmentedCache.stopTimes[tripId] = allStopTimes;
			augmentedCache.baseStopTimes[tripId] = [...allStopTimes];

			for (const instance of trip.instances) {
				for (const date of instance.actualTripDates) {
					let tripIds = augmentedCache.serviceDateTrips.get(date);
					if (!tripIds) {
						tripIds = [];
						augmentedCache.serviceDateTrips.set(date, tripIds);
					}
					if (!tripIds.includes(tripId)) tripIds.push(tripId);

					let tripSet = augmentedCache.serviceDateTripsSet.get(date);
					if (!tripSet) {
						tripSet = new Set(tripIds);
						augmentedCache.serviceDateTripsSet.set(date, tripSet);
					}
					tripSet.add(tripId);
				}

				for (const st of instance.stopTimes) {
					if (st.passing && st.actual_stop_id) {
						const stopId = entityKey({ feedId: st.feed_id, localId: st.actual_stop_id });
						let tripIds = augmentedCache.passingTrips.get(stopId);
						if (!tripIds) {
							tripIds = [];
							augmentedCache.passingTrips.set(stopId, tripIds);
						}
						if (!tripIds.includes(tripId)) tripIds.push(tripId);
					}
				}
			}
		}
		for (const stop of augmentedCache.stops) {
			augmentedCache.stopsRec.set(entityKey({ feedId: stop.feed_id, localId: stop.stop_id }), stop);
		}
	}

	for (const plugin of config.network.plugins) await plugin.afterRealtime?.(ctx, updatedTripIds);
	prunePreviousVehicleInfo(ctx, augmentedCache.instancesRec.keys());

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
};
