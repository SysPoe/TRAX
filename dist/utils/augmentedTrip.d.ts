import type * as gtfs from "gtfs";
import { AugmentedStopTime, SerializableAugmentedStopTime } from "./augmentedStopTime.js";
import { ExpressInfo } from "./express.js";
export declare type AugmentedTrip = {
    _trip: gtfs.Trip;
    serviceDates: number[];
    tracks: {
        [serviceDate: number]: string;
    };
    stopTimes: AugmentedStopTime[];
    expressInfo: ExpressInfo[];
    run: string;
    toSerializable: () => SerializableAugmentedTrip;
};
export declare type SerializableAugmentedTrip = Omit<AugmentedTrip, "stopTimes" | "toSerializable"> & {
    stopTimes: SerializableAugmentedStopTime[];
};
export declare function toSerializableAugmentedTrip(trip: AugmentedTrip | Omit<AugmentedTrip, "toSerializable">): SerializableAugmentedTrip;
export declare function augmentTrip(trip: gtfs.Trip): AugmentedTrip;
