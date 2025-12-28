import { TraxConfig } from "../config.js";
import { CacheContext } from "../cache.js";
import { AugmentedTrip, AugmentedTripInstance } from "./augmentedTrip.js";
import { getVehicleInfo as getSEQVehicleInfo } from "../region-specific/SEQ/vehicleModel.js";
import { getVehicleInfo as getGTHAVehicleInfo } from "../region-specific/GTHA/vehicleModel.js";

export type VehicleInfo = {
	vehicle_model: string | null;
	vehicle_id: string | null;
	passenger_cars?: number | null;
	scheduled_passenger_cars?: number | null;
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

const previousVehicleInfo: Record<string, VehicleInfo> = {};

export function mergeVehicleInfo(inst: AugmentedTripInstance, incoming: VehicleInfo): VehicleInfo {
	const prev = previousVehicleInfo[inst.instance_id];
	const vehicle_id = incoming.vehicle_id ?? prev?.vehicle_id ?? inst.vehicle_id ?? null;
	const vehicle_model = incoming.vehicle_model ?? prev?.vehicle_model ?? inst.vehicle_model ?? null;
	const passenger_cars = incoming.passenger_cars ?? prev?.passenger_cars ?? inst.passenger_cars ?? null;
	const scheduled_passenger_cars =
		incoming.scheduled_passenger_cars ?? prev?.scheduled_passenger_cars ?? inst.scheduled_passenger_cars ?? null;

	previousVehicleInfo[inst.instance_id] = {
		vehicle_id,
		vehicle_model,
		passenger_cars,
		scheduled_passenger_cars,
	};

	return { vehicle_id, vehicle_model, passenger_cars, scheduled_passenger_cars };
}

export function addVehicleModel(
	inst: AugmentedTripInstance,
	ctx: CacheContext,
	config: TraxConfig,
): AugmentedTripInstance {
	const needsModel = inst.vehicle_model == null;
	const needsId = inst.vehicle_id === undefined || inst.vehicle_id == null;
	const needsPassengerCars = inst.passenger_cars == null;
	const needsScheduledPassengerCars = inst.scheduled_passenger_cars == null;

	if (needsModel || needsId || needsPassengerCars || needsScheduledPassengerCars) {
		const info = mergeVehicleInfo(inst, resolveVehicleInfo(inst, ctx, config));
		if (needsModel) inst.vehicle_model = info.vehicle_model;
		if (needsId) inst.vehicle_id = info.vehicle_id;
		if (needsPassengerCars) inst.passenger_cars = info.passenger_cars ?? null;
		if (needsScheduledPassengerCars) inst.scheduled_passenger_cars = info.scheduled_passenger_cars ?? null;
	}
	if (inst.vehicle_model === undefined) inst.vehicle_model = null;
	if (inst.vehicle_id === undefined) inst.vehicle_id = null;
	if (inst.passenger_cars === undefined) inst.passenger_cars = null;
	if (inst.scheduled_passenger_cars === undefined) inst.scheduled_passenger_cars = null;
	return inst;
}

export function addVehicleModelTrip(trip: AugmentedTrip, ctx: CacheContext, config: TraxConfig): AugmentedTrip {
	trip.instances = trip.instances.map((i) => addVehicleModel(i, ctx, config));
	return trip;
}
