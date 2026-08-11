import type { RealtimeVehiclePosition } from "qdf-gtfs";
import type { CacheContext } from "../cache/types.js";
import type { AugmentedStop } from "../utils/augmentedStop.js";
import type { AugmentedTripInstance } from "../utils/augmentedTrip.js";
import type { AugmentedStopTime } from "../utils/augmentedStopTime.js";
import type { ServiceCapacity } from "../utils/serviceCapacity.js";
import type { VehicleInfo } from "../utils/vehicleModel.js";

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
	afterStaticLoad?(ctx: CacheContext): Promise<void> | void;
	afterSnapshotBuilt?(ctx: CacheContext): Promise<void> | void;
	/** Fetch and inject supplemental data before the generic realtime cache is rebuilt. */
	beforeRealtime?(ctx: CacheContext): Promise<void> | void;
	/** Enrich the completed realtime snapshot without leaking region checks into core code. */
	afterRealtime?(ctx: CacheContext, changedTripKeys: ReadonlySet<string>): Promise<void> | void;
	enrichStop?(stop: AugmentedStop, ctx: CacheContext, augmentationContext?: unknown): AugmentedStop | void;
	enrichTrip?(trip: AugmentedTripInstance, ctx: CacheContext): AugmentedTripInstance | void;
	vehicleInfo?(vehicle: RealtimeVehiclePosition, ctx: CacheContext): unknown;
	vehicleInfoForTrip?(trip: AugmentedTripInstance, ctx: CacheContext): VehicleInfo | null;
	serviceCapacity?(
		trip: AugmentedTripInstance,
		stopTime: AugmentedStopTime,
		serviceDate: string,
		direction: string | undefined,
		ctx: CacheContext,
	): ServiceCapacity;
	consistDetails?(trip: AugmentedTripInstance, ctx: CacheContext): Promise<unknown> | unknown;
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
