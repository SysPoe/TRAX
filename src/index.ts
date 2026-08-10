import * as cache from "./cache/index.js";
import * as stations from "./utils/stations.js";
import * as qrTravel from "./region-specific/AU/SEQ/qr-travel/qr-travel-tracker.js";
import * as timeUtils from "./utils/time.js";
import { EventEmitter } from "events";
import { GTFS, RealtimeVehiclePosition, Route, Stop, Trip } from "qdf-gtfs";
import type { QualifiedEntityId } from "qdf-gtfs";
import logger from "./utils/logger.js";
import { findExpressString } from "./utils/SRT.js";
import { attachDeparturesHelpers, getDeparturesForStop, getServiceDateDeparturesForStop } from "./utils/departures.js";
import {
	isConsideredRoute,
	isConsideredStop,
	isConsideredStopId,
	isConsideredTrip,
	isConsideredTripId,
} from "./utils/considered.js";
import { AugmentedStop } from "./utils/augmentedStop.js";
import { getFeedTimeZone, type NetworkDefinition, type RuntimeOptions, type TraxConfig, resolveConfig } from "./config.js";
import { createGtfs, loadRealtime, loadStatic } from "./gtfsInterfaceLayer.js";
import { entityKey } from "./identity.js";

export interface TRAXEvent {
	"realtime-update-start": [];
	"realtime-update-end": [];
	"static-update-start": [];
	"static-update-end": [];
}

export class TRAX {
	public config: TraxConfig;
	public gtfs?: GTFS;
	public events: EventEmitter;

	private ctx: cache.CacheContext;
	private realtimeInterval: NodeJS.Timeout | null = null;
	private staticInterval: NodeJS.Timeout | null = null;
	private staticRefreshInFlight: Promise<void> | null = null;
	private realtimeRefreshInFlight: Promise<void> | null = null;

	constructor(network: NetworkDefinition, options: RuntimeOptions = {}) {
		this.config = resolveConfig(network, options);
		this.events = new EventEmitter();

		this.ctx = {
			raw: cache.createEmptyRawCache(),
			augmented: cache.createAugmentedCacheWithConfig(this.config),
			config: this.config,
			pluginState: new Map(),
			runtimeState: cache.createRuntimeState(),
		};
	}

	public async loadGTFS(
		loadRealtime: boolean = true,
		autoRefresh: boolean = false,
		realtimeIntervalMs: number = 60 * 1000,
		staticIntervalMs: number = 24 * 60 * 60 * 1000,
	): Promise<void> {
		if (!this.gtfs) {
			await this.ensureGtfs(loadRealtime);
		} else {
			await this.refreshStatic();
			if (loadRealtime) await this.refreshRealtime();
		}

		if (!autoRefresh) return;

		const scheduleNextRealtime = () => {
			this.realtimeInterval = setTimeout(async () => {
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
			this.staticInterval = setTimeout(async () => {
				this.events.emit("static-update-start");
				try {
					await this.refreshStatic();
					await this.updateRealtime();
				} catch (error: any) {
					logger.error("Error refreshing static GTFS data: " + (error.message ?? error), {
						module: "index",
						function: "loadGTFS - scheduleNextStatic",
					});
				} finally {
					this.events.emit("static-update-end");
					scheduleNextStatic();
				}
			}, staticIntervalMs);
		};

		if (this.config.network.feeds.some((feed) => feed.realtimeSources.length > 0) && loadRealtime) scheduleNextRealtime();
		scheduleNextStatic();
	}

	/**
	 * Ensures GTFS is initialized and initial caches are built.
	 * If GTFS is already initialized, this does nothing.
	 */
	private async ensureGtfs(loadRealtime: boolean = true): Promise<GTFS> {
		if (this.gtfs) return this.gtfs;

		const gtfs = await createGtfs(this.config, loadRealtime);
		this.validateFeedTimeZones(gtfs);
		this.ctx.augmented.timer.start("TRAX:initialCacheRefresh");
		const nextCtx = await cache.refreshStaticCache(gtfs, this.config);
		if (loadRealtime) await cache.refreshRealtimeCache(gtfs, this.config, nextCtx);
		nextCtx.augmented.timer.stop("TRAX:initialCacheRefresh");
		this.gtfs = gtfs;
		this.ctx = nextCtx;

		return this.gtfs;
	}

	/**
	 * Refreshes static GTFS data from source and rebuilds the static cache.
	 */
	public async refreshStatic(): Promise<void> {
		if (this.staticRefreshInFlight) return this.staticRefreshInFlight;
		this.staticRefreshInFlight = (async () => {
			await this.ensureGtfs();
			const nextGtfs = await createGtfs(this.config, false);
			this.validateFeedTimeZones(nextGtfs);
			const nextCtx = await cache.refreshStaticCache(nextGtfs, this.config, this.ctx);
			// Readers use the prior immutable snapshot until both objects are ready.
			this.gtfs = nextGtfs;
			this.ctx = nextCtx;
		})().finally(() => {
			this.staticRefreshInFlight = null;
		});
		return this.staticRefreshInFlight;
	}

	/**
	 * Refreshes realtime GTFS data from source and rebuilds the realtime cache.
	 */
	public async refreshRealtime(): Promise<void> {
		if (this.realtimeRefreshInFlight) return this.realtimeRefreshInFlight;
		this.realtimeRefreshInFlight = (async () => {
			const gtfs = await this.ensureGtfs();
			if (!this.config.network.feeds.some((feed) => feed.realtimeSources.length > 0)) return;
			this.ctx.augmented.timer.start("refreshRealtime");
			await loadRealtime(gtfs, this.config);
			for (const plugin of this.config.network.plugins) await plugin.beforeRealtime?.(this.ctx);
			await cache.refreshRealtimeCache(gtfs, this.config, this.ctx);
			this.ctx.augmented.timer.stop("refreshRealtime");
		})().finally(() => {
			this.realtimeRefreshInFlight = null;
		});
		return this.realtimeRefreshInFlight;
	}

	public async updateRealtime(): Promise<void> {
		if (!this.config.network.feeds.some((feed) => feed.realtimeSources.length > 0)) return;
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
				gtfs.getAgencies({ feed_id: feed.id }).map((agency) => agency.agency_timezone).filter(Boolean),
			);
			if (feed.timeZone) {
				next.set(feed.id, feed.timeZone);
				continue;
			}
			if (agencyZones.size !== 1) {
				throw new Error(`Feed '${feed.id}' must declare exactly one agency_timezone; found ${Array.from(agencyZones).join(", ") || "none"}`);
			}
			next.set(feed.id, Array.from(agencyZones)[0]);
		}
		this.config.feedTimeZones = next;
	}

