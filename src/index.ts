import * as cache from "./cache.js";
import * as stations from "./utils/stations.js";
import * as qrTravel from "./region-specific/AU/SEQ/qr-travel/qr-travel-tracker.js";
import * as timeUtils from "./utils/time.js";
import { EventEmitter } from "events";
import { GTFS, RealtimeVehiclePosition, Route, Stop, Trip } from "qdf-gtfs";
import logger from "./utils/logger.js";
import { globalTimer } from "./utils/timer.js";
import { findExpressString } from "./utils/SRT.js";
import { getServiceCapacity } from "./utils/serviceCapacity.js";
import { attachDeparturesHelpers, getDeparturesForStop, getServiceDateDeparturesForStop } from "./utils/departures.js";
import {
	isConsideredRoute,
	isConsideredStop,
	isConsideredStopId,
	isConsideredTrip,
	isConsideredTripId,
} from "./utils/considered.js";
import { AugmentedStop } from "./utils/augmentedStop.js";
import { type TraxConfig, type TraxConfigOptions, resolveConfig } from "./config.js";
import * as GTHA from "./region-specific/CA/GTHA/realtime.js";
import {
	GTHAVehicleDetails,
	getGTHAVehicleDetails,
	type GOTransitVehicle,
} from "./region-specific/CA/GTHA/vehicleDetails.js";

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

		if (this.config.realtime != null) scheduleNextRealtime();
		scheduleNextStatic();
	}

	private async loadStaticInternal() {
		globalTimer.start("loadStaticInternal");
		logger.info("Loading GTFS data...");
		globalTimer.start("loadStaticInternal:loadStatic");
		await this.gtfs.loadStatic(this.config.urls);
		globalTimer.stop("loadStaticInternal:loadStatic");
		logger.info("GTFS data loaded.");

		globalTimer.start("loadStaticInternal:refreshStaticCache");
		this.ctx = await cache.refreshStaticCache(this.gtfs, this.config);
		globalTimer.stop("loadStaticInternal:refreshStaticCache");
		globalTimer.stop("loadStaticInternal");
	}

	private async loadRealtimeInternal() {
		if (!this.config.realtime) return;

		const rt = this.config.realtime;

		globalTimer.start("loadRealtimeInternal");
		globalTimer.start("loadRealtimeInternal:updateRealtimeFromUrl");
		await this.gtfs.updateRealtimeFromUrl(rt.realtimeAlerts, rt.realtimeTripUpdates, rt.realtimeVehiclePositions);
		globalTimer.stop("loadRealtimeInternal:updateRealtimeFromUrl");

		globalTimer.start("loadRealtimeInternal:refreshRealtimeCache");
		await cache.refreshRealtimeCache(this.gtfs, this.config, this.ctx);
		globalTimer.stop("loadRealtimeInternal:refreshRealtimeCache");
		globalTimer.stop("loadRealtimeInternal");
	}

	public async updateRealtime(): Promise<void> {
		if (this.config.realtime == null) return;
		globalTimer.start("updateRealtime");
		try {
			await this.loadRealtimeInternal();
		} catch (error: any) {
			logger.error("Error updating realtime GTFS data: " + (error.message ?? error), {
				module: "index",
				function: "updateRealtime",
			});
		} finally {
			globalTimer.stop("updateRealtime");
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
		const offsetMs = timeUtils.getTimezoneOffsetSeconds(this.config.timezone) * 1000;
		return new Date(Date.now() + offsetMs).toISOString().slice(0, 10).replace(/-/g, "");
	}

	public getAugmentedTrips = (trip_id?: string) => cache.getAugmentedTrips(this.ctx, trip_id);
	public getAugmentedTripInstance = (instance_id: string) => cache.getAugmentedTripInstance(this.ctx, instance_id);
	public getVehicleTripInstance = (vehicle: RealtimeVehiclePosition) =>
		cache.getVehicleTripInstance(this.ctx, vehicle);
	public getAugmentedStops = (stop_id?: string) => cache.getAugmentedStops(this.ctx, stop_id);
	public getAugmentedStopTimes = (trip_id?: string) => cache.getAugmentedStopTimes(this.ctx, trip_id);
	public getBaseStopTimes = (trip_id: string) => cache.getBaseStopTimes(this.ctx, trip_id);
	public getRunSeries = (date: string, runSeries: string, calcIfNotFound: boolean = true) =>
		cache.getRunSeries(this.ctx, date, runSeries, calcIfNotFound);
	public getStations = () => stations.getAugmentedRailStations(this.ctx);
	public getRawTrips = (trip_id?: string) => cache.getRawTrips(this.ctx, trip_id);
	public getRawStops = (stop_id?: string) => cache.getRawStops(this.ctx, stop_id);
	public getRawRoutes = (route_id?: string) => cache.getRawRoutes(this.ctx, route_id);
	public getRawCalendars = () => cache.getRawCalendars(this.ctx);
	public getRawCalendarDates = () => cache.getRawCalendarDates(this.ctx);
	public getStopTimeUpdates = (trip_id: string) => cache.getStopTimeUpdates(this.ctx, trip_id);
	public getTripUpdates = (trip_id?: string) => cache.getTripUpdates(this.ctx, trip_id);
	public getVehiclePositions = (trip_id?: string) => cache.getVehiclePositions(this.ctx, trip_id);
	public getShapes = () => cache.getShapes(this.ctx);
	public getTripIdsByServiceDate = (date: string) => this.ctx.augmented.serviceDateTrips.get(date) ?? [];
	public getTripIdsByStop = (stop_id: string) => this.ctx.augmented.tripsStoppingAt.get(stop_id) ?? new Set<string>();
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
			getGtfs: () => this.gtfs,
			getShapes: () => cache.getShapes(this.ctx),
			isConsideredTrip: (trip: Trip) => isConsideredTrip(trip, this.gtfs),
			isConsideredRoute: (route: Route) => isConsideredRoute(route),
			isConsideredTripId: (trip_id: string) => isConsideredTripId(trip_id, this.gtfs),
			isConsideredStop: (stop: AugmentedStop | Stop) => isConsideredStop(stop, this.gtfs),
			isConsideredStopId: (stop_id: string) => isConsideredStopId(stop_id, this.gtfs),
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
			GTHA: {
				getActiveVehicleModels: () => GTHA.getActiveVehicleModels(),
				getActiveVehicleIds: () => GTHA.getActiveVehicleIds(),
				getActivePassengerCars: () => GTHA.getActivePassengerCars(),
				getActiveCars: () => GTHA.getActiveCars(),
				getGTHAVehicleDetails: (vehicleId: string) => getGTHAVehicleDetails(vehicleId),
				getGTHAVehicleDetailsRegistry: () => GTHAVehicleDetails,
			},
		};
	}
}

export default TRAX;

export { logger };

export { PRESETS, resolveConfig, type TraxConfig, type TraxConfigOptions } from "./config.js";
export * as cache from "./cache.js";
export * as stations from "./utils/stations.js";
export * as calendar from "./utils/calendar.js";
export * as qrTravel from "./region-specific/AU/SEQ/qr-travel/qr-travel-tracker.js";

export type { AugmentedTrip, AugmentedTripInstance, RunSeries } from "./utils/augmentedTrip.js";
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
} from "./region-specific/AU/SEQ/qr-travel/types.js";

export type GTHAActiveVehicle = GOTransitVehicle;

export type { QRTSRTStop } from "./region-specific/AU/SEQ/qr-travel/srt.js";
export { Logger as TraxLogger, LogLevel } from "./utils/logger.js";
