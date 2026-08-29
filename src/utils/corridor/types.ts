export interface JourneyAnchor {
	id: string;
	stationId: string | null;

	name?: string;

	lat?: number | null;
	lon?: number | null;

	sequence: number;

	shapeDistTraveled?: number | null;

	scheduled: boolean;
}

export interface JourneyContext {
	sourceId: string;

	feedId: string;
	tripId: string;

	routeId: string | null;
	direction: string | number | null;
	shapeId: string | null;

	serviceDate: string | null;

	anchors: JourneyAnchor[];

	geometryFeedIds: string[];
}

export type CorridorEvidence =
	"exact-shape" | "compatible-shape" | "borrowed-shape" | "manual-corridor" | "manual-topology" | "active-pattern";

export type CorridorConfidence = "high" | "medium" | "low";

export interface CorridorNode {
	id: string;

	stationId: string | null;
	name?: string;

	kind: "station" | "waypoint";

	scheduled: boolean;
	passing: boolean;

	distanceAlongMeters?: number;

	evidence: CorridorEvidence;
	confidence: CorridorConfidence;
}

export interface CorridorGapResolution {
	status: "resolved" | "unresolved";

	from: JourneyAnchor;
	to: JourneyAnchor;

	nodes: CorridorNode[];

	evidence?: CorridorEvidence;
	confidence?: CorridorConfidence;

	diagnostic?: string;
}

export interface CorridorResolution {
	gaps: CorridorGapResolution[];
	nodes: CorridorNode[];
}

export interface StationGeometryCoordinate {
	lat: number;
	lon: number;

	source: "parent" | "platform";
	stopId: string;
}

export interface StationGeometry {
	stationId: string;
	coordinates: StationGeometryCoordinate[];
	names: string[];
}

export interface StationProjection {
	stationId: string;

	segmentIndex: number;
	segmentFraction: number;

	distanceAlongMeters: number;
	lateralDistanceMeters: number;

	coordinateSource: "parent" | "platform";
	nativeShapeDistance?: number | null;
}

export interface ManualCorridorNode {
	id: string;

	stationId?: string | null;

	name?: string;
	aliases?: string[];

	lat?: number;
	lon?: number;

	kind: "station" | "waypoint";
	/** Distinguishes a provider's inferred node kind from explicit declarative knowledge. */
	classification?: "passenger" | "operational" | "unknown";
}

export interface ManualCorridor {
	id: string;

	nodes: string[];

	bidirectional?: boolean;

	routeIds?: string[];
	directions?: Array<string | number | null>;
}

export interface ManualCorridorEdge {
	from: string;
	to: string;

	minutes?: number;

	bidirectional?: boolean;

	routeIds?: string[];
	directions?: Array<string | number | null>;
}

export interface ManualNetwork {
	id: string;

	feedId: string;
	/** Select a provider-specific path strategy for topology-only networks. */
	pathSelection?: "unique" | "shortest";

	nodes: ManualCorridorNode[];

	corridors?: ManualCorridor[];
	edges?: ManualCorridorEdge[];

	priority?: "fallback" | "authoritative";

	/** Optional source namespaces that may use this network. */
	sourceIds?: string[];
	/** Change this value when the declarative data changes. */
	version?: string;
}

export interface CorridorGeometryConfig {
	exactShapeMembershipMaxMeters: number;
	compatibleShapeMaxMeters: number;
	geometryOnlyMaxMeters: number;
	endpointSnapMaxMeters: number;
	maxProjectionsPerStation: number;
}

export interface GeometrySourceConfig {
	feedId: string;
	borrowFromFeedIds: string[];
}

export interface CorridorResolutionConfig {
	enabled: boolean;
	minimumOutputConfidence: CorridorConfidence;
	geometry: CorridorGeometryConfig;
	geometrySources: GeometrySourceConfig[];
	manualNetworks: ManualNetwork[];
	diagnostics: boolean;
	version: string;
}

export interface CorridorResolutionOverrides {
	enabled?: boolean;
	minimumOutputConfidence?: CorridorConfidence;
	geometry?: Partial<CorridorGeometryConfig>;
	geometrySources?: GeometrySourceConfig[];
	manualNetworks?: ManualNetwork[];
	diagnostics?: boolean;
	version?: string;
}

export interface RoutePattern {
	feedId: string;
	routeId: string;
	direction: number | null;

	serviceId: string;

	shapeId: string | null;

	stations: string[];
	tripIds: string[];

	/** Per-leg scheduled duration in minutes, when the feed provides it. */
	edgeMinutes?: number[];
	/** Per-leg shape distance, in feed units, when the feed provides it. */
	edgeDistances?: number[];
}
