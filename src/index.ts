import * as cache from "./cache/index.js";
import * as stations from "./utils/stations.js";
import * as qrTravel from "./region-specific/AU/SEQ/qr-travel/qr-travel-tracker.js";
import * as timeUtils from "./utils/time.js";
import { EventEmitter } from "events";
import { GTFS, RealtimeVehiclePosition, Route, Stop, Trip } from "qdf-gtfs";
import type { QualifiedEntityId, StopTime } from "qdf-gtfs";
import logger from "./utils/logger.js";
import { findExpressString } from "./utils/SRT.js";
import {
	attachDeparturesHelpers,
	getDeparturesForInstantWindow,
	getDeparturesForStop,
	getServiceDateDeparturesForStop,
} from "./utils/departures.js";
import {
	isConsideredRoute,
	isNonRevenueRoute,
	isConsideredStop,
	isConsideredStopId,
	isConsideredTrip,
	isConsideredTripId,
} from "./utils/considered.js";
import { AugmentedStop } from "./utils/augmentedStop.js";
import {
	getFeedTimeZone,
	getPlaceForStation,
	type NetworkDefinition,
	type RuntimeOptions,
	type TraxConfig,
	resolveConfig,
} from "./config.js";
import { createGtfs, loadRealtime, loadStatic, type SourceReport } from "./gtfsInterfaceLayer.js";
import { runPluginHooks } from "./plugins/concurrency.js";
import { entityKey } from "./identity.js";
import { createVehicleFormation, type VehicleFormation } from "./utils/vehicleModel.js";
import { getOnboardReachableStops, type ReachabilityOrigin } from "./utils/passengerContinuations.js";

export interface TRAXEvent {
	"realtime-update-start": [];
	"realtime-update-end": [];
	"static-update-start": [];
	/** Emitted only after a static generation publishes successfully. */
	"static-update-end": [];
	/** Emitted when a static refresh fails; previous snapshot stays published. */
	"static-update-failed": [string];
}

export interface SourceHealth {
	id: string;
	feedId: string;
	kind: SourceReport["kind"] | "supplemental";
	state: "idle" | SourceReport["state"];
	lastAttemptAt: string | null;
	lastSuccessAt: string | null;
	error: string | null;
	transport: SourceReport["transport"] | null;
}

export type StaticRefreshCoordinator = <T>(task: () => Promise<T>) => Promise<T>;

export class TRAX {
	public config: TraxConfig;
	public gtfs?: GTFS;
	public events: EventEmitter;

	private ctx: cache.CacheContext;
	private realtimeInterval: NodeJS.Timeout | null = null;
	private staticInterval: NodeJS.Timeout | null = null;
	private staticRefreshInFlight: Promise<void> | null = null;
	private realtimeRefreshInFlight: Promise<void> | null = null;
	private sourceHealth = new Map<string, SourceHealth>();
	private coordinateStaticRefresh: StaticRefreshCoordinator;
	/**
	 * Monotonic static publication counter. Bumped in the same synchronous
	 * block as the gtfs/config/ctx pointer swap, so any reader that sees the
	 * new context also sees the new generation. Never bumped on failure.
	 */
	private staticGeneration = 0;
	private lastStaticPublishedAt: number | null = null;

	private hasRealtimeSources(): boolean {
		return (
			this.config.network.feeds.some((feed) => feed.realtimeSources.length > 0) ||
			this.config.network.plugins.some((plugin) => plugin.beforeRealtime !== undefined) ||
			this.config.network.plugins.some((plugin) => plugin.afterRealtime !== undefined)
		);
	}

