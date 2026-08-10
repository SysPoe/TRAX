import { type TraxConfig } from "../config.js";
import { AugmentedStopTime } from "./augmentedStopTime.js";
import { AugmentedTrip, AugmentedTripInstance } from "./augmentedTrip.js";
import { CacheContext } from "../cache/index.js";
import { pluginSupportsFeed } from "../plugins/types.js";

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
	for (const plugin of config.network.plugins) {
		if (!pluginSupportsFeed(plugin, inst.feed_id)) continue;
		const value = plugin.serviceCapacity?.(inst, stopTime, dateStr, _dirOverride, ctx);
		if (value !== undefined) return value;
	}
	return ServiceCapacity.UNKNOWN;
}

export function addSCI(inst: AugmentedTripInstance, ctx: CacheContext, config: TraxConfig): AugmentedTripInstance {
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
	for (const instance of trip.instances) addSCI(instance, ctx, config);
	return trip;
}
