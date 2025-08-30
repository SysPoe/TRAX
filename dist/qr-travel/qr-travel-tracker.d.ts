import type { GetServiceResponse, QRTPlace, ServiceLine, QRTService, ServiceUpdate, TravelTrip } from "./types.js";
export declare function trackTrain(serviceID: string, serviceDate: string): Promise<GetServiceResponse>;
export declare function getPlaces(): Promise<QRTPlace[]>;
export declare function getServiceLines(): Promise<ServiceLine[]>;
export declare function getAllServices(): Promise<QRTService[]>;
export declare function getServiceUpdates(startDate?: string, endDate?: string): Promise<ServiceUpdate[]>;
export declare function getCurrentQRTravelTrains(): Promise<TravelTrip[]>;
