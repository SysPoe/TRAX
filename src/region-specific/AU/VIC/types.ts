import type { OccupancyStatus, RealtimeCarriageDetails } from "qdf-gtfs";
import type { ChronosDirection, ChronosPatternResponse } from "./chronos.js";

export type ObservationConfidence = "confirmed" | "reported" | "inferred";

export type VLineObservationSource =
	| "vic-vline-gtfsrt-vehicle-positions"
	| "vline-journey-planner"
	| "ptv-chronos"
	| "vline-scs-html"
	| "static-platform-heuristic";

export type Observation<T> = {
	value: T;
	source: VLineObservationSource;
	confidence: ObservationConfidence;
	observedAt: string;
	sourceTimestamp?: string;
	expiresAt?: string;
	rawIdentifier?: string;
};

export type VLinePlatformObservation = Observation<string> & {
	stopId: string;
	event: "arrival" | "departure" | "both";
	kind: "platform";
};

export type VLineScsServiceObservation = Observation<{
	boardGroup: string | null;
	scheduledTime: string;
	destination: string;
	coachesFrom: string | null;
	departingIn: string | null;
	departingInSeconds: number | null;
	cancelled: boolean;
}>;

export type VLineChronosServiceObservation = Observation<{
	status: string | null;
	destination: string | null;
	direction: string | null;
	scheduledDepartureUtc: string | null;
	estimatedDepartureUtc: string | null;
	atPlatform: boolean;
}>;

export type VLineChronosCallObservation = {
	stopId: string;
	chronosStopId: number;
	scheduledDepartureUtc: string;
	estimatedDepartureUtc: string | null;
	atPlatform: boolean;
	platform: string | null;
	source: "ptv-chronos";
	observedAt: string;
	expiresAt: string;
};

export type VLineTripDetails = {
	tdn: string;
	chronosRunRef: Observation<string> | null;
	leadingUnit: Observation<string> | null;
	fullConsist: Observation<string[]> | null;
	subtype: Observation<string> | null;
	unitCount: Observation<number> | null;
	passengerCars: Observation<number> | null;
	occupancyStatus: Observation<OccupancyStatus> | null;
	occupancyPercentage: Observation<number> | null;
	carriageOccupancy: Observation<RealtimeCarriageDetails[]> | null;
	serviceStatus: Observation<string> | null;
	chronosService: VLineChronosServiceObservation | null;
	chronosCalls: VLineChronosCallObservation[];
	scsService: VLineScsServiceObservation | null;
	platforms: VLinePlatformObservation[];
};

export type VLineSourceName = "journey-planner" | "chronos" | "scs-board";

export type VLineSourceStatus = {
	enabled: boolean;
	lastAttemptAt: string | null;
	lastSuccessAt: string | null;
	error: string | null;
};

export type VLinePluginState = {
	detailsByInstanceId: Map<string, VLineTripDetails>;
	detailsByServiceKey: Map<string, VLineTripDetails>;
	canonicalTripIdByRealtimeKey: Map<string, string>;
	canonicalTripIdByServiceKey: Map<string, string>;
	chronosRunByInstanceId: Map<string, string>;
	chronosStopByGtfsStopId: Map<string, number>;
	chronosRouteByStopAndGtfs: Map<string, number>;
	chronosDirectionsByRouteId: Map<number, ChronosDirection[]>;
	chronosDirectionByStopAndRoute: Map<string, number>;
	chronosDiscoveryRetryAt: Map<string, number>;
	chronosPatternCache: Map<string, { response: ChronosPatternResponse; expiresAt: number }>;
	sources: Record<VLineSourceName, VLineSourceStatus>;
	lastRefreshAt: string | null;
};

export type VLineJourneyPlannerOptions = {
	callerId: string;
	applicationSignature: string;
	baseUrl?: string;
	locations?: readonly string[];
	windowMinutes?: number;
};

export type VLineChronosOptions = {
	apiKey: string;
	baseUrl?: string;
};

export type VLinePluginOptions = {
	journeyPlanner?: VLineJourneyPlannerOptions;
	chronos?: VLineChronosOptions;
	scsBoard?: false | { url?: string };
	platformHeuristics?: boolean;
	requestTimeoutMs?: number;
	/** Optional explicit trip-instance override; normal production use discovers runs automatically. */
	chronosRunRefs?: Readonly<Record<string, string>>;
};

export type VLineJourneyPlannerService = {
	origin: string | null;
	destination: string | null;
	scheduledDepartureTime: string;
	scheduledDestinationArrivalTime: string | null;
	tdn: string;
	platform: string | null;
	direction: "Up" | "Down" | null;
	consistSubtype: string | null;
	consistCount: number | null;
	consistVehicles: string[] | null;
	isLiveConsistInfo: boolean;
	serviceStatus: string | null;
};

export type VLineScsBoardRow = {
	time: string;
	destination: string;
	boardGroup: string | null;
	coachesFrom: string | null;
	platform: string | null;
	boardingKind: "platform" | null;
	departingIn: string | null;
	departingInSeconds: number | null;
	cancelled: boolean;
};
