import type { CacheContext } from "../../cache/types.js";
import type { CorridorIndex } from "./shapeIndex.js";
import { findPatternGapPaths, getCachedActivePatterns } from "./patternIndex.js";
import { qualifiedRouteDirectionKey } from "./keys.js";
import type {
	CorridorGapResolution,
	CorridorNode,
	JourneyAnchor,
	JourneyContext,
	CorridorResolutionConfig,
} from "./types.js";

/** Resolve a gap when active route and direction patterns agree on one path. */
export function resolvePatternGap(
	from: JourneyAnchor,
	to: JourneyAnchor,
	journey: JourneyContext,
	index: CorridorIndex,
	ctx: CacheContext,
): CorridorGapResolution | null {
	if (!from.stationId || !to.stationId) return null;
	const scopedPatterns =
		journey.routeId === null
			? index.patterns
			: journey.direction === null
				? index.patterns.filter(
						(pattern) => pattern.feedId === journey.feedId && pattern.routeId === journey.routeId,
					)
				: (index.patternsByRouteDirection.get(
						qualifiedRouteDirectionKey(journey.feedId, journey.routeId, journey.direction),
					) ??
					index.patterns.filter(
						(pattern) =>
							pattern.feedId === journey.feedId &&
							pattern.routeId === journey.routeId &&
							String(pattern.direction ?? "*") === String(journey.direction),
					));
	const patterns = getCachedActivePatterns(scopedPatterns, journey, ctx);
	const paths = findPatternGapPaths(patterns, from.stationId, to.stationId);
	// A stopping pattern with only the two observed anchors proves order, not
	// physical adjacency. Only a longer ordered supersequence can contribute
	// passing stations to a gap.
	const longerPaths = paths.filter((path) => path.stations.length > 2);
	if (longerPaths.length === 0) return null;
	const signatures = new Set(longerPaths.map((path) => path.stations.join("|")));
	if (signatures.size > 1) return null;

	const selected = longerPaths[0];
	const scheduledIds = new Set(
		journey.anchors
			.map((anchor) => anchor.stationId)
			.filter((stationId): stationId is string => stationId !== null),
	);
	if (selected.stations.slice(1, -1).some((stationId) => scheduledIds.has(stationId))) return null;
	const nodes: CorridorNode[] = [
		{
			id: from.stationId,
			stationId: from.stationId,
			name: from.name,
			kind: "station",
			scheduled: true,
			passing: false,
			evidence: "active-pattern",
			confidence: "medium",
		},
		...selected.stations.slice(1, -1).flatMap((stationId) => {
			if (scheduledIds.has(stationId)) return [];
			return [
				{
					id: stationId,
					stationId,
					name: index.stationGeometry.get(stationId)?.names[0],
					kind: "station" as const,
					scheduled: false,
					passing: true,
					evidence: "active-pattern" as const,
					confidence: "medium" as const,
				},
			];
		}),
		{
			id: to.stationId,
			stationId: to.stationId,
			name: to.name,
			kind: "station",
			scheduled: true,
			passing: false,
			evidence: "active-pattern",
			confidence: "medium",
		},
	];
	return {
		status: "resolved",
		from,
		to,
		nodes,
		evidence: "active-pattern",
		confidence: "medium",
	};
}
