import type { CorridorResolutionConfig, JourneyAnchor, StationProjection } from "./types.js";
import type { IndexedShape } from "./shapeIndex.js";

interface AlignmentCandidate {
	key: string;
	distanceAlongMeters: number;
	routeProgress: number;
	lateralDistanceMeters: number;
	nativeShapeDistance: number | null;
	coordinateSource: "parent" | "platform" | "native";
	cost: number;
}

export interface AlignedAnchor {
	index: number;
	anchor: JourneyAnchor;
	distanceAlongMeters: number;
	lateralDistanceMeters: number;
	nativeShapeDistance: number | null;
	coordinateSource: "parent" | "platform" | "native";
	nativeDistanceUsed: boolean;
	cost: number;
}

export interface ShapeAlignment {
	orientation: "forward" | "reverse";
	anchors: Map<number, AlignedAnchor>;
	matchedCount: number;
	score: number;
	ambiguous: boolean;
}

export interface ShapeAlignmentOptions {
	/** Native distances are transferable only for the journey's exact shape. */
	useNativeShapeDistance: boolean;
}

function validDistance(value: number | null | undefined): number | null {
	return value != null && Number.isFinite(value) && value >= 0 ? value : null;
}

function nativePosition(
	shape: IndexedShape,
	target: number,
): {
	distanceAlongMeters: number;
	nativeShapeDistance: number;
} | null {
	for (let index = 0; index < shape.points.length - 1; index++) {
		const from = shape.points[index];
		const to = shape.points[index + 1];
		const fromNative = from.nativeShapeDistance;
		const toNative = to.nativeShapeDistance;
		if (fromNative == null || toNative == null || toNative <= fromNative) continue;
		const fraction = (target - fromNative) / (toNative - fromNative);
		if (fraction < -1e-6 || fraction > 1 + 1e-6) continue;
		const clamped = Math.max(0, Math.min(1, fraction));
		return {
			distanceAlongMeters:
				from.geometricDistanceMeters + clamped * (to.geometricDistanceMeters - from.geometricDistanceMeters),
			nativeShapeDistance: fromNative + clamped * (toNative - fromNative),
		};
	}
	return null;
}

function nearestProjection(shape: IndexedShape, stationId: string): StationProjection | null {
	return (
		[...(shape.projections.get(stationId) ?? [])].sort(
			(a, b) => a.lateralDistanceMeters - b.lateralDistanceMeters,
		)[0] ?? null
	);
}

function candidateCost(
	lateralDistanceMeters: number,
	nativeDistance: number | null,
	anchor: JourneyAnchor,
	shape: IndexedShape,
	options: ShapeAlignmentOptions,
): number {
	// A distant coordinate match should lose to an omitted anchor. The shape may
	// pass near an unrelated station at a junction or self-crossing, so a linear
	// distance cost would make a 200 m false match cheaper than a safe seam.
	let cost = lateralDistanceMeters + (lateralDistanceMeters * lateralDistanceMeters) / 100;
	const anchorNative = options.useNativeShapeDistance ? validDistance(anchor.shapeDistTraveled) : null;
	if (anchorNative != null && nativeDistance != null) {
		const nativeValues = shape.points
			.map((point) => point.nativeShapeDistance)
			.filter((value): value is number => value != null);
		const nativeScale = Math.max(1, (Math.max(...nativeValues) - Math.min(...nativeValues)) / 100);
		cost += Math.abs(anchorNative - nativeDistance) / nativeScale;
	}
	return cost;
}