	constructor(
		network: NetworkDefinition,
		options: RuntimeOptions = {},
		coordinateStaticRefresh: StaticRefreshCoordinator = (task) => task(),
	) {
		this.config = resolveConfig(network, options);
		this.events = new EventEmitter();
		this.coordinateStaticRefresh = coordinateStaticRefresh;

		this.ctx = {
			raw: cache.createEmptyRawCache(),
			augmented: cache.createAugmentedCacheWithConfig(this.config),
			config: this.config,
			pluginState: new Map(),
			runtimeState: cache.createRuntimeState(),
		};
		for (const feed of network.feeds) {
			this.sourceHealth.set(`${feed.id}:static`, {
				id: `${feed.id}:static`,
				feedId: feed.id,
				kind: "static",
				state: "idle",
				lastAttemptAt: null,
				lastSuccessAt: null,
				error: null,
				transport: null,
			});
			for (const source of feed.realtimeSources)
				this.sourceHealth.set(source.id, {
					id: source.id,
					feedId: feed.id,
					kind: source.kind,
					state: "idle",
					lastAttemptAt: null,
					lastSuccessAt: null,
					error: null,
					transport: null,
				});
		}
		for (const plugin of network.plugins) {
			if (!plugin.beforeRealtime && !plugin.afterRealtime) continue;
			const id = `${plugin.id}:supplemental`;
			this.sourceHealth.set(id, {
				id,
				feedId: plugin.feedIds[0],
				kind: "supplemental",
				state: "idle",
				lastAttemptAt: null,
				lastSuccessAt: null,
				error: null,
				transport: null,
			});
		}
	}

	private reportSource = (report: SourceReport): void => {
		const previous = this.sourceHealth.get(report.id);
		const now = new Date().toISOString();
		this.sourceHealth.set(report.id, {
			id: report.id,
			feedId: report.feedId,
			kind: report.kind,
			state: report.state,
			lastAttemptAt: report.state === "loading" ? now : (previous?.lastAttemptAt ?? now),
			lastSuccessAt:
				report.state === "healthy" || report.state === "stale" ? now : (previous?.lastSuccessAt ?? null),
			error: report.error ?? null,
			transport: report.transport ?? previous?.transport ?? null,
		});
	};

	private reportSupplemental(
		pluginId: string,
		feedId: string,
		state: "loading" | "healthy" | "error",
		error?: string,
	): void {
		const id = `${pluginId}:supplemental`;
		const previous = this.sourceHealth.get(id);
		const now = new Date().toISOString();
		this.sourceHealth.set(id, {
			id,
			feedId,
			kind: "supplemental",
			state,
			lastAttemptAt: state === "loading" ? now : (previous?.lastAttemptAt ?? now),
			lastSuccessAt: state === "healthy" ? now : (previous?.lastSuccessAt ?? null),
			error: error ?? null,
			transport: null,
		});
	}

	public async loadGTFS(
		loadRealtime: boolean = true,
		autoRefresh: boolean = false,
		realtimeIntervalMs: number = 60 * 1000,
		staticIntervalMs: number = 24 * 60 * 60 * 1000,
	): Promise<void> {
		if (!this.gtfs) {
			await this.ensureGtfs(loadRealtime);
			if (loadRealtime) await this.refreshRealtime();
		} else {
			await this.refreshStatic();
			if (loadRealtime) await this.refreshRealtime();
		}

		if (!autoRefresh) return;
		this.startAutoRefresh(loadRealtime, realtimeIntervalMs, staticIntervalMs);
	}

	public startAutoRefresh(
		refreshRealtime: boolean = true,
		realtimeIntervalMs: number = 60 * 1000,
		staticIntervalMs: number = 24 * 60 * 60 * 1000,
	): void {
		const scheduleNextRealtime = () => {
			if (this.realtimeInterval) return;
			this.realtimeInterval = setTimeout(async () => {
				this.realtimeInterval = null;
				this.events.emit("realtime-update-start");
				try {
					await this.updateRealtime();
				} catch (error: any) {
					logger.error("Error updating realtime GTFS data: " + (error.message ?? error), {
						module: "index",
						function: "loadGTFS - scheduleNextRealtime",
					});
				} finally {
					this.events.emit("realtime-update-end");
					scheduleNextRealtime();
				}
			}, realtimeIntervalMs);
		};

		const scheduleNextStatic = () => {
			if (this.staticInterval) return;
			this.staticInterval = setTimeout(async () => {
				this.staticInterval = null;
				this.events.emit("static-update-start");
				try {
					await this.refreshStatic();
					// The realtime tail is part of the static cycle: bracket it
					// with the same pair the realtime timer emits, so consumers
					// (GUI revisions, telemetry snapshots, cache invalidation)
					// observe the tail's completion exactly once. updateRealtime
					// swallows its own errors, so end always fires here.
					if (this.hasRealtimeSources()) {
						this.events.emit("realtime-update-start");
						try {
							await this.updateRealtime();
						} finally {
							this.events.emit("realtime-update-end");
						}
					}
					this.events.emit("static-update-end");
				} catch (error: any) {
					const message = error?.message ?? String(error);
					logger.error("Error refreshing static GTFS data: " + message, {
						module: "index",
						function: "loadGTFS - scheduleNextStatic",
					});
					this.events.emit("static-update-failed", message);
				} finally {
					scheduleNextStatic();
				}
			}, staticIntervalMs);
		};

		if (this.hasRealtimeSources() && refreshRealtime) scheduleNextRealtime();
		scheduleNextStatic();
	}

