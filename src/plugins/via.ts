import type { TransitPlugin } from "./types.js";
import { applyCisBoardingLocations, VIA_UPDATE_STOPS, updateRealtime } from "../region-specific/CA/VIA/realtime.js";
import { getViaConsist } from "../region-specific/CA/VIA/consist.js";

export const viaPlugin: TransitPlugin = {
	id: "ca-via",
	feedIds: ["via"],
	capabilities: ["consist", "boarding-locations", "supplemental-realtime"],
	afterStaticLoad(ctx) {
		if (!ctx.gtfs) return;
		for (const action of VIA_UPDATE_STOPS) ctx.gtfs.actions.updateStop(action.stop_id, action.new, "via");
	},
	beforeRealtime: updateRealtime,
	afterRealtime: applyCisBoardingLocations,
	vehicleFormationUnits: async (trip, ctx) => {
		const consist = await getViaConsist(trip.instance_id, ctx);
		return (
			consist?.carriageLayout.carriages.map((carriage) => ({
				id: carriage.carriage_number || carriage.carriage_name || String(carriage.sequence_number),
				type: carriage.carriage_type || null,
				manufacturer: null,
				model: null,
				seats: carriage.seats.length,
				bicycles: null,
				accessible: null,
				wifi: null,
				powerOutlets: null,
				accentColor: null,
			})) ?? null
		);
	},
	api: (ctx) => ({ getConsist: (instanceId: string) => getViaConsist(instanceId, ctx) }),
};
