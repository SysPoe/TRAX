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
	Transfer,
	GTFS,
} from "qdf-gtfs";
import type { AugmentedStop } from "../utils/augmentedStop.js";
import type { AugmentedTrip, AugmentedTripInstance, RunSeries } from "../utils/augmentedTrip.js";
import type { AugmentedStopTime } from "../utils/augmentedStopTime.js";
import type { Timer } from "../utils/timer.js";
import type { ExpressInfo, PassingStop } from "../utils/SRT.js";
import type { SeqDiagramTopology } from "../region-specific/AU/SEQ/seq-diagram.js";
import type { TraxConfig } from "../config.js";
import { LRUCache } from "./lruCache.js";
import * as qdf from "qdf-gtfs";

export type RawCache = {
	tripServiceIds?: Map<string, string>;
	/** Feed-qualified static entities, populated once per GTFS snapshot. */
	routesByKey: Map<string, Route>;
	tripsByKey: Map<string, Trip>;
	/** Considered trips from the same static snapshot as {@link tripsByKey}. */
	consideredTrips?: Trip[];
	stopsByKey: Map<string, Stop>;
	stopsByFeed: Map<string, Stop[]>;
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
	rawTripsRec: Map<string, Trip>;
	/** GTFS type 4/5 linked-trip rules, indexed by feed-qualified from_trip_id. */
	linkedTransfersFromTrip: Map<string, Transfer[]>;
	tripsRec: Map<string, AugmentedTrip>;
	stopsRec: Map<string, AugmentedStop>;

	serviceDateTrips: Map<string, string[]>;
	serviceDateTripsSet: Map<string, Set<string>>;
	passingTrips: Map<string, string[]>;

	shapes: { feed_id: string; shape_id: string; route_id: string }[];

	expressInfoCache: LRUCache<string, ExpressInfo[]>;
	passingStopsCache: LRUCache<string, PassingStop[]>;
	runSeriesCache: Map<string, Map<string, RunSeries>>;
	carTrips: Map<string, Set<string>>;
	tripNumberTrips: Map<string, Set<string>>;

	tripsStoppingAt: Map<string, Set<string>>;
	stopDeparturesCached: Map<string, Map<string, AugmentedStopTime[]>>;
	instancesRec: Map<string, AugmentedTripInstance>;
	tripUpdatesCache: Map<string, qdf.RealtimeTripUpdate[]>;
	tripUpdateSignatures: Map<string, string>;
	timer: Timer;
	/** AU/SEQ: inferred trip chains (prev/next) from static topology + realtime gate */
	seqDiagram?: SeqDiagramTopology;
	/** AU/SEQ QRT refresh currently in flight; used for stale-while-revalidate deduplication. */
	qrtRefreshInFlight?: Promise<void>;
};

export type CacheContext = {
	raw: RawCache;
	augmented: AugmentedCache;
	config: TraxConfig;
	gtfs?: GTFS;
	/** Every mutable cache owned by plugins is scoped to this runtime. */
	pluginState: Map<string, unknown>;
	runtimeState: {
		consideredRoutes: Map<string, boolean>;
		consideredStops: Map<string, boolean>;
		consideredTrips: Map<string, boolean>;
		serviceDates: Map<string, string[]>;
		serviceDayStarts: Map<string, number>;
		availableServiceDates: string[] | null;
		operationalServiceDates: Set<string>;
		lazyServiceDates: Map<string, true>;
		dateOffsets: Map<string, string>;
		serviceDateArrays: Map<string, string[]>;
		previousVehicleInfo: Map<string, unknown>;
		srtNetworkData: unknown | null;
		srtExpectedStaticFingerprint: string | null;
		srtBfs: Map<string, string[] | null>;
		loggedMissingSrt: Set<string>;
	};
};