	/**
	 * Ensures GTFS is initialized and initial caches are built.
	 * If GTFS is already initialized, this does nothing.
	 */
	private async ensureGtfs(initialRealtime: boolean = false): Promise<GTFS> {
		if (this.gtfs) return this.gtfs;
		await this.refreshStatic(initialRealtime);
		if (!this.gtfs) throw new Error("Static GTFS refresh completed without a snapshot");
		return this.gtfs;
	}

	private async initializeGtfs(initialRealtime: boolean): Promise<void> {
		const gtfs = await createGtfs(this.config, initialRealtime, this.reportSource);
		this.validateFeedTimeZones(gtfs);
		this.ctx.augmented.timer.start("TRAX:initialCacheRefresh");
		const nextCtx = await cache.refreshStaticCache(gtfs, this.config);
		nextCtx.augmented.timer.stop("TRAX:initialCacheRefresh");
		this.gtfs = gtfs;
		this.config = nextCtx.config;
		this.ctx = nextCtx;
		this.publishStaticGeneration();
	}

	/** Record a successful static publication alongside the pointer swap. */
	private publishStaticGeneration(): void {
		this.staticGeneration += 1;
		this.lastStaticPublishedAt = Date.now();
	}

	/** Monotonic id of the currently published static snapshot (0 = none). */
	public getStaticGeneration(): number {
		return this.staticGeneration;
	}

	public getLastStaticPublishedAt(): number | null {
		return this.lastStaticPublishedAt;
	}

	/**
	 * Refreshes static GTFS data from source and rebuilds the static cache.
	 */
	public async refreshStatic(initialRealtime: boolean = false): Promise<void> {
		if (this.staticRefreshInFlight) return this.staticRefreshInFlight;
		this.staticRefreshInFlight = this.coordinateStaticRefresh(async () => {
			if (!this.gtfs) {
				await this.initializeGtfs(initialRealtime);
				return;
			}
			const retainedState = cache.retainStaticRefreshState(this.ctx);
			const previousCtx = this.ctx;
			const previousGtfs = this.gtfs;
			let nextGtfs: import("qdf-gtfs").GTFS | null = null;
			let nextCtx: cache.CacheContext | null = null;
			try {
				const { createGtfs } = await import("./gtfsInterfaceLayer.js");
				nextGtfs = await createGtfs(this.config, false, this.reportSource);
				this.validateFeedTimeZones(nextGtfs);
				nextCtx = await cache.refreshStaticCache(nextGtfs, this.config, retainedState);
			} catch (error) {
				logger.error(`Static refresh failed, retaining previous generation: ${error instanceof Error ? error.message : String(error)}`, { module:"index", function:"refreshStatic" });
				if (nextGtfs) try { nextGtfs.clearStatic(); } catch {}
				throw error;
			}
			this.gtfs = nextGtfs!;
			this.config = nextCtx!.config;
			this.ctx = nextCtx!;
			this.publishStaticGeneration();
			setTimeout(() => { try { previousGtfs.clearStatic(); } catch {} }, 30_000).unref?.();
		}).finally(() => {
			this.staticRefreshInFlight = null;
		});
		return this.staticRefreshInFlight;
	}

