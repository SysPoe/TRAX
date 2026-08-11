import type { TransitPlugin } from "./types.js";
import { updateAllSources } from "../region-specific/CA/GTHA/realtime.js";
import {
	getActiveCars,
	getActivePassengerCars,
	getActiveVehicleIds,
	getActiveVehicleModels,
	getVehicleConsist,
} from "../region-specific/CA/GTHA/realtime.js";
import { getVehicleInfo } from "../region-specific/CA/GTHA/vehicleModel.js";
import { entityKey } from "../identity.js";
import { getGTHAVehicleDetails, GTHAVehicleDetails } from "../region-specific/CA/GTHA/vehicleDetails.js";

const goStop = (localId: string) => entityKey({ feedId: "go", localId });

export const gthaPlugin: TransitPlugin = {
	id: "ca-gtha",
	feedIds: ["go", "up"],
	capabilities: ["vehicles", "consist", "platform-changes", "supplemental-realtime"],
	afterRealtime(ctx) {
		if (ctx.gtfs) return updateAllSources(ctx, ctx.gtfs);
	},
	vehicleInfoForTrip: getVehicleInfo,
	consistDetails: (trip, ctx) => {
		const consist = trip.consist ?? (trip.vehicle_id ? getVehicleConsist(ctx, trip.vehicle_id) : null);
		return consist?.map((carId) => ({ carId, details: getGTHAVehicleDetails(carId) })) ?? null;
	},
	filterTrackEdges(edges) {
		edges.delete(`${goStop("UN")}|${goStop("KE")}`);
		edges.delete(`${goStop("KE")}|${goStop("UN")}`);
	},
	enrichTrackGraph(matrix, adjacency) {
		const ke = goStop("KE"),
			sc = goStop("SC");
		(matrix[ke] ??= {})[sc] = 2;
		(matrix[sc] ??= {})[ke] = 2;
		if (!(adjacency[ke] ??= []).includes(sc)) adjacency[ke].push(sc);
		if (!(adjacency[sc] ??= []).includes(ke)) adjacency[sc].push(ke);
	},
	api: (ctx) => ({
		getActiveCars: () => getActiveCars(ctx),
		getActivePassengerCars: () => getActivePassengerCars(ctx),
		getActiveVehicleIds: () => getActiveVehicleIds(ctx),
		getActiveVehicleModels: () => getActiveVehicleModels(ctx),
		getVehicleDetails: (vehicleId: string) => getGTHAVehicleDetails(vehicleId),
		getVehicleModels: () =>
			Array.from(new Set(GTHAVehicleDetails.map((vehicle) => vehicle.description.model))).sort(),
	}),
};
