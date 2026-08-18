import type { TransitPlugin } from "./types.js";
import {
	enrichGthaVehiclePosition,
	refreshGthaOperatingSchedule,
	updateAllSources,
} from "../region-specific/CA/GTHA/realtime.js";
import {
	getActiveCars,
	getActivePassengerCars,
	getActiveVehicleIds,
	getActiveVehicleModels,
	getVehicleConsist,
	getGthaRealtimeDiagnostics,
} from "../region-specific/CA/GTHA/realtime.js";
import { getVehicleInfo } from "../region-specific/CA/GTHA/vehicleModel.js";
import { entityKey } from "../identity.js";
import { getGTHAVehicleDetails, GTHAVehicleDetails } from "../region-specific/CA/GTHA/vehicleDetails.js";

const goStop = (localId: string) => entityKey({ feedId: "go", localId });

export const gthaPlugin: TransitPlugin = {
	id: "ca-gtha",
	feedIds: ["go", "up"],
	capabilities: ["vehicles", "consist", "platform-changes", "supplemental-realtime"],
	beforeRealtime: refreshGthaOperatingSchedule,
	afterRealtime(ctx) {
		if (!ctx.gtfs) return;
		ctx.config.progressLog({
			task: "Loading GTHA supplemental realtime",
			current: 0,
			total: 0,
			percent: 0,
			speed: 0,
			eta: 0,
		});
		return updateAllSources(ctx, ctx.gtfs);
	},
	enrichVehiclePosition: enrichGthaVehiclePosition,
	vehicleInfoForTrip: getVehicleInfo,
	vehicleFormationUnits: (trip, ctx) => {
		const consist = trip.consist ?? (trip.vehicle_id ? getVehicleConsist(ctx, trip.vehicle_id) : null);
		return (
			consist?.map((id) => {
				const details = getGTHAVehicleDetails(id);
				return {
					id,
					diagramKind:
						details?.type === "Locomotive"
							? "locomotive"
							: details?.type === "Cab Car"
								? "cab"
								: details?.type === "Accessible Coach"
									? "accessible"
									: details?.type === "DMU"
										? "dmu"
										: "bilevel",
					type: details?.type ?? null,
					manufacturer: details?.description.manufacturer ?? null,
					model: details?.description.model ?? null,
					seats: details?.capacity.seating ?? null,
					bicycles: details?.capacity.bicycles ?? null,
					accessible:
						details == null
							? null
							: details.accessibility.is_fully_accessible ||
								(details.individual_car_data?.is_accessible ?? false),
					wifi: details?.amenities.connectivity.has_wifi ?? null,
					powerOutlets: details?.amenities.connectivity.has_power_outlets ?? null,
					accentColor: details?.livery.hex_color ?? null,
				};
			}) ?? null
		);
	},
	filterTrackEdges(edges) {
		edges.delete(`${goStop("UN")}|${goStop("KE")}`);
		edges.delete(`${goStop("KE")}|${goStop("UN")}`);
	},
	enrichTrackGraph(matrix, adjacency) {
		const ke = goStop("KE"),
			sc = goStop("SC");
		(matrix[ke] ??= {})[sc] = 2;
		(matrix[sc] ??= {})[ke] = 2;
		if (!(adjacency[ke] ??= []).includes(sc)) adjacency[ke].push(sc);
		if (!(adjacency[sc] ??= []).includes(ke)) adjacency[sc].push(ke);
	},
	api: (ctx) => ({
		getActiveCars: () => getActiveCars(ctx),
		getActivePassengerCars: () => getActivePassengerCars(ctx),
		getActiveVehicleIds: () => getActiveVehicleIds(ctx),
		getActiveVehicleModels: () => getActiveVehicleModels(ctx),
		getVehicleDetails: (vehicleId: string) => getGTHAVehicleDetails(vehicleId),
		getVehicleModels: () =>
			Array.from(new Set(GTHAVehicleDetails.map((vehicle) => vehicle.description.model))).sort(),
		getDiagnostics: () => getGthaRealtimeDiagnostics(ctx),
	}),
};
