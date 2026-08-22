import type { OccupancyStatus, RealtimeCarriageDetails } from "qdf-gtfs";
import type { AnyTripPlatformClient, AnyTripPlatformClientOptions } from "./anytrip.js";
import type { VLineBookingSnapshot } from "./booking-snapshots.js";

export type ObservationConfidence = "confirmed" | "reported" | "inferred";

export type VLineObservationSource =
	| "vic-vline-gtfsrt-vehicle-positions"
	| "vline-journey-planner"
	| "vline-platform-services"
	| "vline-journey-planner-web"
	| "anytrip-v3"
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

export type VLineTripDetails = {
	tdn: string;
	leadingUnit: Observation<string> | null;
	fullConsist: Observation<string[]> | null;
	subtype: Observation<string> | null;
	unitCount: Observation<number> | null;
	passengerCars: Observation<number> | null;
	accessibleSpaces: Observation<number> | null;
	bicycleSpaces: Observation<number> | null;
	isLiveConsistInfo: Observation<boolean> | null;
	consistDescription: Observation<string> | null;
	bookingAvailability: VLineBookingAvailability | null;
	occupancyStatus: Observation<OccupancyStatus> | null;
	occupancyPercentage: Observation<number> | null;
	carriageOccupancy: Observation<RealtimeCarriageDetails[]> | null;
	serviceStatus: Observation<string> | null;
	scsService: VLineScsServiceObservation | null;
	platforms: VLinePlatformObservation[];
};

export type VLineSourceName = "journey-planner" | "anytrip" | "scs-board";

export type VLineSourceStatus = {
	enabled: boolean;
	lastAttemptAt: string | null;
	lastSuccessAt: string | null;
	error: string | null;
};

export type VLineDiagnostics = {
	lastRefreshAt: string | null;
	trackedTrips: number;
	linkedServiceKeys: number;
	canonicalRealtimeTrips: number;
	canonicalServiceTrips: number;
	sources: Record<VLineSourceName, VLineSourceStatus>;
	journeyPlanner: {
		serviceCacheEntries: number;
		requestsInFlight: number;
		bookingCacheEntries: number;
		bookingRequestsInFlight: number;
		persistedBookingSnapshots: number;
		bookingPrefetchAttempts: number;
		platformLocationsCached: number;
		platformStationsPolled: number;
		platformStationErrors: number;
	};
	anyTrip: {
		stationCacheEntries: number;
		tripCacheEntries: number;
		requestsInFlight: number;
		enrichedTrips: number;
		platformObservations: number;
	};
	scsBoard: {
		enrichedServices: number;
	};
};

export type VLinePluginState = {
	detailsByInstanceId: Map<string, VLineTripDetails>;
	detailsByServiceKey: Map<string, VLineTripDetails>;
	canonicalTripIdByRealtimeKey: Map<string, string>;
	canonicalTripIdByServiceKey: Map<string, string>;
	journeyCache: Map<string, { services: VLineJourneyPlannerService[]; expiresAt: number }>;
	journeyInFlight: Map<string, Promise<VLineJourneyPlannerService[]>>;
	bookingCache: Map<string, { availability: VLineBookingAvailability | null; expiresAt: number }>;
	bookingInFlight: Map<string, Promise<VLineBookingAvailability | null>>;
	bookingSnapshots: Map<string, VLineBookingSnapshot>;
	bookingPrefetchAttempted: Set<string>;
	platformLocationsCache: { locations: VLineJourneyPlannerLocation[]; expiresAt: number } | null;
	platformPollByLocation: Map<string, { lastAttemptAt: number; lastSuccessAt: number | null; error: string | null }>;
	anyTripClient: AnyTripPlatformClient | null;
	sources: Record<VLineSourceName, VLineSourceStatus>;
	lastRefreshAt: string | null;
};

export type VLineJourneyPlannerOptions = {
	callerId: string;
	applicationSignature: string;
	baseUrl?: string;
	locations?: readonly string[];
	/** Forward-looking station-board window. The V/Line API rejects values below 30 minutes. */
	windowMinutes?: number;
	/** Minimum interval between platform-board requests for the same station. */
	platformRefreshIntervalMs?: number;
};

export type VLinePluginOptions = {
	journeyPlanner?: VLineJourneyPlannerOptions;
	anyTrip?: AnyTripPlatformClientOptions;
	scsBoard?: false | { url?: string };
	platformHeuristics?: boolean;
	requestTimeoutMs?: number;
};

export type VLineJourneyPlannerService = {
	locationName: string | null;
	origin: string | null;
	destination: string | null;
	scheduledDepartureTime: string;
	scheduledDestinationArrivalTime: string | null;
	actualArrivalTime: string | null;
	actualDestinationArrivalTime: string | null;
	tdn: string;
	platform: string | null;
	platformEvent: "arrival" | "departure" | null;
	direction: "Up" | "Down" | null;
	consistSubtype: string | null;
	consistCount: number | null;
	consistVehicles: string[] | null;
	isLiveConsistInfo: boolean;
	serviceStatus: string | null;
	consistDescription: string | null;
	accessibleSpaces: number | null;
	bicycleSpaces: number | null;
	reservationAvailable: boolean;
	reservationRequired: boolean;
	reservedCarriages: string[];
	reservedSeatsAvailable: number | null;
	unreservedTicketsAvailable: number | null;
	canBookInJourneyPlanner: boolean;
};

export type VLineJourneyPlannerLocation = {
	name: string;
	stopCode: string | null;
	stopType: string | null;
	line: string | null;
};

export type VLineBookingAvailability = {
	tdn: string;
	reservedCarriages: string[];
	reservedSeatsAvailable: number | null;
	unreservedTicketsAvailable: number | null;
	reservationAvailable: boolean;
	reservationRequired: boolean;
	seatMapAvailable: boolean;
	journeyUrl: string;
	observedAt: string;
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
