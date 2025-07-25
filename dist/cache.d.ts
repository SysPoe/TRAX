import * as gtfs from "gtfs";
import { AugmentedStop } from "./utils/augmentedStop.js";
import { AugmentedTrip } from "./utils/augmentedTrip.js";
import { AugmentedStopTime } from "./utils/augmentedStopTime.js";
export declare function getRawTrips(trip_id?: string): gtfs.Trip[];
export declare function getRawStops(stop_id?: string): gtfs.Stop[];
export declare function getRawRoutes(route_id?: string): gtfs.Route[];
export declare function getStopTimeUpdates(): gtfs.StopTimeUpdate[];
export declare function getTripUpdates(): gtfs.TripUpdate[];
export declare function getVehiclePositions(): gtfs.VehiclePosition[];
/**
 * Retrieve stopTimes, optionally filtered by trip id, lazily loading from GTFS.
 */
export declare function getRawStopTimes(trip_id: string | undefined): gtfs.StopTime[];
export declare function getAugmentedTrips(trip_id?: string): AugmentedTrip[];
export declare function getAugmentedStops(stop_id?: string): AugmentedStop[];
export declare function getAugmentedStopTimes(trip_id?: string): AugmentedStopTime[];
/**
 * Refresh static GTFS cache (stops, stopTimes).
 * @returns {void}
 */
export declare function refreshStaticCache(): void;
/**
 * Refresh realtime GTFS cache (stopTimeUpdates, tripUpdates, vehiclePositions).
 * @returns {Promise<void>}
 */
export declare function refreshRealtimeCache(): void;