	/**
	 * Refreshes realtime GTFS data from source and rebuilds the realtime cache.
	 *
	 * Concurrent callers share one in-flight refresh. If a static publication
	 * lands mid-refresh, the attempt aborts and restarts once against the new
	 * snapshot instead of mutating it with old-generation data; anything still
	 * stale heals on the next 60s tick. This also makes the static tail's
	 * updateRealtime() join safe: it transparently receives fresh work.
	 */
	public async refreshRealtime(): Promise<void> {
		if (this.realtimeRefreshInFlight) return this.realtimeRefreshInFlight;
		this.realtimeRefreshInFlight = this.refreshRealtimeGuarded().finally(() => {
			this.realtimeRefreshInFlight = null;
		});
		return this.realtimeRefreshInFlight;
	}

	private async refreshRealtimeGuarded(): Promise<void> {
		try {
			await this.refreshRealtimeOnce();
		} catch (error) {
			if (!(error instanceof cache.StaleGenerationError)) throw error;
			await this.refreshRealtimeOnce();
		}
	}

	private async refreshRealtimeOnce(): Promise<void> {
			const gtfs = await this.ensureGtfs(true);
			const generation = this.staticGeneration;
			const assertCurrent = () => {
				if (this.staticGeneration !== generation || this.gtfs !== gtfs)
					throw new cache.StaleGenerationError();
			};
			const shouldAbort = () => this.staticGeneration !== generation || this.gtfs !== gtfs;
			this.ctx.augmented.timer.start("refreshRealtime");
			if (this.config.network.feeds.some((feed) => feed.realtimeSources.length > 0)) {
				await loadRealtime(gtfs, this.config, this.reportSource);
			}
			assertCurrent();
			const failedSupplemental = new Set<string>();
			await runPluginHooks(
				this.config.network.plugins.filter((plugin) => plugin.beforeRealtime),
				(plugin) => {
					assertCurrent();
					this.reportSupplemental(plugin.id, plugin.feedIds[0], "loading");
					return plugin.beforeRealtime!(this.ctx);
				},
				{
					abortOnError: false,
					onError: (plugin, error) => {
						if (error instanceof cache.StaleGenerationError) throw error;
						failedSupplemental.add(plugin.id);
						const message = error instanceof Error ? error.message : String(error);
						this.reportSupplemental(plugin.id, plugin.feedIds[0], "error", message);
						logger.error(`Supplemental source '${plugin.id}' failed: ${message}`, {
							module: "index",
							function: "refreshRealtime",
						});
					},
				},
			);
			for (const plugin of this.config.network.plugins) {
				if (!plugin.beforeRealtime || failedSupplemental.has(plugin.id)) continue;
				this.reportSupplemental(plugin.id, plugin.feedIds[0], "healthy");
			}
			const afterRealtimePlugins = this.config.network.plugins.filter((plugin) => plugin.afterRealtime);
			for (const plugin of afterRealtimePlugins) this.reportSupplemental(plugin.id, plugin.feedIds[0], "loading");
			try {
				assertCurrent();
				await cache.refreshRealtimeCache(this.gtfs!, this.config, this.ctx, { shouldAbort });
				for (const plugin of afterRealtimePlugins)
					this.reportSupplemental(plugin.id, plugin.feedIds[0], "healthy");
			} catch (error) {
				if (error instanceof cache.StaleGenerationError) throw error;
				const message = error instanceof Error ? error.message : String(error);
				for (const plugin of afterRealtimePlugins)
					this.reportSupplemental(plugin.id, plugin.feedIds[0], "error", message);
				throw error;
			}
			this.ctx.augmented.timer.stop("refreshRealtime");
	}

	public async updateRealtime(): Promise<void> {
		if (!this.hasRealtimeSources()) return;
		try {
			await this.refreshRealtime();
		} catch (error: any) {
			logger.error("Error updating realtime GTFS data: " + (error.message ?? error), {
				module: "index",
				function: "updateRealtime",
			});
		}
	}

	public clearIntervals(): void {
		if (this.realtimeInterval) {
			clearTimeout(this.realtimeInterval);
			this.realtimeInterval = null;
		}
		if (this.staticInterval) {
			clearTimeout(this.staticInterval);
			this.staticInterval = null;
		}
	}

