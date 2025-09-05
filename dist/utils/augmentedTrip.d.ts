import * as gtfs from "gtfs";
import { AugmentedStopTime, SerializableAugmentedStopTime } from "./augmentedStopTime.js";
import { ExpressInfo } from "./express.js";
export type AugmentedTrip = {
    _trip: gtfs.Trip;
    scheduledStartServiceDates: number[];
    scheduledTripDates: number[];
    actualTripDates: number[];
    _runSeries: {
        [serviceDate: number]: string | null;
    };
    runSeries: {
        [serviceDate: number]: string;
    };
    stopTimes: AugmentedStopTime[];
    expressInfo: ExpressInfo[];
    run: string;
    toSerializable: () => SerializableAugmentedTrip;
};
export type RunSeries = {
    trips: {
        trip_start_time: number;
        trip_id: string;
        run: string;
    }[];
    vehicle_sightings: string[];
};
export type SerializableAugmentedTrip = Omit<AugmentedTrip, "stopTimes" | "toSerializable" | "_runSeries"> & {
    stopTimes: SerializableAugmentedStopTime[];
};
export declare function toSerializableAugmentedTrip(trip: AugmentedTrip | Omit<AugmentedTrip, "toSerializable" | "toSerializable" | "_runSeries">): SerializableAugmentedTrip;
export declare function augmentTrip(trip: gtfs.Trip): AugmentedTrip;
export declare function calculateRunSeries(trip: AugmentedTrip): void;
