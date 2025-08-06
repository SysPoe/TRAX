import * as gtfs from "gtfs";
import { AugmentedStop } from "./utils/augmentedStop.js";
import { AugmentedTrip } from "./utils/augmentedTrip.js";
import { AugmentedStopTime } from "./utils/augmentedStopTime.js";
import { QRTPlace, TravelTrip } from "./index.js";
export declare function getRawTrips(trip_id?: string): gtfs.Trip[];
export declare function getRawStops(stop_id?: string): gtfs.Stop[];
export declare function getRawRoutes(route_id?: string): gtfs.Route[];
export declare function getStopTimeUpdates(): gtfs.StopTimeUpdate[];
export declare function getTripUpdates(): gtfs.TripUpdate[];
export declare function getVehiclePositions(): gtfs.VehiclePosition[];
export declare function getQRTPlaces(): QRTPlace[];
export declare function getQRTTrains(): TravelTrip[];
/**
 * Retrieve stopTimes, optionally filtered by trip id, lazily loading from GTFS.
 */
export declare function getRawStopTimes(trip_id: string | undefined): gtfs.StopTime[];
export declare function getAugmentedTrips(trip_id?: string): AugmentedTrip[];
export declare function getAugmentedStops(stop_id?: string): AugmentedStop[];
export declare function getAugmentedStopTimes(trip_id?: string): AugmentedStopTime[];
export declare function getBaseStopTimes(trip_id: string): AugmentedStopTime[];
export declare function cacheExpressInfo(stopListHash: string, expressInfo: any[]): void;
export declare function getCachedExpressInfo(stopListHash: string): any[] | undefined;
export declare function cachePassingStops(stopListHash: string, passingStops: any[]): void;
export declare function getCachedPassingStops(stopListHash: string): any[] | undefined;
/**
 * Refresh static GTFS cache (stops, stopTimes).
 * @returns {Promise<void>}
 */
export declare function refreshStaticCache(): Promise<void>;
/**
 * Refresh realtime GTFS cache (stopTimeUpdates, tripUpdates, vehiclePositions).
 * @returns {Promise<void>}
 */
export declare function refreshRealtimeCache(): Promise<void>;
