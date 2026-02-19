import type * as qdf from "qdf-gtfs";
import * as cache from "../cache.js";
import { isRegion } from "../config.js";
import { RailwayStationFacility } from "../region-specific/AU/SEQ/facilities-types.js";
import type { QRTPlace } from "../region-specific/AU/SEQ/qr-travel/types.js";

export type AugmentedStop = qdf.Stop & {
	regionSpecific?: {
		SEQ?: {
			qrt_Place: boolean;
			qrt_PlaceCode?: string;
			facilities?: RailwayStationFacility;
		};
	};
	parent_stop_id: string | null;
	child_stop_ids: string[];
	parent?: AugmentedStop | null;
	children?: AugmentedStop[];
};

export interface AugmentationContext {
	childrenByParent?: Map<string, qdf.Stop[]>;
	qrtPlacesByName?: Map<string, QRTPlace>;
	facilitiesByStopId?: Map<string, RailwayStationFacility>;
}

export function augmentStop(stop: qdf.Stop, ctx: cache.CacheContext, augCtx?: AugmentationContext): AugmentedStop {
	const parentId = stop.parent_station ?? null;

	let childIds: string[] = [];
	if (augCtx?.childrenByParent) {
		childIds = augCtx.childrenByParent.get(stop.stop_id)?.map((s) => s.stop_id) ?? [];
	} else {
		const childStops = cache.getRawStops(ctx).filter((s) => s.parent_station === stop.stop_id);
		childIds = childStops.map((s) => s.stop_id);
	}

	const augmented: AugmentedStop = {
		...stop,
		parent_stop_id: parentId === "" ? null : parentId,
		child_stop_ids: childIds,
		parent: null,
		children: [],
	};

	if (isRegion(ctx.config.region, "AU/SEQ")) {
		let myPlace = null;
		const trimmedStopName = stop.stop_name?.toLowerCase().replace("station", "").trim();
		if (augCtx?.qrtPlacesByName) {
			myPlace =
				augCtx.qrtPlacesByName.get(trimmedStopName!) ||
				(trimmedStopName === "roma street" ? augCtx.qrtPlacesByName.get("roma street") : null);
		} else {
			const qrt_Places = cache.SEQgetQRTPlaces(ctx);
			myPlace = qrt_Places.find(
				(v) =>
					v.Title?.toLowerCase().trim() === trimmedStopName ||
					(trimmedStopName === "roma street" && v.Title?.toLowerCase().trim().includes("roma street")),
			);
		}

		let myFacility = null;
		if (augCtx?.facilitiesByStopId) {
			myFacility =
				augCtx.facilitiesByStopId.get(stop.stop_id) ||
				(stop.parent_station ? augCtx.facilitiesByStopId.get(stop.parent_station) : null);
		} else {
			const facilities = cache.SEQgetRailwayStationFacilities(ctx);
			myFacility = facilities.find(
				(f) =>
					f.stops &&
					(f.stops.includes(stop.stop_id) || (stop.parent_station && f.stops.includes(stop.parent_station))),
			);
		}

		augmented.regionSpecific = {
			SEQ: {
				qrt_Place: !!myPlace,
				qrt_PlaceCode: myPlace?.qrt_PlaceCode,
				facilities: myFacility as RailwayStationFacility,
			},
		};
	}

	// We'll populate parent/children later in cache.ts to avoid recursion and getters
	return augmented;
}
