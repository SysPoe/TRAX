import { TraxConfig } from "../config.js";
import { AugmentedStopTime } from "./augmentedStopTime.js";
import { AugmentedTrip, AugmentedTripInstance } from "./augmentedTrip.js";
import {
	getServiceCapacity as SEQServCap,
	ensureServiceCapacityData as SEQEnsCapData,
} from "../region-specific/SEQ/serviceCapacity.js";
import { CacheContext } from "../cache.js";

export enum ServiceCapacity {
	NOT_CALCULATED = -2,
	UNKNOWN = -1,
	EMPTY = 0,
	MANY_SEATS_AVAILABLE = 1,
	FEW_SEATS_AVAILABLE = 2,
	STANDING_ROOM_ONLY = 3,
	FULL = 4,
}

export function getServiceCapacity(
	inst: AugmentedTripInstance,
	stopTime: AugmentedStopTime,
	dateStr: string,
	_dirOverride: string | undefined,
	ctx: CacheContext,
	config: TraxConfig,
): ServiceCapacity {
	switch (config.region) {
		case "SEQ":
			return SEQServCap(inst, stopTime, dateStr, _dirOverride, ctx);
		case "none":
		default:
			return ServiceCapacity.UNKNOWN;
	}
}

export async function ensureServiceCapacityData(config: TraxConfig) {
	switch (config.region) {
		case "SEQ":
			return SEQEnsCapData(config);
	}
}

export function addSCI(
	inst: AugmentedTripInstance,
	ctx: CacheContext,
	config: TraxConfig,
): AugmentedTripInstance {
	let prevSC: ServiceCapacity = ServiceCapacity.UNKNOWN;
	inst.stopTimes.forEach((st) => {
		if (st.passing || st.service_capacity !== ServiceCapacity.NOT_CALCULATED) return;
		st.service_capacity = getServiceCapacity(inst, st, inst.serviceDate, undefined, ctx, config);
		if (st.service_capacity !== ServiceCapacity.NOT_CALCULATED) prevSC = st.service_capacity;
		else st.service_capacity = prevSC;
	});
	return inst;
}

export function addSC(trip: AugmentedTrip, ctx: CacheContext, config: TraxConfig): AugmentedTrip {
	trip.instances = trip.instances.map((v) => addSCI(v, ctx, config));
	return trip;
}