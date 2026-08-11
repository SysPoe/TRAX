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
	consistDetails: (trip, ctx) => getViaConsist(trip.instance_id, ctx),
	api: (ctx) => ({ getConsist: (instanceId: string) => getViaConsist(instanceId, ctx) }),
};
