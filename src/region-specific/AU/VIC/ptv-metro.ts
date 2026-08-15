import type { RealtimeVehiclePosition } from "qdf-gtfs";
import { getVehiclePositions } from "../../../cache/gtfsReads.js";
import type { CacheContext } from "../../../cache/types.js";
import { entityKey } from "../../../identity.js";
import { getPluginState } from "../../../plugins/types.js";
import type { VehicleFormationUnit, VehicleInfo } from "../../../utils/vehicleModel.js";
import { ptvVehicleDescriptorConsist } from "./identifiers.js";

const PTV_METRO_PLUGIN_ID = "au-vic-ptv-metro";
const PTV_METRO_SOURCE = "vic-metro-gtfsrt-vehicle-positions";

type PtvMetroVehicleDetails = {
	source: typeof PTV_METRO_SOURCE;
	observedAt: string;
	sourceTimestamp: string | null;
	rawIdentifier: string;
	consist: string[];
};

type PtvMetroState = { vehicleInfoByInstanceId: Map<string, VehicleInfo> };

function getState(ctx: CacheContext): PtvMetroState {
	return getPluginState(ctx, PTV_METRO_PLUGIN_ID, () => ({ vehicleInfoByInstanceId: new Map() }));
}

function matchingInstances(ctx: CacheContext, vehicle: RealtimeVehiclePosition) {
	const trip = ctx.augmented.tripsRec.get(entityKey({ feedId: vehicle.feed_id, localId: vehicle.trip.trip_id }));
	if (!trip) return [];
	return vehicle.trip.start_date
		? trip.instances.filter((instance) => instance.serviceDate === vehicle.trip.start_date)
		: trip.instances.length === 1 ? trip.instances : [];
}

/** Project PTV Metro's hyphen-separated vehicle descriptor onto TRAX's provider-neutral consist model. */
export function applyPtvMetroVehicles(ctx: CacheContext): void {
	const state = getState(ctx);
	state.vehicleInfoByInstanceId.clear();
	const observedAt = new Date().toISOString();
	for (const vehicle of getVehiclePositions(ctx)) {
		if (vehicle.feed_id !== "vic-metro") continue;
		const consist = ptvVehicleDescriptorConsist("vic-metro", vehicle.vehicle.id);
		if (!consist) continue;
		const details: PtvMetroVehicleDetails = {
			source: PTV_METRO_SOURCE,
			observedAt,
			sourceTimestamp: vehicle.timestamp ? new Date(vehicle.timestamp * 1000).toISOString() : null,
			rawIdentifier: vehicle.vehicle.id,
			consist,
		};
		for (const instance of matchingInstances(ctx, vehicle)) {
			state.vehicleInfoByInstanceId.set(instance.instance_id, {
				vehicle_id: null, vehicle_model: null, consist, details,
			});
		}
	}
}

export function ptvMetroVehicleInfoForTrip(instanceId: string, ctx: CacheContext): VehicleInfo | null {
	return getState(ctx).vehicleInfoByInstanceId.get(instanceId) ?? null;
}

function inRange(value: number, from: number, to: number): boolean {
	return value >= from && value <= to;
}

/** Conservative fleet-number identification; unknown stock remains a typed motor/trailer. */
export function ptvMetroFleetModel(vehicleId: string): string | null {
	const number = Number.parseInt(vehicleId, 10);
	if (!Number.isFinite(number)) return null;
	if (inRange(number, 8105, 8605)) return "X’Trapolis 2.0";
	if (inRange(number, 9001, 9969)) return "HCMT";
	if (inRange(number, 301, 680) || inRange(number, 691, 698) || inRange(number, 1001, 1199)) return "Comeng";
	if (inRange(number, 701, 844) || inRange(number, 2501, 2572)) return "Siemens Nexas";
	if (inRange(number, 1, 288) || inRange(number, 851, 986) || inRange(number, 1301, 1693)) return "X’Trapolis 100";
	return null;
}

export function ptvMetroFormationUnit(id: string): VehicleFormationUnit {
	const trailer = /T$/i.test(id);
	return {
		id,
		diagramKind: trailer ? "trailer" : "motor",
		type: trailer ? "Trailer" : "Motor",
		manufacturer: null,
		model: ptvMetroFleetModel(id),
		seats: null,
		bicycles: null,
		accessible: null,
		wifi: null,
		powerOutlets: null,
		accentColor: "#0072ce",
	};
}
