import { RealtimeVehiclePosition } from "qdf-gtfs";
import { CacheContext, getVehiclePositions, getTrips } from "../../cache.js";
import { AugmentedTripInstance } from "../../utils/augmentedTrip.js";
import type { VehicleInfo } from "../../utils/vehicleModel.js";

const GTHA_VEHICLE_RANGES: { start: number; end: number; model: string }[] = [
	{ start: 500, end: 507, model: "GMD GP40TC" },
	{ start: 510, end: 515, model: "GMD F40PH" },
	{ start: 520, end: 531, model: "GMD FP7" },
	{ start: 557, end: 568, model: "GMD F59PH" },
	{ start: 600, end: 666, model: "MPI MP40PH-3C" },
	{ start: 667, end: 682, model: "MPI MP54AC" },
	{ start: 700, end: 710, model: "GMD GP40-2W" },
	{ start: 720, end: 726, model: "GMD GP40-2W" },
	{ start: 1001, end: 1014, model: "Type A DMU" },
	{ start: 3001, end: 3006, model: "Type C DMU" },
];

export function getModelFromId(vehicleId: string): string | null {
	const numericId = Number.parseInt(vehicleId, 10);
	if (!Number.isNaN(numericId)) {
		for (const range of GTHA_VEHICLE_RANGES) {
			if (numericId >= range.start && numericId <= range.end) {
				return range.model;
			}
		}
	}
	return null;
}

function findRelevantVehicle(inst: AugmentedTripInstance, ctx: CacheContext): RealtimeVehiclePosition | null {
	const vehicles = getVehiclePositions(ctx);
	if (!vehicles || vehicles.length === 0) return null;

	const startDate = inst.rt_start_date ?? inst.serviceDate;
	const candidateTripIds = new Set<string>([inst.trip_id]);

	if (inst.block_id) {
		const serviceDateTrips = ctx.augmented.serviceDateTrips.get(startDate) ?? [];
		for (const tripId of serviceDateTrips) {
			if (candidateTripIds.has(tripId)) continue;
			const rawTrip = getTrips(ctx, tripId)[0];
			if (rawTrip?.block_id && rawTrip.block_id === inst.block_id) {
				candidateTripIds.add(tripId);
			}
		}
	}

	let blockMatch: RealtimeVehiclePosition | null = null;

	for (const vp of vehicles) {
		const vpTripId = vp.trip.trip_id;
		if (!vpTripId || !candidateTripIds.has(vpTripId)) continue;

		const vpStartDate = vp.trip.start_date ?? startDate;
		if (vpStartDate !== startDate) continue;

		if (vpTripId === inst.trip_id) return vp;
		if (!blockMatch) blockMatch = vp;
	}

	return blockMatch;
}

export function getVehicleInfo(inst: AugmentedTripInstance, ctx: CacheContext): VehicleInfo {
	const vehicle = findRelevantVehicle(inst, ctx);
	const vehicleId = vehicle?.vehicle.id ?? null;

	const vehicle_model = vehicleId ? getModelFromId(vehicleId) : null;

	return { vehicle_model, vehicle_id: vehicleId };
}
