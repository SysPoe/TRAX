import type * as gtfs from "gtfs";
import { AugmentedStopTime } from "./augmentedStopTime.js";
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
};
export declare function augmentTrip(trip: gtfs.Trip): AugmentedTrip;
