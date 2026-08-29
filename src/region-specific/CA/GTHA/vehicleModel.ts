import { RealtimeVehiclePosition } from "qdf-gtfs";
import { CacheContext, getVehiclePositions } from "../../../cache/index.js";
import { AugmentedTripInstance } from "../../../utils/augmentedTrip.js";
import type { VehicleInfo } from "../../../utils/vehicleModel.js";

import { getGTHAVehicleDetails } from "./vehicleDetails.js";

const GTHA_VEHICLE_RANGES: { start: number; end: number; model: string }[] = [
	{ start: 520, end: 568, model: "GMD F59PH" },
	{ start: 600, end: 666, model: "MPI MP40PH-3C" },
	{ start: 667, end: 682, model: "MPI MP54AC" },
	{ start: 1001, end: 1014, model: "Type A DMU" },
	{ start: 3001, end: 3006, model: "Type C DMU" },
];

type GthaVehicleModelState = { blockTrips: Map<string, string[]> };

function getState(ctx: CacheContext): GthaVehicleModelState {
	const key = "ca-gtha:vehicle-model";
	const existing = ctx.pluginState.get(key) as GthaVehicleModelState | undefined;
	if (existing) return existing;
	const state: GthaVehicleModelState = { blockTrips: new Map() };
	ctx.pluginState.set(key, state);
	return state;
}

function getActiveBlockTripIds(inst: AugmentedTripInstance, startDate: string, ctx: CacheContext): string[] {
	if (!inst.block_id || !ctx.gtfs) return [];
	const key = `${inst.feed_id}\0${inst.block_id}\0${startDate}`;
	const state = getState(ctx);
	const cached = state.blockTrips.get(key);
	if (cached) return cached;
	const tripIds = ctx.gtfs
		.getTrips({ feed_id: inst.feed_id, block_id: inst.block_id, date: startDate })
		.map((trip) => trip.trip_id);
	state.blockTrips.set(key, tripIds);
	return tripIds;
}

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
		for (const tripId of getActiveBlockTripIds(inst, startDate, ctx)) candidateTripIds.add(tripId);
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

	const vehicleDetails = vehicleId ? getGTHAVehicleDetails(vehicleId) : null;
	const vehicle_model = vehicleDetails?.description.model ?? (vehicleId ? getModelFromId(vehicleId) : null);

	return { vehicle_model, vehicle_id: vehicleId, details: vehicleDetails };
}
