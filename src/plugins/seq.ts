import type { TransitPlugin } from "./types.js";
import { loadSEQStaticMetadata, refreshQRTTrainsInBackground } from "../cache/refreshCaches.js";
import { ensureServiceCapacityData } from "../region-specific/AU/SEQ/serviceCapacity.js";
import { buildAndApplySeqDiagram, refreshSeqDiagramAfterRealtimeBatch } from "../region-specific/AU/SEQ/seq-diagram.js";
import {
	SEQgetQRTPlaces,
	SEQgetQRTStations,
	SEQgetQRTTrains,
	SEQgetRailwayStationFacilities,
} from "../cache/augmentedEntities.js";
import { enrichSeqStop, type AugmentationContext } from "../utils/augmentedStop.js";
import { getVehicleInfo } from "../region-specific/AU/SEQ/vehicleModel.js";
import { getServiceCapacity } from "../region-specific/AU/SEQ/serviceCapacity.js";
import { getQrtFormation } from "../region-specific/AU/SEQ/qr-travel/formation.js";
import { getQrtBookingSeatMap, getQrtSeatMapDiagram } from "../region-specific/AU/SEQ/qr-travel/seat-map.js";

export const seqPlugin: TransitPlugin = {
	id: "au-seq",
	feedIds: ["translink-seq"],
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
	enrichStop: (stop, ctx, augmentationContext) =>
		enrichSeqStop(stop, ctx, augmentationContext as AugmentationContext | undefined),
	vehicleInfoForTrip: (trip) => getVehicleInfo(trip),
	serviceCapacity: (trip, stopTime, serviceDate, direction, ctx) =>
		getServiceCapacity(trip, stopTime, serviceDate, direction, ctx),
	api: (ctx) => ({
		getQrtPlaces: () => SEQgetQRTPlaces(ctx),
		getQrtStations: () => SEQgetQRTStations(ctx),
		getQrtTrains: () => SEQgetQRTTrains(ctx),
		getQrtFormation: (serviceId: string) => {
			const service = SEQgetQRTTrains(ctx).find((candidate) => candidate.serviceId === serviceId);
			return service ? getQrtFormation(service, ctx) : Promise.resolve(null);
		},
		getQrtSeatMap: (serviceId: string) => {
			const service = SEQgetQRTTrains(ctx).find((candidate) => candidate.serviceId === serviceId);
			return service ? getQrtBookingSeatMap(service, ctx) : Promise.resolve(null);
		},
		getQrtSeatMapDiagram: (imageHash: string) => getQrtSeatMapDiagram(ctx, imageHash),
		getRailwayStationFacilities: () => SEQgetRailwayStationFacilities(ctx),
	}),
};
