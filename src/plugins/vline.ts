import type { TransitPlugin } from "./types.js";
import { getVLineState, VLINE_PLUGIN_ID } from "../region-specific/AU/VIC/state.js";
import {
	applyVLineEnrichment,
	refreshVLineOfficialSources,
	vlineDetails,
	vlineVehicleInfoForTrip,
} from "../region-specific/AU/VIC/enrichment.js";
import type { VLinePluginOptions } from "../region-specific/AU/VIC/types.js";

export function createVLinePlugin(options: VLinePluginOptions = {}): TransitPlugin {
	return {
		id: VLINE_PLUGIN_ID,
		feedIds: ["vic-vline"],
		capabilities: ["vehicles", "occupancy", "consist", "platform-changes", "boarding-locations", "supplemental-realtime"],
		beforeRealtime: (ctx) => refreshVLineOfficialSources(ctx, options),
		afterRealtime: (ctx) => applyVLineEnrichment(ctx, options),
		vehicleInfoForTrip: vlineVehicleInfoForTrip,
		consistDetails: (trip, ctx) => vlineDetails(ctx, trip),
		api: (ctx) => ({
			getTripDetails: (instanceId: string) => {
				const trip = ctx.augmented.instancesRec.get(instanceId);
				return trip ? vlineDetails(ctx, trip) : null;
			},
			getSourceStatus: () => structuredClone(getVLineState(ctx).sources),
		}),
	};
}