	public formatTimestamp(ts?: number | null): string {
		if (ts === null || ts === undefined) return "--:--";
		let h = Math.floor(ts / 3600);
		let m = Math.floor((ts % 3600) / 60);
		return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
	}

	public today(): string {
		const firstFeed = this.config.network.feeds[0];
		return timeUtils.getServiceDate(new Date(), getFeedTimeZone(this.config, firstFeed.id));
	}

	private validateFeedTimeZones(gtfs: GTFS): void {
		const next = new Map<string, string>();
		for (const feed of this.config.network.feeds) {
			const agencyZones = new Set(
				gtfs
					.getAgencies({ feed_id: feed.id })
					.map((agency) => agency.agency_timezone)
					.filter(Boolean),
			);
			if (feed.timeZone) {
				next.set(feed.id, feed.timeZone);
				continue;
			}
			if (agencyZones.size !== 1) {
				throw new Error(
					`Feed '${feed.id}' must declare exactly one agency_timezone; found ${Array.from(agencyZones).join(", ") || "none"}`,
				);
			}
			next.set(feed.id, Array.from(agencyZones)[0]);
		}
		this.config.feedTimeZones = next;
	}

	public get metadata() {
		const feedCapabilities = (feedId: string) =>
			Array.from(
				new Set(
					this.config.network.plugins
						.filter((plugin) => plugin.feedIds.includes(feedId))
						.flatMap((plugin) => plugin.capabilities),
				),
			);
		return {
			id: this.config.network.id,
			name: this.config.network.name,
			modes: this.config.network.modes,
			feeds: this.config.network.feeds.map((feed) => ({
				id: feed.id,
				timeZone: this.config.feedTimeZones.get(feed.id) ?? null,
				capabilities: feedCapabilities(feed.id),
			})),
			capabilities: Array.from(new Set(this.config.network.plugins.flatMap((plugin) => plugin.capabilities))),
			places: this.config.places.map((place) => ({
				...place,
				members: place.members.map((member) => ({ ...member })),
			})),
		};
	}

	public getPlaces = () =>
		this.config.places.map((place) => ({
			...place,
			members: place.members.map((member) => ({ ...member })),
		}));
	public getPlaceForStation = (station: QualifiedEntityId) => {
		const place = getPlaceForStation(this.config, station);
		return place ? { ...place, members: place.members.map((member) => ({ ...member })) } : null;
	};
	public getAgencies = () => this.gtfs?.getAgencies() ?? [];
	public getSourceHealth = (): SourceHealth[] => Array.from(this.sourceHealth.values(), (source) => ({ ...source }));
	public getConsistDetails = async (instanceId: string): Promise<VehicleFormation | null> => {
		const trip = this.getAugmentedTripInstance(instanceId);
		if (!trip) return null;
		const formationPlugin = this.config.network.plugins.find(
			(candidate) => candidate.feedIds.includes(trip.feed_id) && candidate.vehicleFormation,
		);
		if (formationPlugin?.vehicleFormation) {
			const formation = await formationPlugin.vehicleFormation(trip, this.ctx);
			return formation ?? createVehicleFormation(trip);
		}
		const plugin = this.config.network.plugins.find(
			(candidate) => candidate.feedIds.includes(trip.feed_id) && candidate.vehicleFormationUnits,
		);
		const units = plugin?.vehicleFormationUnits ? await plugin.vehicleFormationUnits(trip, this.ctx) : null;
		return createVehicleFormation(trip, units);
	};

	public getPluginApi<T>(pluginId: string): T | null {
		const plugin = this.config.network.plugins.find((candidate) => candidate.id === pluginId);
		return (plugin?.api?.(this.ctx) as T | undefined) ?? null;
	}

	/** AU/SEQ inferred diagram (prev/next trip, synthetic block id). Null if not SEQ or cache not built. */
	public getSeqDiagramSummary(): { tripEnds: number; withPrevLink: number; blockCount: number } | null {
		const d = this.ctx.augmented.seqDiagram;
		if (!d) return null;
		return {
			tripEnds: d.tripCount,
			withPrevLink: d.linkedPrevCount,
			blockCount: new Set(d.blockIdByTripId.values()).size,
		};
	}

