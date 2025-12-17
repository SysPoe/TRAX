import * as cache from "./cache.js";
import * as calendar from "./utils/calendar.js";
import * as stations from "./utils/stations.js";
import * as qrTravel from "./region-specific/SEQ/qr-travel/qr-travel-tracker.js";
import * as timeUtils from "./utils/time.js";
import { EventEmitter } from "events";
import { GTFS } from "qdf-gtfs";
import logger from "./utils/logger.js";
import { TraxConfig, TraxConfigOptions, resolveConfig } from "./config.js";
import { findExpressString } from "./utils/SRT.js";
import { getServiceCapacity } from "./utils/serviceCapacity.js";
import { attachDeparturesHelpers, getDeparturesForStop, getServiceDateDeparturesForStop } from "./utils/departures.js";

export interface TRAXEvent {
	"realtime-update-start": [];
	"realtime-update-end": [];
	"static-update-start": [];
	"static-update-end": [];
}

export class TRAX {
	public config: TraxConfig;
	public gtfs: GTFS;
	public events: EventEmitter;

	private ctx: cache.CacheContext;
	private realtimeInterval: NodeJS.Timeout | null = null;
	private staticInterval: NodeJS.Timeout | null = null;

	constructor(options: TraxConfigOptions = {}) {
		this.config = resolveConfig(options);
		this.events = new EventEmitter();

		this.gtfs = new GTFS({
			ansi: false,
			logger: this.config.logFunction,
			progress: this.config.progressLog,
			cache: true,
			cacheDir: this.config.cacheDir,
		});

		this.ctx = {
			raw: cache.createEmptyRawCache(),
			augmented: cache.createEmptyAugmentedCache(),
			config: this.config,
			gtfs: this.gtfs,
		};
	}

	public async loadGTFS(
		autoRefresh: boolean = false,
		realtimeIntervalMs: number = 60 * 1000,
		staticIntervalMs: number = 24 * 60 * 60 * 1000,
	): Promise<void> {
		await this.loadStaticInternal();
		await this.loadRealtimeInternal();

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
					await this.loadStaticInternal();
					await this.updateRealtime();
				} catch (error: any) {
					logger.error("Error refreshing static GTFS data", {
						module: "index",
						function: "loadGTFS - scheduleNextStatic",
						error: error.message ?? error,
					});
				} finally {
					this.events.emit("static-update-end");
					scheduleNextStatic();
				}
			}, staticIntervalMs);
		};

		if (this.config.realtime != null) scheduleNextRealtime();
		scheduleNextStatic();
	}

	private async loadStaticInternal() {
		logger.info("Loading GTFS data...");
		await this.gtfs.loadFromUrl(this.config.url);
		logger.info("GTFS data loaded.");

		this.ctx = await cache.refreshStaticCache(this.gtfs, this.config);
	}

	private async loadRealtimeInternal() {
		if (!this.config.realtime) return;

		const rt = this.config.realtime;
		const getUrl = (v: any) => (typeof v === "string" ? v : v?.url);

		await this.gtfs.updateRealtimeFromUrl(
			getUrl(rt.realtimeAlerts),
			getUrl(rt.realtimeTripUpdates),
			getUrl(rt.realtimeVehiclePositions),
		);

		await cache.refreshRealtimeCache(this.gtfs, this.config, this.ctx);
	}

	public async updateRealtime(): Promise<void> {
		if (this.config.realtime == null) return;
		try {
			await this.loadRealtimeInternal();
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
		return new Date(Date.now() + 3600 * 10 * 1000).toISOString().slice(0, 10).replace(/-/g, "");
	}

	public getAugmentedTrips = (trip_id?: string) => cache.getAugmentedTrips(trip_id, this.ctx);
	public getAugmentedTripInstance = (instance_id: string) => cache.getAugmentedTripInstance(instance_id, this.ctx);
	public getAugmentedStops = (stop_id?: string) => cache.getAugmentedStops(stop_id, this.ctx);
	public getAugmentedStopTimes = (trip_id?: string) => cache.getAugmentedStopTimes(trip_id, this.ctx);
	public getBaseStopTimes = (trip_id: string) => cache.getBaseStopTimes(trip_id, this.ctx);
	public getRunSeries = (date: string, runSeries: string, calcIfNotFound: boolean = true) =>
		cache.getRunSeries(date, runSeries, calcIfNotFound, this.ctx);
	public getStations = () => stations.getAugmentedRailStations(this.ctx);
	public getRawTrips = (trip_id?: string) => cache.getRawTrips(trip_id, this.ctx);
	public getRawStops = (stop_id?: string) => cache.getRawStops(stop_id, this.ctx);
	public getRawRoutes = (route_id?: string) => cache.getRawRoutes(route_id, this.ctx);
	public getRawCalendars = () => cache.getRawCalendars(this.ctx);
	public getRawCalendarDates = () => cache.getRawCalendarDates(this.ctx);
	public getStopTimeUpdates = (trip_id: string) => cache.getStopTimeUpdates(trip_id, this.ctx);
	public getTripUpdates = (trip_id?: string) => cache.getTripUpdates(trip_id, this.ctx);
	public getVehiclePositions = (trip_id?: string) => cache.getVehiclePositions(trip_id, this.ctx);

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
			getGtfs: () => this.gtfs,
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
			findExpressString: (expressData: any, stop_id: string | null = null) =>
				findExpressString(expressData, this.ctx, stop_id),
		};
	}

	public get regionSpecific() {
		return {
			SEQ: {
				getQRTPlaces: () => cache.SEQgetQRTPlaces(this.ctx),
				getQRTTrains: () => cache.SEQgetQRTTrains(this.ctx),
				qrTravel,
			},
		};
	}
}

export default TRAX;

export { resolveConfig, TraxConfig, TraxConfigOptions } from "./config.js";
export * as cache from "./cache.js";
export * as stations from "./utils/stations.js";
export * as calendar from "./utils/calendar.js";
export * as qrTravel from "./region-specific/SEQ/qr-travel/qr-travel-tracker.js";

export type { AugmentedTrip, RunSeries } from "./utils/augmentedTrip.js";
export type { AugmentedStopTime } from "./utils/augmentedStopTime.js";
export type { AugmentedStop } from "./utils/augmentedStop.js";
export { attachDeparturesHelpers, getDeparturesForStop, getServiceDateDeparturesForStop } from "./utils/departures.js";

export type {
	QRTTrainMovementDTO,
	QRTServiceDisruption,
	QRTGetServiceResponse,
	QRTPlace,
	QRTService,
	QRTDirection,
	QRTServiceLine,
	QRTAllServicesResponse,
	QRTServiceUpdate,
	QRTTravelStopTime,
	QRTTravelTrip,
} from "./region-specific/SEQ/qr-travel/types.js";

export type { QRTSRTStop } from "./region-specific/SEQ/qr-travel/srt.js";
export { Logger as TraxLogger, LogLevel } from "./utils/logger.js";
