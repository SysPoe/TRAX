import type * as gtfs from "gtfs";
import { AugmentedStopTime, SerializableAugmentedStopTime } from "./augmentedStopTime.js";
import { ExpressInfo } from "./express.js";
export type AugmentedTrip = {
    _trip: gtfs.Trip;
    scheduledStartServiceDates: number[];
    scheduledTripDates: number[];
    actualTripDates: number[];
    runSeries: {
        [serviceDate: number]: string | null;
    };
    stopTimes: AugmentedStopTime[];
    expressInfo: ExpressInfo[];
    run: string;
    toSerializable: () => SerializableAugmentedTrip;
};
export type SerializableAugmentedTrip = Omit<AugmentedTrip, "stopTimes" | "toSerializable"> & {
    stopTimes: SerializableAugmentedStopTime[];
};
export declare function toSerializableAugmentedTrip(trip: AugmentedTrip | Omit<AugmentedTrip, "toSerializable">): SerializableAugmentedTrip;
export declare function augmentTrip(trip: gtfs.Trip): AugmentedTrip;
