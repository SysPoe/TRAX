import type {
	Calendar,
	CalendarDate,
	RealtimeTripUpdate,
	RealtimeVehiclePosition,
	RealtimeStopTimeUpdate,
	Route,
	Stop,
	StopTime,
	Trip,
	GTFS,
} from "qdf-gtfs";
import type { AugmentedStop } from "../utils/augmentedStop.js";
import type { AugmentedTrip, AugmentedTripInstance, RunSeries } from "../utils/augmentedTrip.js";
import type { AugmentedStopTime } from "../utils/augmentedStopTime.js";
import type {
	QRTPlace,
	QRTStationDetails,
	QRTStations,
	QRTTravelTrip,
} from "../region-specific/AU/SEQ/qr-travel/types.js";
import type { Timer } from "../utils/timer.js";
import type { RailwayStationFacility } from "../region-specific/AU/SEQ/facilities-types.js";
import type { ExpressInfo, PassingStop } from "../utils/SRT.js";
import type { PlatformData } from "../utils/platformData.js";
import type { SeqDiagramTopology } from "../region-specific/AU/SEQ/seq-diagram.js";
import type { TraxConfig } from "../config.js";
import { LRUCache } from "./lruCache.js";
import * as qdf from "qdf-gtfs";

export type RawCache = {
	regionSpecific: {
		SEQ: {
			qrtPlaces: QRTPlace[];
			qrtStations: QRTStations;
			qrtTrains: QRTTravelTrip[];
			platformData?: PlatformData;
			railwayStationFacilities: RailwayStationFacility[];
		};
	};
	tripServiceIds?: Map<string, string>;
	injectedTripUpdates?: RealtimeTripUpdate[];
	injectedVehiclePositions?: RealtimeVehiclePosition[];
};

export type AugmentedCache = {
	trips: AugmentedTrip[];
	stops: AugmentedStop[];
	railStations: Stop[];

	stopTimes: { [trip_id: string]: AugmentedStopTime[] };
	baseStopTimes: { [trip_id: string]: AugmentedStopTime[] };
	rawStopTimesCache: Map<string, qdf.StopTime[]>;
	tripsRec: Map<string, AugmentedTrip>;
	stopsRec: Map<string, AugmentedStop>;

	serviceDateTrips: Map<string, string[]>;
	serviceDateTripsSet: Map<string, Set<string>>;
	passingTrips: Map<string, string[]>;

	shapes: { shape_id: string; route_id: string }[];

	expressInfoCache: LRUCache<string, ExpressInfo[]>;
	passingStopsCache: LRUCache<string, PassingStop[]>;
	runSeriesCache: Map<string, Map<string, RunSeries>>;
	carTrips: Map<string, Set<string>>;

	tripsStoppingAt: Map<string, Set<string>>;
	stopDeparturesCached: Map<string, Map<string, AugmentedStopTime[]>>;
	instancesRec: Map<string, AugmentedTripInstance>;
	tripUpdatesCache: Map<string, qdf.RealtimeTripUpdate[]>;
	timer: Timer;
	/** AU/SEQ: inferred trip chains (prev/next) from static topology + realtime gate */
	seqDiagram?: SeqDiagramTopology;
};

export type CacheContext = {
	raw: RawCache;
	augmented: AugmentedCache;
	config: TraxConfig;
	gtfs?: GTFS;
};
