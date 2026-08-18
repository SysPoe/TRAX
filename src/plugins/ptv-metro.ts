import type { TransitPlugin } from "./types.js";
import {
	applyPtvMetroVehicles,
	ptvMetroFormationUnit,
	ptvMetroVehicleInfoForTrip,
} from "../region-specific/AU/VIC/ptv-metro.js";

export const ptvMetroPlugin: TransitPlugin = {
	id: "au-vic-ptv-metro",
	feedIds: ["vic-metro"],
	capabilities: ["vehicles", "consist"],
	considerRoute: (route) =>
		![route.route_short_name, route.route_long_name].some((name) => /\breplacement bus\b/i.test(name ?? "")),
	afterRealtime: applyPtvMetroVehicles,
	vehicleInfoForTrip: (trip, ctx) => ptvMetroVehicleInfoForTrip(trip.instance_id, ctx),
	vehicleFormationUnits: (trip) => trip.consist?.map(ptvMetroFormationUnit) ?? null,
};
