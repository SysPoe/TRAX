import type { TransitPlugin } from "./types.js";
import { applyPtvMetroVehicles, ptvMetroVehicleInfoForTrip } from "../region-specific/AU/VIC/ptv-metro.js";

export const ptvMetroPlugin: TransitPlugin = {
	id: "au-vic-ptv-metro",
	feedIds: ["vic-metro"],
	capabilities: ["vehicles", "consist"],
	afterRealtime: applyPtvMetroVehicles,
	vehicleInfoForTrip: (trip, ctx) => ptvMetroVehicleInfoForTrip(trip.instance_id, ctx),
};
