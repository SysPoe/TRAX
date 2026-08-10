import type { TransitPlugin } from "./types.js";
import { VIA_MERGE_STOPS, VIA_UPDATE_STOPS, updateRealtime } from "../region-specific/CA/VIA/realtime.js";
import { getViaConsist } from "../region-specific/CA/VIA/consist.js";

export const viaPlugin: TransitPlugin = {
	id: "ca-via",
	capabilities: ["consist", "supplemental-realtime"],
	afterStaticLoad(ctx) {
		if (!ctx.gtfs) return;
		for (const action of VIA_MERGE_STOPS) ctx.gtfs.actions.mergeStops(action.to, action.from, action.feedId);
		for (const action of VIA_UPDATE_STOPS) ctx.gtfs.actions.updateStop(action.stop_id, action.new, "via");
	},
	beforeRealtime: updateRealtime,
	api: (ctx) => ({ getConsist: (instanceId: string) => getViaConsist(instanceId, ctx) }),
};