function makeCandidates(
	anchor: JourneyAnchor,
	index: number,
	shape: IndexedShape,
	config: CorridorResolutionConfig,
	anchorCount: number,
	orientation: "forward" | "reverse",
	options: ShapeAlignmentOptions,
): AlignmentCandidate[] {
	if (!anchor.stationId) return [];
	const maxDistance = shape.scheduledStations.has(anchor.stationId)
		? config.geometry.exactShapeMembershipMaxMeters
		: config.geometry.compatibleShapeMaxMeters;
	const endpoint = index === 0 || index === anchorCount - 1;
	const candidates: AlignmentCandidate[] = [];
	const projections = shape.projections.get(anchor.stationId) ?? [];
	for (const projection of projections) {
		const allowedDistance = endpoint ? config.geometry.endpointSnapMaxMeters : maxDistance;
		if (projection.lateralDistanceMeters > allowedDistance) continue;
		const routeProgress =
			orientation === "forward"
				? projection.distanceAlongMeters
				: shape.lengthMeters - projection.distanceAlongMeters;
		candidates.push({
			key: `projection:${projection.segmentIndex}:${projection.segmentFraction}`,
			distanceAlongMeters: projection.distanceAlongMeters,
			routeProgress,
			lateralDistanceMeters: projection.lateralDistanceMeters,
			nativeShapeDistance: options.useNativeShapeDistance ? (projection.nativeShapeDistance ?? null) : null,
			coordinateSource: projection.coordinateSource,
			cost: candidateCost(
				projection.lateralDistanceMeters,
				options.useNativeShapeDistance ? (projection.nativeShapeDistance ?? null) : null,
				anchor,
				shape,
				options,
			),
		});
	}

	const anchorNative = options.useNativeShapeDistance ? validDistance(anchor.shapeDistTraveled) : null;
	if (anchorNative != null) {
		const native = nativePosition(shape, anchorNative);
		if (native) {
			const projection = nearestProjection(shape, anchor.stationId);
			candidates.push({
				key: `native:${native.distanceAlongMeters}`,
				distanceAlongMeters: native.distanceAlongMeters,
				routeProgress:
					orientation === "forward"
						? native.distanceAlongMeters
						: shape.lengthMeters - native.distanceAlongMeters,
				lateralDistanceMeters: projection?.lateralDistanceMeters ?? 0,
				nativeShapeDistance: native.nativeShapeDistance,
				coordinateSource: "native",
				cost: candidateCost(
					projection?.lateralDistanceMeters ?? 0,
					native.nativeShapeDistance,
					anchor,
					shape,
					options,
				),
			});
		}
	}

	const deduped = new Map<string, AlignmentCandidate>();
	for (const candidate of candidates) {
		const current = deduped.get(candidate.key);
		if (!current || candidate.cost < current.cost) deduped.set(candidate.key, candidate);
	}
	return [...deduped.values()];
}

interface AlignmentState {
	last: AlignmentCandidate | null;
	cost: number;
	matchedCount: number;
	choices: Array<AlignmentCandidate | null>;
}

function betterState(a: AlignmentState, b: AlignmentState): AlignmentState {
	if (Math.abs(a.cost - b.cost) > 1) return a.cost < b.cost ? a : b;
	if (a.matchedCount !== b.matchedCount) return a.matchedCount > b.matchedCount ? a : b;
	return a.cost <= b.cost ? a : b;
}

function solveOrientation(
	anchors: readonly JourneyAnchor[],
	shape: IndexedShape,
	config: CorridorResolutionConfig,
	orientation: "forward" | "reverse",
	options: ShapeAlignmentOptions,
): AlignmentState {
	let states: AlignmentState[] = [{ last: null, cost: 0, matchedCount: 0, choices: [] }];
	for (let index = 0; index < anchors.length; index++) {
		const candidates = makeCandidates(anchors[index], index, shape, config, anchors.length, orientation, options);
		const next = new Map<string, AlignmentState>();
		for (const state of states) {
			const skipped: AlignmentState = {
				last: state.last,
				cost: state.cost + 300,
				matchedCount: state.matchedCount,
				choices: [...state.choices, null],
			};
			const skippedKey = state.last?.key ?? "none";
			next.set(skippedKey, next.has(skippedKey) ? betterState(next.get(skippedKey)!, skipped) : skipped);

			for (const candidate of candidates) {
				if (state.last && candidate.routeProgress <= state.last.routeProgress + 2) continue;
				const resolved: AlignmentState = {
					last: candidate,
					cost: state.cost + candidate.cost,
					matchedCount: state.matchedCount + 1,
					choices: [...state.choices, candidate],
				};
				const key = candidate.key;
				next.set(key, next.has(key) ? betterState(next.get(key)!, resolved) : resolved);
			}
		}
		states = [...next.values()];
	}
	return states.reduce(betterState);
}

