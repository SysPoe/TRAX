import type * as gtfs from "gtfs";
import { AugmentedStopTime } from "./augmentedStopTime.js";
export declare type AugmentedStop = gtfs.Stop & {
    parent: AugmentedStop | null;
    children: AugmentedStop[];
    getDepartures: (date: number, start_time: string, end_time: string) => (AugmentedStopTime & {
        express_string: string;
    })[];
    toSerializable: () => SerializableAugmentedStop;
};
export declare type SerializableAugmentedStop = gtfs.Stop & {
    parent: string | null;
    children: string[];
};
export declare function toSerializableAugmentedStop(stop: AugmentedStop | (gtfs.Stop & {
    parent: AugmentedStop | null;
    children: AugmentedStop[];
})): SerializableAugmentedStop;
export declare function augmentStop(stop: gtfs.Stop): AugmentedStop;
