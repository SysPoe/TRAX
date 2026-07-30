import { isRegion, TraxConfig } from "../config.js";
import { CacheContext } from "../cache/index.js";
import { AugmentedTrip, AugmentedTripInstance } from "./augmentedTrip.js";
import { getVehicleInfo as getSEQVehicleInfo } from "../region-specific/AU/SEQ/vehicleModel.js";
import { getVehicleInfo as getGTHAVehicleInfo } from "../region-specific/CA/GTHA/vehicleModel.js";

export type VehicleInfo = {
	vehicle_model: string | null;
	vehicle_id: string | null;
	passenger_cars?: number | null;
	scheduled_passenger_cars?: number | null;
	consist?: string[] | null;
	details?: unknown | null;
};

function resolveVehicleInfo(inst: AugmentedTripInstance, ctx: CacheContext, config: TraxConfig): VehicleInfo {
	if (isRegion(config.region, "AU/SEQ")) return getSEQVehicleInfo(inst);
	if (isRegion(config.region, "CA/GTHA")) return getGTHAVehicleInfo(inst, ctx);
	return { vehicle_model: null, vehicle_id: null };
}

const previousVehicleInfo = new Map<string, VehicleInfo>();

/** Static generations invalidate every instance id and all retained vehicle metadata. */
export function clearPreviousVehicleInfo(): void {
	previousVehicleInfo.clear();
}

/** Drop metadata for instances no longer present after an incremental refresh. */
export function prunePreviousVehicleInfo(validInstanceIds: Iterable<string>): void {
	const valid = new Set(validInstanceIds);
	for (const instanceId of previousVehicleInfo.keys()) {
		if (!valid.has(instanceId)) previousVehicleInfo.delete(instanceId);
	}
}

export function mergeVehicleInfo(inst: AugmentedTripInstance, incoming: VehicleInfo): VehicleInfo {
	const prev = previousVehicleInfo.get(inst.instance_id);
	const vehicle_id = incoming.vehicle_id ?? prev?.vehicle_id ?? inst.vehicle_id ?? null;
	const vehicle_model = incoming.vehicle_model ?? prev?.vehicle_model ?? inst.vehicle_model ?? null;
	const passenger_cars = incoming.passenger_cars ?? prev?.passenger_cars ?? inst.passenger_cars ?? null;
	const scheduled_passenger_cars =
		incoming.scheduled_passenger_cars ?? prev?.scheduled_passenger_cars ?? inst.scheduled_passenger_cars ?? null;
	const consist = incoming.consist ?? prev?.consist ?? inst.consist ?? null;
	const details = incoming.details ?? prev?.details ?? inst.vehicle_details ?? null;

	previousVehicleInfo.set(inst.instance_id, {
		vehicle_id,
		vehicle_model,
		passenger_cars,
		scheduled_passenger_cars,
		consist,
		details,
	});

	return { vehicle_id, vehicle_model, passenger_cars, scheduled_passenger_cars, consist, details };
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
	const needsConsist = inst.consist == null;

	if (needsModel || needsId || needsPassengerCars || needsScheduledPassengerCars || needsConsist) {
		const info = mergeVehicleInfo(inst, resolveVehicleInfo(inst, ctx, config));
		if (needsModel) inst.vehicle_model = info.vehicle_model;
		if (needsId) inst.vehicle_id = info.vehicle_id;
		if (needsPassengerCars) inst.passenger_cars = info.passenger_cars ?? null;
		if (needsScheduledPassengerCars) inst.scheduled_passenger_cars = info.scheduled_passenger_cars ?? null;
		if (needsConsist) inst.consist = info.consist ?? null;
		inst.vehicle_details = info.details ?? null;
	}
	if (inst.vehicle_model === undefined) inst.vehicle_model = null;
	if (inst.vehicle_id === undefined) inst.vehicle_id = null;
	if (inst.passenger_cars === undefined) inst.passenger_cars = null;
	if (inst.scheduled_passenger_cars === undefined) inst.scheduled_passenger_cars = null;
	if (inst.consist === undefined) inst.consist = null;
	return inst;
}

export function addVehicleModelTrip(trip: AugmentedTrip, ctx: CacheContext, config: TraxConfig): AugmentedTrip {
	for (const instance of trip.instances) addVehicleModel(instance, ctx, config);
	return trip;
}