	public getAugmentedTrips = (trip?: QualifiedEntityId) => cache.getAugmentedTrips(this.ctx, trip);
	public getAugmentedTripInstance = (instance_id: string) => cache.getAugmentedTripInstance(this.ctx, instance_id);
	public getVehicleTripInstance = (vehicle: RealtimeVehiclePosition) =>
		cache.getVehicleTripInstance(this.ctx, vehicle);
	public getAugmentedStops = (stop?: QualifiedEntityId) => cache.getAugmentedStops(this.ctx, stop);
	public getAugmentedStopTimes = (trip?: QualifiedEntityId) => cache.getAugmentedStopTimes(this.ctx, trip);
	public getAugmentedRawStopTimePage = (options: {
		offset: number;
		limit: number;
		predicate?: (value: StopTime | null) => boolean;
	}) => cache.getAugmentedRawStopTimePage(this.ctx, options);
	public getBaseStopTimes = (trip: QualifiedEntityId) => cache.getBaseStopTimes(this.ctx, trip);
	public getStations = () => stations.getAugmentedRailStations(this.ctx);
	public getRawTrips = (filter?: Partial<Trip>) => cache.getRawTrips(this.ctx, filter);
	public getRawStops = (filter?: Partial<Stop>) => cache.getRawStops(this.ctx, filter);
	public getRawRoutes = (filter?: Partial<Route>) => cache.getRawRoutes(this.ctx, filter);
	public getRawCalendars = () => cache.getRawCalendars(this.ctx);
	public getRawCalendarDates = () => cache.getRawCalendarDates(this.ctx);
	public getStopTimeUpdates = (trip: QualifiedEntityId) => cache.getStopTimeUpdates(this.ctx, trip);
	public getTripUpdates = (trip?: QualifiedEntityId) => cache.getTripUpdates(this.ctx, trip);
	public getVehiclePositions = (trip?: QualifiedEntityId) => cache.getVehiclePositions(this.ctx, trip);
	public getShapes = () => cache.getShapes(this.ctx);
	public getTripIdsByServiceDate = (date: string) => cache.getTripIdsByServiceDate(this.ctx, date);
	public getTripIdsByStop = (stop: QualifiedEntityId) =>
		this.ctx.augmented.tripsStoppingAt.get(entityKey(stop)) ?? new Set<string>();
	public getTripIdsByCar = (car_id: string) => this.ctx.augmented.carTrips.get(car_id) ?? new Set<string>();
	public getTripIdsByNumber = (tripNumber: string) =>
		this.ctx.augmented.tripNumberTrips.get(tripNumber) ?? new Set<string>();
	public getAvailableServiceDates = () => cache.getAvailableServiceDates(this.ctx);
	public getOnboardReachableStops = (instanceId: string, origin: ReachabilityOrigin) =>
		getOnboardReachableStops(this.ctx, instanceId, origin);

	public logTimings = (label: string = "TRAX Operation", clear: boolean = true) =>
		this.ctx.augmented.timer.log(label, clear);

	public on(event: keyof TRAXEvent | string | symbol, listener: (...args: any[]) => void): this {
		this.events.on(event, listener);
		return this;
	}

	public off(event: keyof TRAXEvent | string | symbol, listener: (...args: any[]) => void): this {
		this.events.off(event, listener);
		return this;
	}

	public get utils() {
		return {
			time: timeUtils,
			formatTimestamp: this.formatTimestamp,
			hasGtfs: () => true,
			getGtfs: () => {
				if (!this.gtfs) throw new Error("Tried to access GTFS object before initialization!");
				return this.gtfs;
			},
			getShapes: () => cache.getShapes(this.ctx),
			isConsideredTrip: (trip: Trip) => isConsideredTrip(trip, this.ctx),
			isConsideredRoute: (route: Route) => isConsideredRoute(route, this.ctx),
			isNonRevenueRoute: (route: Route) => isNonRevenueRoute(route, this.ctx),
			isConsideredTripId: (trip: import("qdf-gtfs").QualifiedEntityId) => isConsideredTripId(trip, this.ctx),
			isConsideredStop: (stop: AugmentedStop | Stop) => isConsideredStop(stop, this.ctx),
			isConsideredStopId: (stop: import("qdf-gtfs").QualifiedEntityId) => isConsideredStopId(stop, this.ctx),
			departures: {
				attachDeparturesHelpers: (stop: any) => attachDeparturesHelpers(stop, this.ctx),
				getDeparturesForStop: (stop: any, date: string, st: string, et: string) =>
					getDeparturesForStop(stop, date, st, et, this.ctx),
				getServiceDateDeparturesForStop: (stop: any, date: string, st: number, et: number) =>
					getServiceDateDeparturesForStop(stop, date, st, et, this.ctx),
				getDeparturesForInstantWindow: (stop: any, startEpochSeconds: number, endEpochSeconds: number) =>
					getDeparturesForInstantWindow(stop, startEpochSeconds, endEpochSeconds, this.ctx),
			},
		};
	}

