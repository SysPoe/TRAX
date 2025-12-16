import { TRAX_CONFIG } from "../config.js";
import { AugmentedStopTime } from "./augmentedStopTime.js";
import { AugmentedTrip, AugmentedTripInstance } from "./augmentedTrip.js";
import {
	getServiceCapacity as SEQServCap,
	ensureServiceCapacityData as SEQEnsCapData,
} from "../region-specific/SEQ/serviceCapacity.js";
import { CacheContext } from "../cache.js";

export function getServiceCapacity(
	inst: AugmentedTripInstance,
	stopTime: AugmentedStopTime,
	dateStr: string,
	_dirOverride?: string,
	ctx?: CacheContext,
): string {
	switch (TRAX_CONFIG.region) {
		case "SEQ":
			return SEQServCap(inst, stopTime, dateStr, _dirOverride, ctx);
		case "none":
		default:
			return "unknown";
	}
}

export async function ensureServiceCapacityData() {
	switch (TRAX_CONFIG.region) {
		case "SEQ":
			return SEQEnsCapData();
	}
}

export function addSCI(inst: AugmentedTripInstance, ctx?: CacheContext): AugmentedTripInstance {
	let prevSC: string | null = null;
	inst.stopTimes.forEach((st) => {
		if (st.passing || st.service_capacity !== null) return;
		st.service_capacity = getServiceCapacity(inst, st, inst.serviceDate, undefined, ctx);
		if (st.service_capacity !== null) prevSC = st.service_capacity;
		else st.service_capacity = prevSC;
	});
	return inst;
}

export function addSC(trip: AugmentedTrip, ctx?: CacheContext): AugmentedTrip {
	trip.instances = trip.instances.map((v) => addSCI(v, ctx));
	return trip;
}
