export type SRTEntry = {
    from: string;
    to: string;
    travelTrain: number;
};
export declare let SRT_DATA: SRTEntry[];
import type { TrainMovementDTO } from "../../qr-travel/types.js";
export interface SRTStop {
    placeName: string;
    placeCode: string;
    gtfsStopId: string | null;
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
export declare function expandWithSRTPassingStops(stoppingMovements: TrainMovementDTO[]): SRTStop[];
