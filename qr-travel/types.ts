export interface TrainMovementDTO {
	PlaceCode: string;
	PlaceName: string;
	KStation: string | boolean; // Whether the train stops on request only at this station
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
	Title: string; // e.g. "V972 SSOQ Wed"
	qrt_ServiceLine: string; // e.g. "1;#Spirit of Queensland"
	qrt_Direction: string; // e.g. "Northbound"
	qrt_Destination: string; // e.g. "13;#Cairns"
	qrt_Origin: string; // e.g. "10;#Brisbane - Roma Street"
}

export interface ServiceUpdate {
	Title: string; // e.g. "V8 Supercar Event - Townsville"
	qrt_StartServiceDate: string; // e.g. "7/4/2025 12:00:00 AM"
	qrt_EndServiceDate: string; // e.g. "7/14/2025 11:00:00 PM"
	qrt_Status: string; // e.g. "Alert", "Anticipated Maintenance", etc.
	qrt_ServiceIds: string; // e.g. "6;#V972 SSOQ Wed ;#10;#V974 SSOQ Thu;#..."
	ContentType: string; // e.g. "QRT Service Disruption Event Page"
	FileRef: string; // e.g. "/ServiceUpdates/Pages/V8-Supercar-Event.aspx"
	qrt_CoachReplacement: string; // e.g. "False" or "True"
	qrt_SummaryMessage: string; // e.g. "Restricted access to Townsville railway station"
}

export interface TravelStopTime {
	placeCode: string;
	placeName: string;
	kStation: string | boolean;
	status: string;
	trainPosition: string;
	plannedArrival: string;
	plannedDeparture: string;
	actualArrival: string;
	actualDeparture: string;
	arrivalDelaySeconds: number | null;
	departureDelaySeconds: number | null;
	delayString: string;
	delayClass: "on-time" | "scheduled" | "late" | "very-late" | "early";
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
