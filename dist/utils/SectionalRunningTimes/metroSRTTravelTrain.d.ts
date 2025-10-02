export type SRTEntry = {
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
    arrivalDelayClass?: "on-time" | "scheduled" | "late" | "very-late" | "early";
    arrivalDelayString?: "on time" | string;
    departureDelaySeconds?: number | null;
    departureDelayClass?: "on-time" | "scheduled" | "late" | "very-late" | "early";
    departureDelayString?: "on time" | string;
}
/**
 * Given an array of TrainMovementDTOs (stopping pattern), return an array of SRTStop including both stops and passing stops with SRT times.
 * For segments not in SRT_DATA, just include the stops as-is.
 */
export declare function expandWithSRTPassingStops(stoppingMovements: TrainMovementDTO[]): SRTStop[];
