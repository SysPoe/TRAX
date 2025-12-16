import type * as qdf from "qdf-gtfs";
import * as cache from "../cache.js";

export type AugmentedStop = qdf.Stop & {
	qrt_Place: boolean;
	qrt_PlaceCode?: string;
	parent_stop_id: string | null;
	child_stop_ids: string[];
	parent?: AugmentedStop | null;
	children?: AugmentedStop[];
};

export function augmentStop(stop: qdf.Stop, ctx?: cache.CacheContext): AugmentedStop {
	const parentId = stop.parent_station ?? null;
	const childStops = cache.getRawStops(undefined, ctx).filter((s) => s.parent_station === stop.stop_id);
	const childIds = childStops.map((s) => s.stop_id);

	let cachedChildren: AugmentedStop[] | null = null;
	const resolveChildren = (): AugmentedStop[] => {
		if (cachedChildren) return cachedChildren;
		cachedChildren = childIds
			.map((id) => cache.getAugmentedStops(id, ctx)[0] || augmentStop(cache.getRawStops(id, ctx)[0], ctx))
			.filter((s): s is AugmentedStop => !!s);
		return cachedChildren;
	};

	const resolveParent = (): AugmentedStop | null => {
		if (!parentId) return null;
		return cache.getAugmentedStops(parentId, ctx)[0] ?? null;
	};

	const qrt_Places = cache.getQRTPlaces(ctx);
	const trimmedStopName = stop.stop_name?.toLowerCase().replace("station", "").trim();
	const myPlace = qrt_Places.find(
		(v) =>
			v.Title?.toLowerCase().trim() === trimmedStopName ||
			(trimmedStopName === "roma street" && v.Title?.toLowerCase().trim().includes("roma street")),
	);

	const augmented: AugmentedStop = {
		...stop,
		qrt_Place: !!myPlace,
		qrt_PlaceCode: myPlace?.qrt_PlaceCode,
		parent_stop_id: parentId,
		child_stop_ids: childIds,
	};

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