	public get metadata() {
		return {
			id: this.config.network.id,
			name: this.config.network.name,
			modes: this.config.network.modes,
			feeds: this.config.network.feeds.map((feed) => ({ id: feed.id, timeZone: this.config.feedTimeZones.get(feed.id) ?? null })),
			capabilities: Array.from(new Set(this.config.network.plugins.flatMap((plugin) => plugin.capabilities))),
		};
	}

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
	public getTripIdsByServiceDate = (date: string) => this.ctx.augmented.serviceDateTrips.get(date) ?? [];
	public getTripIdsByStop = (stop: QualifiedEntityId) => this.ctx.augmented.tripsStoppingAt.get(entityKey(stop)) ?? new Set<string>();
	public getTripIdsByCar = (car_id: string) => this.ctx.augmented.carTrips.get(car_id) ?? new Set<string>();
	public getAvailableServiceDates = () => Array.from(this.ctx.augmented.serviceDateTrips.keys());

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
			isConsideredTripId: (trip: import("qdf-gtfs").QualifiedEntityId) => isConsideredTripId(trip, this.ctx),
			isConsideredStop: (stop: AugmentedStop | Stop) => isConsideredStop(stop, this.ctx),
			isConsideredStopId: (stop: import("qdf-gtfs").QualifiedEntityId) => isConsideredStopId(stop, this.ctx),
			departures: {
				attachDeparturesHelpers: (stop: any) => attachDeparturesHelpers(stop, this.ctx),
				getDeparturesForStop: (stop: any, date: string, st: string, et: string) =>
					getDeparturesForStop(stop, date, st, et, this.ctx),
				getServiceDateDeparturesForStop: (stop: any, date: string, st: number, et: number) =>
					getServiceDateDeparturesForStop(stop, date, st, et, this.ctx),
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

export { resolveConfig, type FeedDefinition, type FeedSource, type NetworkDefinition, type RealtimeSource, type RuntimeOptions, type TraxConfig } from "./config.js";
export { NetworkRuntimeRegistry } from "./registry.js";
export { AU_SEQ_NETWORK, CA_VIA_NETWORK, createCaGthaNetwork } from "./networks.js";
export * from "./identity.js";
export * as cache from "./cache/index.js";
export * as stations from "./utils/stations.js";
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
export type { AugmentedStopTime } from "./utils/augmentedStopTime.js";
export type { AugmentedStop } from "./utils/augmentedStop.js";
export { attachDeparturesHelpers, getDeparturesForStop, getServiceDateDeparturesForStop } from "./utils/departures.js";

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
