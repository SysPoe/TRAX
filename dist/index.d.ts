import * as cache from "./cache.js";
import * as calendar from "./utils/calendar.js";
import * as stations from "./utils/stations.js";
import * as express from "./utils/express.js";
import * as qrTravel from "./qr-travel/qr-travel-tracker.js";
import * as augmentedStopTime from "./utils/augmentedStopTime.js";
import * as timeUtils from "./utils/time.js";
import { EventEmitter } from "events";
export declare const DEBUG = true;
export declare function loadGTFS(autoRefresh?: boolean, forceReload?: boolean, realtimeIntervalMs?: number, // 1 minute
staticIntervalMs?: number): Promise<void>;
export declare function clearIntervals(): void;
export declare function formatTimestamp(ts?: number | null): string;
export declare function updateRealtime(): Promise<void>;
export declare function today(): number;
declare const TRAX: {
    loadGTFS: typeof loadGTFS;
    updateRealtime: typeof updateRealtime;
    clearIntervals: typeof clearIntervals;
    today: typeof today;
    formatTimestamp: typeof formatTimestamp;
    getAugmentedTrips: typeof cache.getAugmentedTrips;
    getAugmentedStops: typeof cache.getAugmentedStops;
    getAugmentedStopTimes: typeof cache.getAugmentedStopTimes;
    getBaseStopTimes: typeof cache.getBaseStopTimes;
    getRunSeries: typeof cache.getRunSeries;
    getStations: typeof stations.getStations;
    getRawTrips: typeof cache.getRawTrips;
    getRawStops: typeof cache.getRawStops;
    getRawRoutes: typeof cache.getRawRoutes;
    getStopTimeUpdates: typeof cache.getStopTimeUpdates;
    getTripUpdates: typeof cache.getTripUpdates;
    getVehiclePositions: typeof cache.getVehiclePositions;
    getQRTPlaces: typeof cache.getQRTPlaces;
    getQRTTrains: typeof cache.getQRTTrains;
    on: (event: string, listener: (...args: any[]) => void) => EventEmitter<[never]>;
    off: (event: string, listener: (...args: any[]) => void) => EventEmitter<[never]>;
    cache: typeof cache;
    stations: typeof stations;
    calendar: typeof calendar;
    express: typeof express;
    qrTravel: typeof qrTravel;
    utils: {
        time: typeof timeUtils;
        formatTimestamp: typeof formatTimestamp;
    };
    config: {
        agencies: {
            url: string;
            realtimeAlerts: {
                url: string;
            };
            realtimeTripUpdates: {
                url: string;
            };
            realtimeVehiclePositions: {
                url: string;
            };
        }[];
        sqlitePath: string;
        verbose: boolean;
        db: undefined;
        logFunction: (message: string) => void;
    };
    logger: import("./utils/logger.js").Logger;
    ScheduleRelationship: typeof augmentedStopTime.ScheduleRelationship;
};
export default TRAX;
export type { AugmentedTrip, SerializableAugmentedTrip, RunSeries } from "./utils/augmentedTrip.js";
export type { AugmentedStopTime, SerializableAugmentedStopTime } from "./utils/augmentedStopTime.js";
export type { AugmentedStop, SerializableAugmentedStop } from "./utils/augmentedStop.js";
export type { TrainMovementDTO, ServiceDisruption, GetServiceResponse, QRTPlace, Service, Direction, ServiceLine, AllServicesResponse, QRTService, ServiceUpdate, TravelStopTime, TravelTrip, } from "./qr-travel/types.js";
export type { ExpressInfo } from "./utils/express.js";
export type { SRTStop } from "./utils/SectionalRunningTimes/metroSRTTravelTrain.js";
export { Logger, LogLevel } from "./utils/logger.js";
