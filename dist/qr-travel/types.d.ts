export interface TrainMovementDTO {
    PlaceCode: string;
    PlaceName: string;
    gtfsStopId: string | null;
    KStation: string | boolean;
    Status: string;
    TrainPosition: "Passed" | "Departed" | "NotArrived" | string;
    PlannedArrival: "0001-01-01T00:00:00" | string;
    PlannedDeparture: "0001-01-01T00:00:00" | string;
    ActualArrival: "0001-01-01T00:00:00" | string;
    ActualDeparture: "0001-01-01T00:00:00" | string;
}
export interface ServiceDisruption {
    SummaryText: string;
    PageURL: string;
    HideViziRailData: string | boolean;
    Status: string;
    PageModified: string;
    CoachAvailable: string | boolean;
    Title: string;
}
export interface GetServiceResponse {
    ServiceId: string;
    ServiceDisruption: ServiceDisruption;
    TrainMovements: TrainMovementDTO[];
    Modified: string;
    Success: string | boolean;
}
export interface QRTPlace {
    Title: string;
    qrt_PlaceCode: string;
}
export interface Service {
    ServiceId: string;
    ServiceName: string;
    Status: string;
    OffersGoldClass: boolean;
    ServiceDate: string;
    DepartureDate: string;
}
export interface Direction {
    DirectionName: string;
    TerminalStart: string;
    TerminalEnd: string;
    Status: string;
    Services: Service[];
}
export interface ServiceLine {
    ServiceLineName: string;
    ServiceLineIcon: string;
    StyleClass: string;
    OrderNumber: number;
    Status: string;
    Directions: Direction[];
}
export interface AllServicesResponse {
    ServiceLines: ServiceLine[];
    Success: boolean;
    Error: any;
}
export interface QRTService {
    Title: string;
    qrt_ServiceLine: string;
    qrt_Direction: string;
    qrt_Destination: string;
    qrt_Origin: string;
}
export interface ServiceUpdate {
    Title: string;
    qrt_StartServiceDate: string;
    qrt_EndServiceDate: string;
    qrt_Status: string;
    qrt_ServiceIds: string;
    ContentType: string;
    FileRef: string;
    qrt_CoachReplacement: string;
    qrt_SummaryMessage: string;
}
export interface TravelStopTime {
    placeCode: string;
    placeName: string;
    gtfsStopId: string | null;
    kStation: string | boolean;
    status: string;
    trainPosition: string;
    plannedArrival: string;
    plannedDeparture: string;
    actualArrival: string;
    actualDeparture: string;
    arrivalDelaySeconds: number | null;
    departureDelaySeconds: number | null;
    arrivalDelayClass?: "on-time" | "scheduled" | "late" | "very-late" | "early";
    arrivalDelayString?: "on time" | string;
    departureDelayClass?: "on-time" | "scheduled" | "late" | "very-late" | "early";
    departureDelayString?: "on time" | string;
}
import type { SRTStop } from "../utils/SectionalRunningTimes/metroSRTTravelTrain.js";
export interface TravelTrip {
    serviceId: string;
    serviceName: string;
    run: string;
    direction: string;
    line: string;
    status: string;
    offersGoldClass: boolean;
    serviceDate: string;
    departureDate: string;
    stops: TravelStopTime[];
    stopsWithPassing?: SRTStop[];
    disruption?: ServiceDisruption;
}