function toAlignment(
	state: AlignmentState,
	anchors: readonly JourneyAnchor[],
	shape: IndexedShape,
	orientation: "forward" | "reverse",
	options: ShapeAlignmentOptions,
): ShapeAlignment {
	const aligned = new Map<number, AlignedAnchor>();
	for (let index = 0; index < state.choices.length; index++) {
		const candidate = state.choices[index];
		if (!candidate) continue;
		aligned.set(index, {
			index,
			anchor: anchors[index],
			distanceAlongMeters: candidate.routeProgress,
			lateralDistanceMeters: candidate.lateralDistanceMeters,
			nativeShapeDistance: candidate.nativeShapeDistance,
			coordinateSource: candidate.coordinateSource,
			nativeDistanceUsed:
				options.useNativeShapeDistance &&
				validDistance(anchors[index].shapeDistTraveled) != null &&
				validDistance(candidate.nativeShapeDistance) != null,
			cost: candidate.cost,
		});
	}
	return {
		orientation,
		anchors: aligned,
		matchedCount: state.matchedCount,
		score: state.cost,
		ambiguous: false,
	};
}

function hasComparableAlternative(
	anchors: readonly JourneyAnchor[],
	shape: IndexedShape,
	config: CorridorResolutionConfig,
	orientation: "forward" | "reverse",
	alignment: ShapeAlignment,
	options: ShapeAlignmentOptions,
): boolean {
	const matchedIndexes = [...alignment.anchors.keys()].sort((a, b) => a - b);
	for (const index of matchedIndexes) {
		const selected = alignment.anchors.get(index)!;
		const candidates = makeCandidates(anchors[index], index, shape, config, anchors.length, orientation, options);
		const previousIndex = [...matchedIndexes].reverse().find((candidateIndex) => candidateIndex < index);
		const nextIndex = matchedIndexes.find((candidateIndex) => candidateIndex > index);
		const previous = previousIndex === undefined ? null : alignment.anchors.get(previousIndex)!;
		const next = nextIndex === undefined ? null : alignment.anchors.get(nextIndex)!;
		if (
			candidates.some(
				(candidate) =>
					Math.abs(candidate.routeProgress - selected.distanceAlongMeters) > 5 &&
					Math.abs(candidate.cost - selected.cost) <= 1 &&
					(!previous || candidate.routeProgress > previous.distanceAlongMeters + 2) &&
					(!next || candidate.routeProgress < next.distanceAlongMeters - 2),
			)
		)
			return true;
	}
	return false;
}

/** Align the ordered journey anchors to one shape with monotonic dynamic programming. */
export function alignShapeAnchors(
	anchors: readonly JourneyAnchor[],
	shape: IndexedShape,
	config: CorridorResolutionConfig,
	options: ShapeAlignmentOptions,
): ShapeAlignment | null {
	if (anchors.length === 0 || shape.points.length < 2 || shape.lengthMeters <= 0) return null;
	const forward = toAlignment(
		solveOrientation(anchors, shape, config, "forward", options),
		anchors,
		shape,
		"forward",
		options,
	);
	const reverse = toAlignment(
		solveOrientation(anchors, shape, config, "reverse", options),
		anchors,
		shape,
		"reverse",
		options,
	);
	let selected: ShapeAlignment;
	if (Math.abs(forward.score - reverse.score) > 25) {
		selected = forward.score < reverse.score ? forward : reverse;
	} else if (forward.matchedCount !== reverse.matchedCount) {
		selected = forward.matchedCount > reverse.matchedCount ? forward : reverse;
	} else {
		selected = forward.score <= reverse.score ? forward : reverse;
		selected.ambiguous = true;
	}
	if (hasComparableAlternative(anchors, shape, config, selected.orientation, selected, options))
		selected.ambiguous = true;
	return selected;
}

export const _test = { nativePosition, makeCandidates, solveOrientation };
