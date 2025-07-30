import { TrainMovementDTO } from "../qr-travel/types.js";
export interface ExpressPassingStop {
    placeCode: string;
    placeName: string;
    isPassing: boolean;
    plannedArrival: string | null;
    plannedDeparture: string | null;
    passTime: string | null;
}
/**
 * Given a sequence of TrainMovementDTOs, return an array of all stops (including passing stops) with times.
 * Passing stops are those between two consecutive stopping stations, as per SRT, that are not in the movement list.
 * For passing stops, estimate the pass time by interpolating between the two known stops using SRT times.
 */
export declare function getExpressPassingStops(movements: TrainMovementDTO[]): ExpressPassingStop[];
