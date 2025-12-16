import { TRAX_CONFIG } from "../config.js";
import { AugmentedStopTime } from "./augmentedStopTime.js";
import { AugmentedTrip, AugmentedTripInstance } from "./augmentedTrip.js";
import {
	getServiceCapacity as SEQServCap,
	ensureServiceCapacityData as SEQEnsCapData,
} from "../region-specific/SEQ/serviceCapacity.js";

export function getServiceCapacity(
	inst: AugmentedTripInstance,
	stopTime: AugmentedStopTime,
	dateStr: string,
	_dirOverride?: string,
): string {
	switch (TRAX_CONFIG.region) {
		case "SEQ":
			return SEQServCap(inst, stopTime, dateStr, _dirOverride);
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

export function addSCI(inst: AugmentedTripInstance): AugmentedTripInstance {
	let prevSC: string | null = null;
	inst.stopTimes.forEach((st) => {
		if (st.passing || st.service_capacity !== null) return;
		st.service_capacity = getServiceCapacity(inst, st, inst.serviceDate);
		if (st.service_capacity !== null) prevSC = st.service_capacity;
		else st.service_capacity = prevSC;
	});
	return inst;
}

export function addSC(trip: AugmentedTrip): AugmentedTrip {
	trip.instances = trip.instances.map((v) => addSCI(v));
	return trip;
}
