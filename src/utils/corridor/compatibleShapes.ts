import { getServiceDatesByTrip } from "../calendar.js";
import { parseEntityKey } from "../../identity.js";
import { qualifiedKey, qualifiedRouteDirectionKey } from "./keys.js";
import type { CorridorIndex, IndexedShape } from "./shapeIndex.js";
import type { CacheContext } from "../../cache/types.js";
import type { JourneyContext } from "./types.js";

export interface CompatibleShapeCandidate {
	shape: IndexedShape;
	evidence: "compatible-shape" | "borrowed-shape";
	score: number;
}

function isActiveShape(shape: IndexedShape, journey: JourneyContext, ctx: CacheContext): boolean {
	if (!journey.serviceDate || !ctx.gtfs) return true;
	// Hand-built indexes and feeds without trip-calendar provenance cannot prove
	// that a shape is inactive. Keep that geometry available and let the gap
	// consensus decide whether it is safe to use.
	if (shape.tripIds.size === 0) return true;
	return [...shape.tripIds].some((tripId) =>
		getServiceDatesByTrip(parseEntityKey(tripId), ctx).includes(journey.serviceDate!),
	);
}

function overlapScore(shape: IndexedShape, journey: JourneyContext): number {
	return journey.anchors.reduce((score, anchor, index) => {
		if (!anchor.stationId || !shape.scheduledStations.has(anchor.stationId)) return score;
		return score + (index === 0 || index === journey.anchors.length - 1 ? 4 : 1);
	}, 0);
}

/** Find scoped same-route shapes and explicitly configured borrowed-feed shapes. */
export function findCompatibleShapes(
	journey: JourneyContext,
	index: CorridorIndex,
	ctx: CacheContext,
): CompatibleShapeCandidate[] {
	const candidates: CompatibleShapeCandidate[] = [];
	const exactKey = journey.shapeId ? qualifiedKey(journey.feedId, journey.shapeId) : null;
	if (journey.routeId !== null) {
		const routeDirectionKey = qualifiedRouteDirectionKey(journey.feedId, journey.routeId, journey.direction);
		const routePrefix = qualifiedKey(journey.feedId, `${journey.routeId}\0`);
		const shapeKeys =
			journey.direction === null
				? new Set(
						[...index.shapes.values()]
							.filter((shape) => [...shape.routeDirections].some((key) => key.startsWith(routePrefix)))
							.map((shape) => shape.key),
					)
				: (index.shapesByRouteDirection.get(routeDirectionKey) ?? []);
		for (const shapeKey of shapeKeys) {
			if (shapeKey === exactKey) continue;
			const shape = index.shapes.get(shapeKey);
			if (shape && isActiveShape(shape, journey, ctx)) {
				candidates.push({ shape, evidence: "compatible-shape", score: overlapScore(shape, journey) });
			}
		}
	}
	const configuredSource = ctx.config.corridor.geometrySources.find((source) => source.feedId === journey.feedId);
	const borrowedFeeds = journey.geometryFeedIds.filter(
		(feedId) => feedId !== journey.feedId && configuredSource?.borrowFromFeedIds.includes(feedId),
	);
	for (const shape of index.shapes.values()) {
		if (!borrowedFeeds.includes(shape.feedId) || !isActiveShape(shape, journey, ctx)) continue;
		const score = overlapScore(shape, journey);
		if (score < 4) continue;
		candidates.push({ shape, evidence: "borrowed-shape", score });
	}
	candidates.sort((a, b) => b.score - a.score || a.shape.key.localeCompare(b.shape.key));
	const unique = new Map<string, CompatibleShapeCandidate>();
	for (const candidate of candidates) {
		if (!unique.has(candidate.shape.key)) unique.set(candidate.shape.key, candidate);
	}
	return [...unique.values()];
}
