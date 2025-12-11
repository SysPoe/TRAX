import type { Calendar, CalendarDate, RealtimeTripUpdate, RealtimeVehiclePosition, RealtimeStopTimeUpdate, Route, Stop, StopTime, Trip } from "qdf-gtfs";
import { AugmentedStop } from "./utils/augmentedStop.js";
import { AugmentedTrip, RunSeries } from "./utils/augmentedTrip.js";
import { AugmentedStopTime } from "./utils/augmentedStopTime.js";
import { QRTPlace, TravelTrip } from "./index.js";
import * as qdf from "qdf-gtfs";
declare class LRUCache<K, V> {
    private cache;
    private maxSize;
    constructor(maxSize: number);
    get(key: K): V | undefined;
    set(key: K, value: V): void;
    clear(): void;
    get size(): number;
}
export type RawCache = {
    tripUpdates: RealtimeTripUpdate[];
    vehiclePositions: RealtimeVehiclePosition[];
    stopTimes: StopTime[];
    calendars: Calendar[];
    calendarDates: CalendarDate[];
    trips: Trip[];
    stops: Stop[];
    routes: Route[];
    tripsRec: Map<string, Trip>;
    stopsRec: Map<string, Stop>;
    routesRec: Map<string, Route>;
    qrtPlaces: QRTPlace[];
    qrtTrains: TravelTrip[];
};
export type AugmentedCache = {
    trips: AugmentedTrip[];
    stops: AugmentedStop[];
    stopTimes: {
        [trip_id: string]: AugmentedStopTime[];
    };
    baseStopTimes: {
        [trip_id: string]: AugmentedStopTime[];
    };
    tripsRec: Map<string, AugmentedTrip>;
    stopsRec: Map<string, AugmentedStop>;
    serviceDateTrips: Map<string, string[]>;
    expressInfoCache: LRUCache<string, any[]>;
    passingStopsCache: LRUCache<string, any[]>;
    runSeriesCache: Map<string, Map<string, RunSeries>>;
};
export type CacheContext = {
    raw: RawCache;
    augmented: AugmentedCache;
};
export declare function createEmptyRawCache(): RawCache;
export declare function createEmptyAugmentedCache(): AugmentedCache;
export declare function cacheLoaded(): boolean;
export declare function getCalendars(filter?: Partial<Calendar>, ctx?: CacheContext): Calendar[];
export declare function getCalendarDates(filter?: Partial<CalendarDate>, ctx?: CacheContext): CalendarDate[];
export declare function getRawTrips(trip_id?: string, ctx?: CacheContext): Trip[];
export declare function getRawStops(stop_id?: string, ctx?: CacheContext): Stop[];
export declare function getRawRoutes(route_id?: string, ctx?: CacheContext): Route[];
export declare function getTripUpdates(trip_id?: string, ctx?: CacheContext): RealtimeTripUpdate[];
export declare function getVehiclePositions(trip_id?: string, ctx?: CacheContext): RealtimeVehiclePosition[];
export declare function getStopTimeUpdates(trip_id: string, ctx?: CacheContext): RealtimeStopTimeUpdate[];
export declare function getQRTPlaces(ctx?: CacheContext): QRTPlace[];
export declare function getQRTTrains(ctx?: CacheContext): TravelTrip[];
export declare function getRawStopTimes(trip_id: string): StopTime[];
export declare function getAugmentedTrips(trip_id?: string, ctx?: CacheContext): AugmentedTrip[];
export declare function getAugmentedStops(stop_id?: string, ctx?: CacheContext): AugmentedStop[];
export declare function getAugmentedStopTimes(trip_id?: string, ctx?: CacheContext): AugmentedStopTime[];
export declare function queryAugmentedStopTimes(query: qdf.StopTimeQuery, ctx?: CacheContext): AugmentedStopTime[];
export declare function getBaseStopTimes(trip_id: string, ctx?: CacheContext): AugmentedStopTime[];
export declare function cacheExpressInfo(stopListHash: string, expressInfo: any[], ctx?: CacheContext): void;
export declare function getCachedExpressInfo(stopListHash: string, ctx?: CacheContext): any[] | undefined;
export declare function cachePassingStops(stopListHash: string, passingStops: any[], ctx?: CacheContext): void;
export declare function getCachedPassingStops(stopListHash: string, ctx?: CacheContext): any[] | undefined;
export declare function getRunSeries(date: string, runSeries: string, calcIfNotFound?: boolean, ctx?: CacheContext): RunSeries;
export declare function setRunSeries(date: string, runSeries: string, data: RunSeries, ctx?: CacheContext): void;
export declare function refreshStaticCache(skipRealtimeOverlap?: boolean): Promise<void>;
export declare function refreshRealtimeCache(): Promise<void>;
export {};
