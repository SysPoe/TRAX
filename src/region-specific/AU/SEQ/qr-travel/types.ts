export interface QRTTrainMovementDTO {
	PlaceCode: string;
	PlaceName: string;
	gtfsStopId: string | null;
	KStation: string | boolean; // Whether the train stops on request only at this station
	Status: string;
	TrainPosition: "Passed" | "Departed" | "NotArrived" | string;
	PlannedArrival: "0001-01-01T00:00:00" | string;
	PlannedDeparture: "0001-01-01T00:00:00" | string;
	ActualArrival: "0001-01-01T00:00:00" | string;
	ActualDeparture: "0001-01-01T00:00:00" | string;
}

export interface QRTServiceDisruption {
	SummaryText: string;
	PageURL: string;
	HideViziRailData: string | boolean;
	Status: string;
	PageModified: string;
	CoachAvailable: string | boolean;
	Title: string;
}

export interface QRTGetServiceResponse {
	ServiceId: string;
	QRTServiceDisruption: QRTServiceDisruption;
	TrainMovements: QRTTrainMovementDTO[];
	Modified: string;
	Success: string | boolean;
}

export interface QRTPlace {
	Title: string;
	qrt_PlaceCode: string;
}

export interface QRTStationFacility {
	nm: string;
	exists: boolean;
}

export interface QRTStationDetails {
	al: string;
	adhours: string;
	cbay: string;
	stops: string[];
	facs: QRTStationFacility[];
	lat: string;
	lng: string;
	ln: string[];
	ohours: string;
	pcode: string;
	st: string;
	sub: string;
	ph: string;
	Title: string;
	zn: string;
	stdet: string;
	hpdet: string;
	ahrnote: string;
	sginfor: string;
	audiofile: string;
	pdffile: string;
	socialmedia: string;
	stationmapthumb1: string;
	stationmapthumb2: string;
	stationmaporiginal1: string;
	stationmaporiginal2: string;
	stationthumbnailtitle1: string;
	stationthumbnailtitle2: string;
	texttranscriptstring: string;
	[key: string]: unknown;
}

export type QRTStations = Record<string, QRTStationDetails>;

export interface QRTService {
	ServiceId: string;
	ServiceName: string;
	Status: string;
	OffersGoldClass: boolean;
	ServiceDate: string;
	DepartureDate: string;
}

export interface QRTDirection {
	DirectionName: string;
	TerminalStart: string;
	TerminalEnd: string;
	Status: string;
	Services: QRTService[];
}

export interface QRTServiceLine {
	ServiceLineName: string;
	ServiceLineIcon: string;
	StyleClass: string;
	OrderNumber: number;
	Status: string;
	Directions: QRTDirection[];
}

export interface QRTAllServicesResponse {
	ServiceLines: QRTServiceLine[];
	Success: boolean;
	Error: unknown;
}

export interface QRTService {
	Title: string; // e.g. "V972 SSOQ Wed"
	qrt_ServiceLine: string; // e.g. "1;#Spirit of Queensland"
	qrt_Direction: string; // e.g. "Northbound"
	qrt_Destination: string; // e.g. "13;#Cairns"
	qrt_Origin: string; // e.g. "10;#Brisbane - Roma Street"
}

export interface QRTServiceUpdate {
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

export interface QRTTravelStopTime {
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

import type { QRTSRTStop } from "./srt.js";
export interface QRTTravelTrip {
	serviceId: string;
	serviceName: string;
	trip_number: string;
	direction: string;
	line: string;
	status: string;
	offersGoldClass: boolean;
	serviceDate: string;
	departureDate: string;
	stops: QRTTravelStopTime[];
	stopsWithPassing?: QRTSRTStop[];
	disruption?: QRTServiceDisruption;
}
