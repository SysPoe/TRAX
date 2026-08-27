import type { CorridorIndex, IndexedShape } from "./shapeIndex.js";
import type { ShapeAlignment } from "./alignShape.js";
import type {
	CorridorConfidence,
	CorridorEvidence,
	CorridorGapResolution,
	CorridorNode,
	JourneyAnchor,
	JourneyContext,
	CorridorResolutionConfig,
} from "./types.js";

function confidenceForShape(
	evidence: CorridorEvidence,
	from: JourneyAnchor,
	to: JourneyAnchor,
	alignment: ShapeAlignment,
	fromIndex: number,
	toIndex: number,
	config: CorridorResolutionConfig,
): CorridorConfidence {
	const first = alignment.anchors.get(fromIndex);
	const last = alignment.anchors.get(toIndex);
	const endpointLateral = Math.max(first?.lateralDistanceMeters ?? Infinity, last?.lateralDistanceMeters ?? Infinity);
	if (
		evidence === "exact-shape" &&
		first?.nativeDistanceUsed &&
		last?.nativeDistanceUsed &&
		Number.isFinite(from.shapeDistTraveled) &&
		Number.isFinite(to.shapeDistTraveled)
	)
		return "high";
	if (evidence === "exact-shape" && endpointLateral <= 50) return "high";

	const membershipLimit =
		evidence === "exact-shape"
			? config.geometry.exactShapeMembershipMaxMeters
			: config.geometry.compatibleShapeMaxMeters;
	// Endpoint snapping is useful for a shape that stops at a station, but a
	// distant snap must remain diagnostic-only under the default medium floor.
	if (endpointLateral > Math.min(config.geometry.endpointSnapMaxMeters, membershipLimit) * 0.75) return "low";
	return "medium";
}

function endpointNode(
	anchor: JourneyAnchor,
	evidence: CorridorEvidence,
	confidence: CorridorConfidence,
	distanceAlongMeters?: number,
): CorridorNode {
	return {
		id: anchor.stationId ?? anchor.id,
		stationId: anchor.stationId,
		name: anchor.name,
		kind: "station",
		scheduled: true,
		passing: false,
		distanceAlongMeters,
		evidence,
		confidence,
	};
}

/** Resolve one consecutive anchor pair from one aligned shape. */
export function resolveShapeGap(
	from: JourneyAnchor,
	to: JourneyAnchor,
	fromIndex: number,
	toIndex: number,
	shape: IndexedShape,
	alignment: ShapeAlignment,
	journey: JourneyContext,
	index: CorridorIndex,
	config: CorridorResolutionConfig,
	evidence: Extract<CorridorEvidence, "exact-shape" | "compatible-shape" | "borrowed-shape">,
): CorridorGapResolution | null {
	if (alignment.ambiguous) return null;
	const fromPosition = alignment.anchors.get(fromIndex);
	const toPosition = alignment.anchors.get(toIndex);
	if (!fromPosition || !toPosition || toPosition.distanceAlongMeters <= fromPosition.distanceAlongMeters + 2)
		return null;

	let confidence = confidenceForShape(evidence, from, to, alignment, fromIndex, toIndex, config);
	const scheduledIds = new Set(
		journey.anchors
			.map((anchor) => anchor.stationId)
			.filter((stationId): stationId is string => stationId !== null),
	);
	const alignedPositionsByStation = new Map<string, number[]>();
	for (const aligned of alignment.anchors.values()) {
		if (!aligned.anchor.stationId) continue;
		const positions = alignedPositionsByStation.get(aligned.anchor.stationId) ?? [];
		positions.push(aligned.distanceAlongMeters);
		alignedPositionsByStation.set(aligned.anchor.stationId, positions);
	}
	const passing: Array<{ node: CorridorNode; progress: number; lateralDistanceMeters: number }> = [];
	const seenStations = new Set<string>();
	for (const [stationId, projections] of shape.projections) {
		if (stationId === from.stationId || stationId === to.stationId) continue;
		const geometryStation = index.stationGeometry.get(stationId);
		for (const projection of projections) {
			const progress =
				alignment.orientation === "forward"
					? projection.distanceAlongMeters
					: shape.lengthMeters - projection.distanceAlongMeters;
			if (progress <= fromPosition.distanceAlongMeters + 2 || progress >= toPosition.distanceAlongMeters - 2)
				continue;
			const maxDistance = shape.scheduledStations.has(stationId)
				? evidence === "exact-shape"
					? config.geometry.exactShapeMembershipMaxMeters
					: config.geometry.compatibleShapeMaxMeters
				: config.geometry.geometryOnlyMaxMeters;
			if (projection.lateralDistanceMeters > maxDistance) continue;
			if (scheduledIds.has(stationId)) {
				if (!shape.scheduledStations.has(stationId)) continue;
				const alignedPositions = alignedPositionsByStation.get(stationId);
				if (
					alignedPositions?.some(
						(position) =>
							position > fromPosition.distanceAlongMeters + 2 &&
							position < toPosition.distanceAlongMeters - 2,
					)
				) {
					return null;
				}
				if (!alignedPositions?.length) return null;
				continue;
			}
			if (seenStations.has(stationId)) continue;
			seenStations.add(stationId);
			passing.push({
				progress,
				lateralDistanceMeters: projection.lateralDistanceMeters,
				node: {
					id: stationId,
					stationId,
					name: geometryStation?.names[0],
					kind: "station",
					scheduled: false,
					passing: true,
					distanceAlongMeters: progress,
					evidence,
					confidence,
				},
			});
		}
	}
	passing.sort((a, b) => a.progress - b.progress);
	if (
		passing.some(({ node, lateralDistanceMeters }) => {
			const membershipLimit = shape.scheduledStations.has(node.stationId ?? "")
				? evidence === "exact-shape"
					? config.geometry.exactShapeMembershipMaxMeters
					: config.geometry.compatibleShapeMaxMeters
				: config.geometry.geometryOnlyMaxMeters;
			return lateralDistanceMeters > membershipLimit * 0.75;
		})
	)
		confidence = "low";

	const nodes = [
		endpointNode(from, evidence, confidence, fromPosition.distanceAlongMeters),
		...passing.map(({ node }) => node),
		endpointNode(to, evidence, confidence, toPosition.distanceAlongMeters),
	];
	for (const node of nodes) node.confidence = confidence;

	return {
		status: "resolved",
		from,
		to,
		nodes,
		evidence,
		confidence,
	};
}
