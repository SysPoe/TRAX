import * as gtfs from "gtfs";
import { AugmentedStop, augmentStop } from "./utils/augmentedStop.js";
import { AugmentedTrip, augmentTrip } from "./utils/augmentedTrip.js";
import { AugmentedStoptime } from "./utils/augmentedStoptime.js";
import { DEBUG } from "./index.js";

type RawCache = {
  stopTimeUpdates: gtfs.StopTimeUpdate[];
  tripUpdates: gtfs.TripUpdate[];
  vehiclePositions: gtfs.VehiclePosition[];
  stoptimes: gtfs.StopTime[];

  trips: gtfs.Trip[];
  stops: gtfs.Stop[];

  tripsRec: Record<string, gtfs.Trip>;
  stopsRec: Record<string, gtfs.Stop>;
};

type AugmentedCache = {
  trips?: AugmentedTrip[];
  stops?: AugmentedStop[];
  stoptimes?: AugmentedStoptime[];

  tripsRec?: Record<string, AugmentedTrip>;
  stopsRec?: Record<string, AugmentedStop>;
};

let rawCache: RawCache = {
  stopTimeUpdates: [],
  tripUpdates: [],
  vehiclePositions: [],
  stoptimes: [],

  trips: [],
  stops: [],

  tripsRec: {},
  stopsRec: {},
};

let augmentedCache: AugmentedCache = {
  trips: [],
  stops: [],
  stoptimes: [],

  tripsRec: {},
  stopsRec: {},
};

export function getRawTrips(trip_id?: string): gtfs.Trip[] {
  if (trip_id)
    return rawCache.tripsRec[trip_id] ? [rawCache.tripsRec[trip_id]] : [];
  return rawCache.trips;
}

export function getRawStops(stop_id?: string): gtfs.Stop[] {
  if (stop_id)
    return rawCache.stopsRec[stop_id] ? [rawCache.stopsRec[stop_id]] : [];
  return rawCache.stops;
}

export function getRawStoptimeUpdates(): gtfs.StopTimeUpdate[] {
  return rawCache.stopTimeUpdates;
}

export function getRawTripUpdates(): gtfs.TripUpdate[] {
  return rawCache.tripUpdates;
}

export function getRawVehiclePositions(): gtfs.VehiclePosition[] {
  return rawCache.vehiclePositions;
}

/**
 * Retrieve stoptimes, optionally filtered by trip id, lazily loading from GTFS.
 */
export function getRawStoptimes(trip_id: string): gtfs.StopTime[] {
  return gtfs.getStoptimes({ trip_id });
}

export function getAugmentedTrips(trip_id?: string): AugmentedTrip[] {
  if (trip_id) {
    if (augmentedCache.tripsRec[trip_id])
      return [augmentedCache.tripsRec[trip_id]];
    if (rawCache.tripsRec[trip_id]) {
      const trip = rawCache.tripsRec[trip_id];
      const augmentedTrip = augmentTrip(trip);
      augmentedCache.tripsRec[trip_id] = augmentedTrip;
      return [augmentedTrip];
    }
    return [];
  }
  return augmentedCache.trips;
}

export function getAugmentedStops(stop_id?: string): AugmentedStop[] {
  if (stop_id) {
    if (augmentedCache.stopsRec[stop_id])
      return [augmentedCache.stopsRec[stop_id]];
    if (rawCache.stopsRec[stop_id]) {
      const stop = rawCache.stopsRec[stop_id];
      const augmentedStop = augmentStop(stop);
      augmentedCache.stopsRec[stop_id] = augmentedStop;
      return [augmentedStop];
    }
    return [];
  }
  return augmentedCache.stops;
}

export function getAugmentedStoptimes(): AugmentedStoptime[] {
  return augmentedCache.stoptimes;
}

/**
 * Refresh static GTFS cache (stops, stoptimes).
 * @returns {Promise<void>}
 */
export async function refreshStaticCache(): Promise<void> {
  if (DEBUG) console.log("Refreshing static GTFS cache...");
  if (DEBUG) console.log("Loading stops...");
  rawCache.stops = gtfs.getStops();
  if (DEBUG) console.log("Loaded", rawCache.stops.length, "stops.");
  if (DEBUG) console.log("Loading trips...");
  rawCache.trips = gtfs.getTrips();
  if (DEBUG) console.log("Loaded", rawCache.trips.length, "trips.");
  if (DEBUG) console.log("Building raw cache records...");
  rawCache.tripsRec = {};
  rawCache.stopsRec = {};

  for (const trip of rawCache.trips) {
    rawCache.tripsRec[trip.trip_id] = trip;
  }
  for (const stop of rawCache.stops) {
    rawCache.stopsRec[stop.stop_id] = stop;
  }

  if (DEBUG) console.log("Done. Static GTFS cache refreshed.");
}

/**
 * Refresh realtime GTFS cache (stopTimeUpdates, tripUpdates, vehiclePositions).
 * @returns {Promise<void>}
 */
export async function refreshRealtimeCache(): Promise<void> {
  rawCache.stopTimeUpdates = gtfs.getStopTimeUpdates();
  rawCache.tripUpdates = gtfs.getTripUpdates();
  rawCache.vehiclePositions = gtfs.getVehiclePositions();
}
