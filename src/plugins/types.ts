import type { RealtimeTripUpdate, RealtimeUpdateTripInfo, RealtimeVehiclePosition, Route } from "qdf-gtfs";
import type { CacheContext } from "../cache/types.js";
import type { AugmentedStop } from "../utils/augmentedStop.js";
import type { AugmentedTripInstance } from "../utils/augmentedTrip.js";
import type { AugmentedStopTime } from "../utils/augmentedStopTime.js";
import type { ServiceCapacity } from "../utils/serviceCapacity.js";
import type { VehicleFormation, VehicleFormationUnit, VehicleInfo } from "../utils/vehicleModel.js";

export type TransitCapability =
	| "vehicles"
	| "occupancy"
	| "consist"
	| "platform-changes"
	| "boarding-locations"
	| "facilities"
	| "supplemental-realtime";

export interface TransitPlugin {
	id: string;
	/** Static feeds whose entities this plugin may enrich. */
	feedIds: readonly string[];
	capabilities: readonly TransitCapability[];
	/**
	 * Opt-in concurrency group for lifecycle hooks. Plugins sharing a group
	 * run concurrently (fetch phases overlap); groups must be audited as
	 * mutually independent: pairwise-disjoint `feedIds`, source-keyed shared
	 * writes (see `replaceInjectedTripUpdates`), and no cross-plugin state
	 * reads. Ungrouped plugins keep today's sequential registration order.
	 * Enforced disjoint at `resolveConfig`.
	 */
	concurrencyGroup?: string;
	afterStaticLoad?(ctx: CacheContext): Promise<void> | void;
	afterSnapshotBuilt?(ctx: CacheContext): Promise<void> | void;
	/** Fetch and inject supplemental data before the generic realtime cache is rebuilt. */
	beforeRealtime?(ctx: CacheContext): Promise<void> | void;
	/** Veto routes that a provider encodes with a rail-like type but does not operate as rail. */
	considerRoute?(route: Route, ctx: CacheContext): boolean | undefined;
	/** Mark depot, empty-car, and other movements that normal passenger views hide. */
	isNonRevenueRoute?(route: Route, ctx: CacheContext): boolean;
	/** Resolve a provider trip descriptor to the static trip identity used by this runtime. */
	canonicalRealtimeTripId?(trip: RealtimeUpdateTripInfo, ctx: CacheContext): string | null;
	/** Fill provider omissions in a realtime trip update before it joins static service instances. */
	enrichRealtimeTripUpdate?(update: RealtimeTripUpdate, ctx: CacheContext): RealtimeTripUpdate | void;
	/** Enrich the completed realtime snapshot without leaking region checks into core code. */
	afterRealtime?(ctx: CacheContext, changedTripKeys: ReadonlySet<string>): Promise<void> | void;
	/** Correct or enrich a provider vehicle observation when it crosses the runtime boundary. */
	enrichVehiclePosition?(
		vehicle: RealtimeVehiclePosition,
		ctx: CacheContext,
	): RealtimeVehiclePosition | void;
	enrichStop?(stop: AugmentedStop, ctx: CacheContext, augmentationContext?: unknown): AugmentedStop | void;
	enrichTrip?(trip: AugmentedTripInstance, ctx: CacheContext): AugmentedTripInstance | void;
	vehicleInfo?(vehicle: RealtimeVehiclePosition, ctx: CacheContext): unknown;
	vehicleInfoForTrip?(trip: AugmentedTripInstance, ctx: CacheContext): VehicleInfo | null;
	/** Resolve a complete formation when the provider needs an on-demand lookup. */
	vehicleFormation?(
		trip: AugmentedTripInstance,
		ctx: CacheContext,
	): Promise<VehicleFormation | null> | VehicleFormation | null;
	serviceCapacity?(
		trip: AugmentedTripInstance,
		stopTime: AugmentedStopTime,
		serviceDate: string,
		direction: string | undefined,
		ctx: CacheContext,
	): ServiceCapacity;
	/** Adapt provider-specific consist data into ordered, provider-neutral formation units. */
	vehicleFormationUnits?(
		trip: AugmentedTripInstance,
		ctx: CacheContext,
	): Promise<readonly VehicleFormationUnit[] | null> | readonly VehicleFormationUnit[] | null;
	filterTrackEdges?(edges: Set<string>): void;
	enrichTrackGraph?(matrix: Record<string, Record<string, number>>, adjacency: Record<string, string[]>): void;
	/** Optional region service surface, available only when this plugin is installed. */
	api?(ctx: CacheContext): unknown;
}

export function pluginSupportsFeed(plugin: TransitPlugin, feedId: string): boolean {
	return plugin.feedIds.includes(feedId);
}

export function getPluginState<T>(ctx: CacheContext, pluginId: string, create: () => T): T {
	if (!ctx.pluginState.has(pluginId)) ctx.pluginState.set(pluginId, create());
	return ctx.pluginState.get(pluginId) as T;
}