	public get express() {
		return {
			findExpressString: (expressData: any, stop: QualifiedEntityId | null = null) =>
				findExpressString(expressData, this.ctx, stop),
		};
	}
}

export default TRAX;

export { logger };

export { AnyTripPlatformClient } from "./region-specific/AU/VIC/anytrip.js";
export type {
	AnyTripPlatformCall,
	AnyTripPlatformClientDiagnostics,
	AnyTripPlatformClientOptions,
} from "./region-specific/AU/VIC/anytrip.js";
export {
	resolveConfig,
	resolveTripNumber,
	type FeedDefinition,
	type FeedSource,
	type NetworkDefinition,
	type PlaceDefinition,
	type SameStationIdPlacesDefinition,
	type RealtimeSource,
	type RuntimeOptions,
	type TraxConfig,
	type TripNumberResolver,
} from "./config.js";
export { NetworkRuntimeRegistry } from "./registry.js";
export {
	AU_SEQ_NETWORK,
	CA_VIA_NETWORK,
	createAuRailNetwork,
	createAuVicVlineNetwork,
	createCaGthaNetwork,
} from "./networks.js";
export type { AuRailNetworkOptions, AuVicVlineNetworkOptions } from "./networks.js";
export { createTfnswRegionalBookingPlugin, parseTfnswTripId } from "./plugins/tfnsw-rail.js";
export type { TfnswRailPluginOptions, TfnswSetType, TfnswTripDescriptor } from "./plugins/tfnsw-rail.js";
export {
	AnyTripNswOccupancyClient,
	applyAnyTripNswOccupancy,
	parseAnyTripNswOccupancy,
} from "./region-specific/AU/NSW/anytrip-occupancy.js";
export type {
	AnyTripNswOccupancyCall,
	AnyTripNswOccupancyClientOptions,
} from "./region-specific/AU/NSW/anytrip-occupancy.js";
export * from "./identity.js";
export * as cache from "./cache/index.js";
export * as stations from "./utils/stations.js";
export { isRailLikeRouteType } from "./utils/considered.js";
export * as calendar from "./utils/calendar.js";
export * as qrTravel from "./region-specific/AU/SEQ/qr-travel/qr-travel-tracker.js";

export {
	buildSeqDiagramTopology,
	buildAndApplySeqDiagram,
	patchSeqDiagramOntoAugmentedTrip,
	revalidateSeqDiagramRealtimeEdges,
	SEQ_DIAGRAM_MIN_TURNAROUND_SEC,
	type SeqDiagramTopology,
} from "./region-specific/AU/SEQ/seq-diagram.js";

