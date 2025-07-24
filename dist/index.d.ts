import * as gtfs from "gtfs";
export declare const DEBUG = true;
export declare function loadGTFS(refresh?: boolean, forceReload?: boolean): Promise<void>;
export declare function clearIntervals(): void;
export declare function formatTimestamp(ts?: number | null): string;
export declare function updateRealtime(): Promise<void>;
declare const _default: {
    getStations(): gtfs.Stop[];
    getServiceDates(calendars: gtfs.Calendar[], calendarDates: gtfs.CalendarDate[]): Record<string, number[]>;
    getServiceDatesByTrip(trip_id: string): number[];
    getRawTrips(trip_id?: string | undefined): gtfs.Trip[];
    getRawStops(stop_id?: string | undefined): gtfs.Stop[];
    getStopTimeUpdates(): gtfs.StopTimeUpdate[];
    getTripUpdates(): gtfs.TripUpdate[];
    getVehiclePositions(): gtfs.VehiclePosition[];
    getRawStopTimes(trip_id: string | undefined): gtfs.StopTime[];
    getAugmentedTrips(trip_id?: string | undefined): import("./utils/augmentedTrip.js").AugmentedTrip[];
    getAugmentedStops(stop_id?: string | undefined): import("./utils/augmentedStop.js").AugmentedStop[];
    getAugmentedStopTimes(trip_id?: number | undefined): import("./utils/augmentedStopTime.js").AugmentedStopTime[];
    refreshStaticCache(): void;
    refreshRealtimeCache(): void;
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
