import type * as qdf from "qdf-gtfs";
import * as cache from "../cache.js";
import { RailwayStationFacility } from "../region-specific/SEQ/facilities-types.js";

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

export function augmentStop(stop: qdf.Stop, ctx: cache.CacheContext): AugmentedStop {
	const parentId = stop.parent_station ?? null;
	const childStops = cache.getRawStops(ctx).filter((s) => s.parent_station === stop.stop_id);
	const childIds = childStops.map((s) => s.stop_id);

	let cachedChildren: AugmentedStop[] | null = null;
	const resolveChildren = (): AugmentedStop[] => {
		if (cachedChildren) return cachedChildren;
		cachedChildren = childIds
			.map((id) => cache.getAugmentedStops(ctx, id)[0] ?? augmentStop(cache.getRawStops(ctx, id)[0], ctx))
			.filter((s): s is AugmentedStop => !!s);
		return cachedChildren;
	};

	const resolveParent = (): AugmentedStop | null => {
		if (!parentId) return null;
		return cache.getAugmentedStops(ctx, parentId)[0] ?? null;
	};

	const augmented: AugmentedStop = {
		...stop,
		parent_stop_id: parentId === "" ? null : parentId,
		child_stop_ids: childIds,
	};

	if (ctx.config.region === "SEQ") {
		const qrt_Places = cache.SEQgetQRTPlaces(ctx);
		const trimmedStopName = stop.stop_name?.toLowerCase().replace("station", "").trim();
		const myPlace = qrt_Places.find(
			(v) =>
				v.Title?.toLowerCase().trim() === trimmedStopName ||
				(trimmedStopName === "roma street" && v.Title?.toLowerCase().trim().includes("roma street")),
		);
		const facilities = cache.SEQgetRailwayStationFacilities(ctx);
		const myFacility = facilities.find(
			(f) =>
				f.stops &&
				(f.stops.includes(stop.stop_id) || (stop.parent_station && f.stops.includes(stop.parent_station))),
		);

		augmented.regionSpecific = {
			SEQ: {
				qrt_Place: !!myPlace,
				qrt_PlaceCode: myPlace?.qrt_PlaceCode,
				facilities: myFacility,
			},
		};
	}

	Object.defineProperties(augmented, {
		parent: {
			get: () => resolveParent(),
			enumerable: false,
		},
		children: {
			get: () => resolveChildren(),
			enumerable: false,
		},
	});

	return augmented;
}
