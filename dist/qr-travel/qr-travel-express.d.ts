import type { TrainMovementDTO, TravelStopTime } from "./types.js";
/**
 * Enhanced express information for QR Travel trains
 */
export interface QRTravelExpressInfo {
    type: "express" | "stopping" | "unknown";
    from: string;
    to: string;
    passingStops?: string[];
    message?: string;
    srtAvailable: boolean;
}
/**
 * Enhanced travel stop time with express information
 */
export interface EnhancedTravelStopTime extends TravelStopTime {
    passing: boolean;
    expressInfo?: QRTravelExpressInfo;
    calculatedArrival?: string;
    calculatedDeparture?: string;
}
/**
 * Calculate passing stops and their estimated times for QR Travel trains
 */
export declare function calculateQRTravelExpressStops(movements: TrainMovementDTO[]): EnhancedTravelStopTime[];
/**
 * Format time for display
 */
export declare function formatTime(timeString: string): string;
