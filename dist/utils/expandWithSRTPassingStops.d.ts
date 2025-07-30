import type { TrainMovementDTO } from "../qr-travel/types.js";
export declare function expandWithSRTPassingStops(stops: TrainMovementDTO[]): Array<TrainMovementDTO & {
    passing?: boolean;
    expectedPassingTime?: string;
}>;
