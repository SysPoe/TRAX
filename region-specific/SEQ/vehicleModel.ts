import { AugmentedTripInstance } from "../../utils/augmentedTrip.js";
import type { VehicleInfo } from "../../utils/vehicleModel.js";

const RUN_MODEL_MAP: Record<string, string> = {
	"1": "6 car Suburban Multiple Unit",
	D: "New Generation Rollingstock",
	J: "3 car Suburban Multiple Unit",
	T: "6 car Interurban Multiple Unit",
	U: "3 car Interurban Multiple Unit",
	X: "ETCS L2 Equipped Train",
};

export function getVehicleInfo(inst: AugmentedTripInstance): VehicleInfo {
	const prefix = inst.run?.[0]?.toUpperCase();
	const vehicle_model = prefix ? (RUN_MODEL_MAP[prefix] ?? null) : null;
	return { vehicle_model, vehicle_id: null };
}
