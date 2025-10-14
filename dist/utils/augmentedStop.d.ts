import type * as gtfs from "gtfs";
import { AugmentedStopTime } from "./augmentedStopTime.js";
export type AugmentedStop = gtfs.Stop & {
    qrt_Place: boolean;
    qrt_PlaceCode?: string;
    parent: AugmentedStop | null;
    children: AugmentedStop[];
    getDepartures: (date: number, start_time: string, end_time: string) => (AugmentedStopTime & {
        express_string: string;
    })[];
    _getSDDepartures: (serviceDate: number, start_time_secs: number, end_time_secs: number) => (AugmentedStopTime & {
        express_string: string;
    })[];
    toSerializable: () => SerializableAugmentedStop;
};
export type SerializableAugmentedStop = gtfs.Stop & {
    qrt_Place: boolean;
    qrt_PlaceCode?: string;
    parent: string | null;
    children: string[];
};
export declare function toSerializableAugmentedStop(stop: Omit<AugmentedStop, "toSerializable" | "getDepartures" | "_getSDDepartures">): SerializableAugmentedStop;
export declare function augmentStop(stop: gtfs.Stop): AugmentedStop;
