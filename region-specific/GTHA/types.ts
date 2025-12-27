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
