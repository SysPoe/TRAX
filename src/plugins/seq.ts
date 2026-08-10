import type { TransitPlugin } from "./types.js";
import { loadSEQStaticMetadata, refreshQRTTrainsInBackground } from "../cache/refreshCaches.js";
import { ensureServiceCapacityData } from "../region-specific/AU/SEQ/serviceCapacity.js";
import { buildAndApplySeqDiagram, refreshSeqDiagramAfterRealtimeBatch } from "../region-specific/AU/SEQ/seq-diagram.js";
import { SEQgetQRTPlaces, SEQgetQRTStations, SEQgetQRTTrains, SEQgetRailwayStationFacilities } from "../cache/augmentedEntities.js";
import { enrichSeqStop, type AugmentationContext } from "../utils/augmentedStop.js";
import { getVehicleInfo } from "../region-specific/AU/SEQ/vehicleModel.js";
import { getServiceCapacity } from "../region-specific/AU/SEQ/serviceCapacity.js";

export const seqPlugin: TransitPlugin = {
	id: "au-seq",
	capabilities: ["vehicles", "occupancy", "platform-changes", "facilities", "supplemental-realtime"],
	async afterStaticLoad(ctx) {
		await Promise.all([loadSEQStaticMetadata(ctx), ensureServiceCapacityData(ctx)]);
	},
	afterSnapshotBuilt(ctx) {
		if (ctx.gtfs) buildAndApplySeqDiagram(ctx, ctx.gtfs, Array.from(ctx.augmented.rawTripsRec.values()));
	},
	afterRealtime(ctx, changedTripKeys) {
		refreshQRTTrainsInBackground(ctx);
		refreshSeqDiagramAfterRealtimeBatch(ctx, new Set(changedTripKeys));
	},
	enrichStop: (stop, ctx, augmentationContext) => enrichSeqStop(stop, ctx, augmentationContext as AugmentationContext | undefined),
	vehicleInfoForTrip: (trip) => getVehicleInfo(trip),
	serviceCapacity: (trip, stopTime, serviceDate, direction, ctx) => getServiceCapacity(trip, stopTime, serviceDate, direction, ctx),
	api: (ctx) => ({
		getQrtPlaces: () => SEQgetQRTPlaces(ctx),
		getQrtStations: () => SEQgetQRTStations(ctx),
		getQrtTrains: () => SEQgetQRTTrains(ctx),
		getRailwayStationFacilities: () => SEQgetRailwayStationFacilities(ctx),
	}),
};