export type { AugmentedTrip, AugmentedTripInstance } from "./utils/augmentedTrip.js";
export type {
	OnboardReachableStop,
	PassengerContinuationSource,
	ReachabilityOrigin,
} from "./utils/passengerContinuations.js";
export type {
	VehicleBookingAvailability,
	VehicleBookingFareClass,
	VehicleFormation,
	VehicleFormationMetadata,
	VehicleFormationUnit,
	VehiclePublishedProfile,
	VehiclePublishedSection,
	VehicleDiagramKind,
	VehicleInfo,
} from "./utils/vehicleModel.js";
export type {
	AugmentedStopTime,
	BoardingLocation,
	BoardingLocationKind,
	OccupancyObservation,
} from "./utils/augmentedStopTime.js";
export type {
	Observation,
	ObservationConfidence,
	VLineDiagnostics,
	VLinePlatformObservation,
	VLineBookingAvailability,
	VLineJourneyPlannerLocation,
	VLineScsServiceObservation,
	VLinePluginOptions,
	VLineSourceStatus,
	VLineTripDetails,
} from "./region-specific/AU/VIC/types.js";
export {
	normalizeVLineUnit,
	ptvVehicleDescriptorConsist,
	vlinePassengerCars,
	vlineTdn,
	vlineVehicleModel,
} from "./region-specific/AU/VIC/identifiers.js";
export {
	getTfnswRegionalBookingFormation,
	parseTfnswRegionalSearchResponse,
	type TfnswRegionalBookingOptions,
} from "./region-specific/AU/NSW/regional-booking.js";
export {
	parseVLineBookingPage,
	parseVLineJourneys,
	parseVLineLocations,
	parseVLinePlatformArrivals,
	parseVLinePlatformServices,
	vlineAccessToken,
} from "./region-specific/AU/VIC/journey-planner.js";
export { parseVLineScsBoard } from "./region-specific/AU/VIC/scs-board.js";
export type { AugmentedStop } from "./utils/augmentedStop.js";
export type {
	CorridorConfidence,
	CorridorEvidence,
	CorridorGapResolution,
	CorridorGeometryConfig,
	CorridorNode,
	CorridorResolution,
	CorridorResolutionConfig,
	CorridorResolutionOverrides,
	GeometrySourceConfig,
	JourneyAnchor,
	JourneyContext,
	ManualCorridor,
	ManualCorridorEdge,
	ManualCorridorNode,
	ManualNetwork,
	RoutePattern,
	StationGeometry,
	StationGeometryCoordinate,
	StationProjection,
} from "./utils/corridor/types.js";
export { createJourneyContext, expressInfoFromCorridor, resolveJourneyCorridor } from "./utils/corridor/resolver.js";
export { findExpressForJourney } from "./utils/SRT.js";
export { buildCorridorIndex } from "./utils/corridor/shapeIndex.js";
export { qualifiedRouteDirectionKey } from "./utils/corridor/keys.js";
export { describeCorridorResolution, compareLegacyCorridor } from "./utils/corridor/diagnostics.js";
export {
	attachDeparturesHelpers,
	getDeparturesForInstantWindow,
	getDeparturesForStop,
	getServiceDateDeparturesForStop,
} from "./utils/departures.js";

export type {
	QRTTrainMovementDTO,
	QRTServiceDisruption,
	QRTGetServiceResponse,
	QRTPlace,
	QRTStationDetails,
	QRTStationFacility,
	QRTStations,
	QRTService,
	QRTDirection,
	QRTServiceLine,
	QRTAllServicesResponse,
	QRTServiceUpdate,
	QRTTravelStopTime,
	QRTTravelTrip,
} from "./region-specific/AU/SEQ/qr-travel/types.js";

export type { QRTSRTStop } from "./region-specific/AU/SEQ/qr-travel/srt.js";
export type {
	QrtBookingSeatMap,
	QrtBookingSeatMapCarriage,
	QrtBookingSeatMapCarriageInformation,
	QrtBookingSeatMapFare,
	QrtBookingSeatMapSeat,
	QrtSeatMapDiagram,
} from "./region-specific/AU/SEQ/qr-travel/seat-map.js";
export { Logger as TraxLogger, LogLevel } from "./utils/logger.js";

export type {
	CarriageLayoutRes,
	CarriageLayout,
	Carriage,
	CarriageSeat,
	SeatProperty,
	CarriageProducts,
	CarriageSegment,
} from "./region-specific/CA/VIA/consist.js";

export {
	DEFAULT_RESOLVER_CONFIG,
	QRT_WIFI_RESOLVER_VERSION,
	haversineM,
	normalizeNasid,
	resolveVehicleObservation,
} from "./qrtWifiResolver.js";
export type {
	ResolverConfig,
	VehicleObservation,
	VehicleObservationCandidate,
	VehicleObservationResolution,
	ResolveOptions,
} from "./qrtWifiResolver.js";
