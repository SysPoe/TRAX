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
	TripStopTimeBounds,
	Transfer,
	GTFS,
} from "qdf-gtfs";
import type { AugmentedStop } from "../utils/augmentedStop.js";
import type { AugmentedTrip, AugmentedTripInstance, RunSeries } from "../utils/augmentedTrip.js";
import type { AugmentedStopTime } from "../utils/augmentedStopTime.js";
import type { Timer } from "../utils/timer.js";
import type { ExpressInfo, PassingStop } from "../utils/SRT.js";
import type { CorridorIndex } from "../utils/corridor/shapeIndex.js";
import type { CorridorResolution, RoutePattern } from "../utils/corridor/types.js";
import type { ShapeAlignment } from "../utils/corridor/alignShape.js";
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
	/** Compact native extents used to select eager trip instances without loading stop-time rows. */
	tripStopTimeBoundsByKey: Map<string, TripStopTimeBounds>;
	/** Feed-qualified trips created from ADDED/UNSCHEDULED realtime updates. */
	realtimeOnlyTripKeys: Set<string>;
	stopsByKey: Map<string, Stop>;
	stopsByFeed: Map<string, Stop[]>;
	injectedTripUpdates?: RealtimeTripUpdate[];
	injectedVehiclePositions?: RealtimeVehiclePosition[];
};

export type AugmentedCache = {
	trips: AugmentedTrip[];
	stops: AugmentedStop[];
	railStations: Stop[];

	rawStopTimesCache: Map<string, qdf.StopTime[]>;
	rawTripsRec: Map<string, Trip>;
	/** GTFS type 4/5 linked-trip rules, indexed by feed-qualified from_trip_id. */
	linkedTransfersFromTrip: Map<string, Transfer[]>;
	tripsRec: Map<string, AugmentedTrip>;
	stopsRec: Map<string, AugmentedStop>;

	/** Materialized array views for callers that explicitly need arrays. */
	serviceDateTrips: Map<string, string[]>;
	/** Canonical service-date membership index. */
	serviceDateTripsSet: Map<string, Set<string>>;
	/** Service-date buckets owned by each feed-qualified trip. */
	serviceDatesByTrip: Map<string, Set<string>>;
	/** Materialized array views for callers that explicitly need arrays. */
	passingTrips: Map<string, string[]>;
	/** Canonical passing-stop membership index. */
	passingTripsSet: Map<string, Set<string>>;
	/** Passing-stop buckets owned by each feed-qualified trip. */
	passingStopsByTrip: Map<string, Set<string>>;

	shapes: { feed_id: string; shape_id: string; route_id: string }[];
	/** Static station, shape, and active-pattern indexes for corridor routing. */
	corridorIndex: CorridorIndex;
	/** Physical-route decisions keyed by the complete qualified journey context. */
	corridorResolutionCache: LRUCache<string, CorridorResolution>;
	/** Shape alignments shared by trips with the same qualified physical pattern. */
	corridorAlignmentCache: LRUCache<string, ShapeAlignment>;
	/** Fully exact physical plans shared across qualified trip/date instances. */
	corridorPhysicalResolutionCache: LRUCache<string, CorridorResolution>;
	/** Median pattern timings indexed once per route, direction, and service date. */
	corridorPatternEdgeMinutesCache: Map<string, Map<string, number>>;
	/** Active patterns shared by every gap on the same route, direction, and date. */
	corridorActivePatternsCache: Map<string, RoutePattern[]>;

	expressInfoCache: LRUCache<string, ExpressInfo[]>;
	passingStopsCache: LRUCache<string, PassingStop[]>;
	runSeriesCache: Map<string, Map<string, RunSeries>>;
	carTrips: Map<string, Set<string>>;
	tripNumberTrips: Map<string, Set<string>>;
	/** Direct reverse lookup used when a realtime-only trip is removed. */
	tripNumberByTrip: Map<string, string>;
	/** Position of each trip in the stable public array view. */
	tripArrayIndex: Map<string, number>;

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
		serviceCalendarLoaded: boolean;
		serviceCalendarRules: Map<string, Array<{ startEpochDay: number; endEpochDay: number; weekdayMask: number }>>;
		serviceCalendarExceptions: Map<string, Map<number, 1 | 2>>;
		serviceDayStarts: Map<string, number>;
		availableServiceDates: string[] | null;
		operationalServiceDates: Set<string>;
		operationalWindows: Map<string, { todayEpochDay: number; horizonStart: number; horizonEnd: number }>;
		maxTripLookbackDays: number;
		lazyServiceDates: Map<string, true>;
		dateOffsets: Map<string, string>;
		serviceDateArrays: Map<string, string[]>;
		previousVehicleInfo: Map<string, unknown>;
		srtNetworkData: unknown | null;
		srtExpectedStaticFingerprint: string | null;
	};
};
