export declare type SRTEntry = {
    from: string;
    to: string;
    travelTrain: number;
};
export declare let SRT_DATA: SRTEntry[];
import type { TrainMovementDTO } from "../../qr-travel/types.js";
export interface SRTStop {
    placeName: string;
    isStop: boolean;
    plannedArrival: string;
    plannedDeparture: string;
    actualArrival?: string;
    actualDeparture?: string;
    srtMinutes?: number;
    estimatedPassingTime?: string;
    arrivalDelaySeconds?: number | null;
    departureDelaySeconds?: number | null;
}
/**
 * Given an array of TrainMovementDTOs (stopping pattern), return an array of SRTStop including both stops and passing stops with SRT times.
 * For segments not in SRT_DATA, just include the stops as-is.
 */
export declare function expandWithSRTPassingStops(stoppingMovements: TrainMovementDTO[]): SRTStop[];
