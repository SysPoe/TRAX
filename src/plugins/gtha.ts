import type { TransitPlugin } from "./types.js";
import { updateAllSources } from "../region-specific/CA/GTHA/realtime.js";
import { getActiveCars, getActivePassengerCars, getActiveVehicleIds, getActiveVehicleModels } from "../region-specific/CA/GTHA/realtime.js";
import { getVehicleInfo } from "../region-specific/CA/GTHA/vehicleModel.js";

export const gthaPlugin: TransitPlugin = {
	id: "ca-gtha",
	capabilities: ["vehicles", "consist", "platform-changes", "supplemental-realtime"],
	afterRealtime(ctx) {
		if (ctx.gtfs) return updateAllSources(ctx, ctx.gtfs);
	},
	vehicleInfoForTrip: getVehicleInfo,
	filterTrackEdges(edges) { edges.delete("UN|KE"); edges.delete("KE|UN"); },
	enrichTrackGraph(matrix, adjacency) {
		(matrix.KE ??= {}).SC = 2; (matrix.SC ??= {}).KE = 2;
		if (!(adjacency.KE ??= []).includes("SC")) adjacency.KE.push("SC");
		if (!(adjacency.SC ??= []).includes("KE")) adjacency.SC.push("KE");
	},
	api: (ctx) => ({
		getActiveCars: () => getActiveCars(ctx),
		getActivePassengerCars: () => getActivePassengerCars(ctx),
		getActiveVehicleIds: () => getActiveVehicleIds(ctx),
		getActiveVehicleModels: () => getActiveVehicleModels(ctx),
	}),
};
