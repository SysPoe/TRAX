import { TraxConfig } from "../config.js";
import { CacheContext } from "../cache.js";
import { AugmentedTrip, AugmentedTripInstance } from "./augmentedTrip.js";
import { getVehicleInfo as getSEQVehicleInfo } from "../region-specific/SEQ/vehicleModel.js";
import { getVehicleInfo as getGTHAVehicleInfo } from "../region-specific/GTHA/vehicleModel.js";

export type VehicleInfo = {
	vehicle_model: string | null;
	vehicle_id: string | null;
};

function resolveVehicleInfo(inst: AugmentedTripInstance, ctx: CacheContext, config: TraxConfig): VehicleInfo {
	switch (config.region) {
		case "SEQ":
			return getSEQVehicleInfo(inst);
		case "GTHA":
			return getGTHAVehicleInfo(inst, ctx);
		default:
			return { vehicle_model: null, vehicle_id: null };
	}
}

export function addVehicleModel(
	inst: AugmentedTripInstance,
	ctx: CacheContext,
	config: TraxConfig,
): AugmentedTripInstance {
	const needsModel = inst.vehicle_model == null;
	const needsId = (inst as any).vehicle_id === undefined || inst.vehicle_id == null;
	if (needsModel || needsId) {
		const info = resolveVehicleInfo(inst, ctx, config);
		if (needsModel) inst.vehicle_model = info.vehicle_model;
		if (needsId) inst.vehicle_id = info.vehicle_id;
	}
	if (inst.vehicle_model === undefined) inst.vehicle_model = null;
	if (inst.vehicle_id === undefined) inst.vehicle_id = null;
	return inst;
}

export function addVehicleModelTrip(
	trip: AugmentedTrip,
	ctx: CacheContext,
	config: TraxConfig,
): AugmentedTrip {
	trip.instances = trip.instances.map((i) => addVehicleModel(i, ctx, config));
	return trip;
}
