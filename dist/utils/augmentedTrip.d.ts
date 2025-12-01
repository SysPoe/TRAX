import type * as qdf from "qdf-gtfs";
import { AugmentedStopTime, SerializableAugmentedStopTime } from "./augmentedStopTime.js";
import { ExpressInfo } from "./express.js";
export type AugmentedTrip = {
    _trip: qdf.Trip;
    scheduledStartServiceDates: string[];
    scheduledTripDates: string[];
    actualTripDates: string[];
    _runSeries: {
        [serviceDate: string]: string | null;
    };
    runSeries: {
        [serviceDate: string]: string;
    };
    stopTimes: AugmentedStopTime[];
    expressInfo: ExpressInfo[];
    run: string;
    scheduleRelationship: qdf.TripScheduleRelationship | null;
    toSerializable: () => SerializableAugmentedTrip;
};
export type RunSeries = {
    trips: {
        trip_start_time: number;
        trip_id: string;
        run: string;
    }[];
    vehicle_sightings: string[];
    series: string;
    date: string;
};
export type SerializableAugmentedTrip = Omit<AugmentedTrip, "stopTimes" | "toSerializable" | "_runSeries"> & {
    stopTimes: SerializableAugmentedStopTime[];
};
export declare function toSerializableAugmentedTrip(trip: AugmentedTrip | Omit<AugmentedTrip, "toSerializable" | "toSerializable" | "_runSeries">): SerializableAugmentedTrip;
export declare function augmentTrip(trip: qdf.Trip): AugmentedTrip;
export declare function calculateRunSeries(trip: AugmentedTrip): void;
