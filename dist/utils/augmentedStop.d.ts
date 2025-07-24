import type * as gtfs from "gtfs";
import { AugmentedStopTime } from "./augmentedStopTime.js";
export type AugmentedStop = gtfs.Stop & {
    parent: AugmentedStop | null;
    children: AugmentedStop[];
    getDepartures: (date: number, start_time: string, end_time: string) => (AugmentedStopTime & {
        express_string: string;
    })[];
};
export declare function augmentStop(stop: gtfs.Stop): AugmentedStop;
