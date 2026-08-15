import type { TransitPlugin } from "./types.js";
import { applyCisBoardingLocations, VIA_UPDATE_STOPS, updateRealtime } from "../region-specific/CA/VIA/realtime.js";
import { getViaConsist } from "../region-specific/CA/VIA/consist.js";
import type { VehicleDiagramKind } from "../utils/vehicleModel.js";

export function viaCarriageDiagramKind(...values: (string | null | undefined)[]): VehicleDiagramKind {
	const description = values.filter(Boolean).join(" ").toLowerCase();
	if (description.includes("baggage") || /\bbag\b/.test(description)) return "baggage";
	if (description.includes("diner") || description.includes("dining")) return "diner";
	if (description.includes("dome")) return "dome";
	if (description.includes("sleeper") || description.includes("cabin")) return "sleeper";
	if (description.includes("transition") || /\btrans\b/.test(description)) return "transition";
	if (description.includes("crew")) return "crew";
	if (description.includes("service") || /\bsvc\b/.test(description)) return "service";
	if (description.includes("locomotive")) return "locomotive";
	return "coach";
}

export function viaCarriageTypeLabel(kind: VehicleDiagramKind): string {
	return {
		locomotive: "Locomotive",
		cab: "Cab car",
		bilevel: "Bi-level coach",
		accessible: "Accessible coach",
		motor: "Motor car",
		trailer: "Trailer",
		dmu: "Diesel multiple unit",
		coach: "Coach",
		baggage: "Baggage car",
		diner: "Dining car",
		dome: "Dome car",
		sleeper: "Sleeper",
		service: "Service car",
		crew: "Crew car",
		transition: "Transition car",
	}[kind];
}

export function viaCarriageCodeDiagramKind(
	...values: (string | null | undefined)[]
): VehicleDiagramKind | null {
	for (const value of values) {
		const code = value?.trim().toUpperCase();
		if (code === "BAG") return "baggage";
		if (code === "CREW") return "crew";
		if (code === "DINER") return "diner";
		if (code === "DOME" || code === "SKY") return "dome";
		if (code === "TRANS") return "transition";
		if (code === "SVC") return "service";
	}
	return null;
}

export const viaPlugin: TransitPlugin = {
	id: "ca-via",
	feedIds: ["via"],
	capabilities: ["consist", "boarding-locations", "supplemental-realtime"],
	afterStaticLoad(ctx) {
		if (!ctx.gtfs) return;
		for (const action of VIA_UPDATE_STOPS) ctx.gtfs.actions.updateStop(action.stop_id, action.new, "via");
	},
	beforeRealtime: updateRealtime,
	afterRealtime: applyCisBoardingLocations,
	vehicleFormationUnits: async (trip, ctx) => {
		const consist = await getViaConsist(trip.instance_id, ctx);
		return (
			consist?.carriageLayout.carriages.map((carriage) => {
				const diagramKind =
					viaCarriageCodeDiagramKind(carriage.carriage_number, carriage.carriage_code) ??
					viaCarriageDiagramKind(carriage.carriage_type, carriage.carriage_name, carriage.template);
				return {
					id: carriage.carriage_number || carriage.carriage_name || String(carriage.sequence_number),
					diagramKind,
					type: viaCarriageTypeLabel(diagramKind),
					manufacturer: null,
					model: null,
					seats: carriage.seats.length,
					bicycles: null,
					accessible: null,
					wifi: null,
					powerOutlets: null,
					accentColor: null,
				};
			}) ?? null
		);
	},
	api: (ctx) => ({ getConsist: (instanceId: string) => getViaConsist(instanceId, ctx) }),
};
