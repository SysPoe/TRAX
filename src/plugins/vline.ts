import type { TransitPlugin } from "./types.js";
import { getVLineDiagnostics, getVLineState, VLINE_PLUGIN_ID } from "../region-specific/AU/VIC/state.js";
import {
	applyVLineEnrichment,
	getVLineVehicleFormation,
	refreshVLineOfficialSources,
	vlineDetails,
	vlineVehicleInfoForTrip,
} from "../region-specific/AU/VIC/enrichment.js";
import type { VLinePluginOptions } from "../region-specific/AU/VIC/types.js";
import {
	buildVLineRealtimeTripAliases,
	canonicalVLineRealtimeTripId,
} from "../region-specific/AU/VIC/realtime-aliases.js";

export function createVLinePlugin(options: VLinePluginOptions = {}): TransitPlugin {
	return {
		id: VLINE_PLUGIN_ID,
		feedIds: ["vic-vline"],
		capabilities: [
			"vehicles",
			"occupancy",
			"consist",
			"platform-changes",
			"boarding-locations",
			"supplemental-realtime",
		],
		afterSnapshotBuilt: buildVLineRealtimeTripAliases,
		beforeRealtime: (ctx) => refreshVLineOfficialSources(ctx, options),
		canonicalRealtimeTripId: canonicalVLineRealtimeTripId,
		afterRealtime: (ctx) => applyVLineEnrichment(ctx, options),
		vehicleInfoForTrip: vlineVehicleInfoForTrip,
		vehicleFormation: (trip, ctx) => getVLineVehicleFormation(trip, ctx, options),
		api: (ctx) => ({
			getTripDetails: (instanceId: string) => {
				const trip = ctx.augmented.instancesRec.get(instanceId);
				return trip ? vlineDetails(ctx, trip) : null;
			},
			getSourceStatus: () => structuredClone(getVLineState(ctx).sources),
			getDiagnostics: () => getVLineDiagnostics(ctx),
		}),
	};
}
