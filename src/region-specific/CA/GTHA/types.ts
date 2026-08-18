export interface GTHADepartureStop {
	stopName: string;
	departureTime: string;
	stopCode: string;
	isMajorStop: boolean;
}

export interface GTHAAllDepartureStops {
	stayInTrain: boolean;
	tripNumbers: string[];
	departureDetailsList: GTHADepartureStop[];
}

export interface GTHATrainDeparture {
	lineCode: string;
	tripNumber: string;
	service: string;
	transitType: number;
	transitTypeName: string;
	scheduledTime: string;
	scheduledDateTime: string;
	platform: string;
	scheduledPlatform: string | null;
	stopsDisplay: string;
	info: string;
	lineColour: string;
	allDepartureStops: GTHAAllDepartureStops;
	zone: string | null;
	gate: string | null;
}

export interface GTHADeparturesResponse {
	stationCode: string;
	trainDepartures: {
		items: GTHATrainDeparture[];
		page: number;
		pageSize: number;
		totalItemCount: number;
	};
	busDepartures: {
		items: any[];
		page: number;
		pageSize: number;
		totalItemCount: number;
	};
}

export interface UPEDeparturesResponse {
	metadata: {
		timeStamp: string;
	};
	departures: {
		platform: string;
		departAt: string;
		tripNumber: string;
		arrivalAt: string;
	}[];
}

export interface GthaOperatingScheduleStop {
	order: number;
	id: number;
	name: string;
	engineId: string | null;
	schArrival: string | null;
	schDeparture: string | null;
	revisedArrival: string | null;
	isStopping: "0" | "1";
	isCancelled: "0" | "1";
	isOverride: "0" | "1";
	schTrack: string | null;
	actualTime: string;
	completeInfo?: {
		actArrival: string | null;
		actDeparture: string | null;
		delaySecond: number | null;
		actTrack: string | null;
	} | null;
}

export interface GthaOperatingScheduleTrip {
	tripNumber: string;
	tripName: string;
	updateTime: string;
	stop: GthaOperatingScheduleStop[];
}

export interface GthaOperatingScheduleResponse {
	date: string;
	commitmentTrip: GthaOperatingScheduleTrip[];
}
