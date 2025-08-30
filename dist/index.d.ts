import * as gtfs from "gtfs";
import * as calendar from "./utils/calendar.js";
import * as express from "./utils/express.js";
import * as qrTravel from "./qr-travel/qr-travel-tracker.js";
export declare const DEBUG = true;
export declare function loadGTFS(refresh?: boolean, forceReload?: boolean): Promise<void>;
export declare function clearIntervals(): void;
export declare function formatTimestamp(ts?: number | null): string;
export declare function updateRealtime(): Promise<void>;
declare const _default: {
    qrTravel: typeof qrTravel;
    getStations(): import("./utils/augmentedStop.js").AugmentedStop[];
    express: typeof express;
    calendar: typeof calendar;
    getRawTrips(trip_id?: string): gtfs.Trip[];
    getRawStops(stop_id?: string): gtfs.Stop[];
    getRawRoutes(route_id?: string): gtfs.Route[];
    getStopTimeUpdates(): gtfs.StopTimeUpdate[];
    getTripUpdates(): gtfs.TripUpdate[];
    getVehiclePositions(): gtfs.VehiclePosition[];
    getQRTPlaces(): import("./qr-travel/types.js").QRTPlace[];
    getQRTTrains(): import("./qr-travel/types.js").TravelTrip[];
    getRawStopTimes(trip_id: string | undefined): gtfs.StopTime[];
    getAugmentedTrips(trip_id?: string): import("./utils/augmentedTrip.js").AugmentedTrip[];
    getAugmentedStops(stop_id?: string): import("./utils/augmentedStop.js").AugmentedStop[];
    getAugmentedStopTimes(trip_id?: string): import("./utils/augmentedStopTime.js").AugmentedStopTime[];
    getBaseStopTimes(trip_id: string): import("./utils/augmentedStopTime.js").AugmentedStopTime[];
    cacheExpressInfo(stopListHash: string, expressInfo: any[]): void;
    getCachedExpressInfo(stopListHash: string): any[] | undefined;
    cachePassingStops(stopListHash: string, passingStops: any[]): void;
    getCachedPassingStops(stopListHash: string): any[] | undefined;
    refreshStaticCache(): Promise<void>;
    refreshRealtimeCache(): Promise<void>;
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
    };
    loadGTFS: typeof loadGTFS;
    updateRealtime: typeof updateRealtime;
    clearIntervals: typeof clearIntervals;
    formatTimestamp: typeof formatTimestamp;
};
export default _default;
export type { AugmentedTrip, SerializableAugmentedTrip, } from "./utils/augmentedTrip.js";
export type { AugmentedStopTime, SerializableAugmentedStopTime, ScheduleRelationship, } from "./utils/augmentedStopTime.js";
export type { AugmentedStop, SerializableAugmentedStop, } from "./utils/augmentedStop.js";
export type { TrainMovementDTO, ServiceDisruption, GetServiceResponse, QRTPlace, Service, Direction, ServiceLine, AllServicesResponse, QRTService, ServiceUpdate, TravelStopTime, TravelTrip, } from "./qr-travel/types.js";
export type { ExpressInfo } from "./utils/express.js";
export type { SRTStop } from "./utils/SectionalRunningTimes/metroSRTTravelTrain.js";
