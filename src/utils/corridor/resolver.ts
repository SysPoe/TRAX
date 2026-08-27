import type { RealtimeTripUpdate, Stop, StopTime, Trip } from "qdf-gtfs";
import type { CacheContext } from "../../cache/types.js";
import { getRawStopTimes } from "../../cache/gtfsReads.js";
import { canonicalStationIdentity } from "../../config.js";
import { entityKey } from "../../identity.js";
import { corridorJourneyKey, qualifiedKey } from "./keys.js";
import { alignShapeAnchors, type ShapeAlignment } from "./alignShape.js";
import { findCompatibleShapes, type CompatibleShapeCandidate } from "./compatibleShapes.js";
import { resolveAuthoritativeManualGap, resolveFallbackManualGap } from "./manualNetwork.js";
import { resolvePatternGap } from "./patternResolver.js";
import { buildCorridorIndex, type CorridorIndex, type IndexedShape } from "./shapeIndex.js";
import { createShapeGapContext, resolveShapeGap, type ShapeGapContext } from "./resolveShapeGap.js";
import {
	createCorridorValidationContext,
	validateCorridorGap,
	validateCorridorResolution,
	type CorridorValidationContext,
} from "./validate.js";
import { logCorridorResolution } from "./diagnostics.js";
import type {
	CorridorConfidence,
	CorridorEvidence,
	CorridorGapResolution,
	CorridorNode,
	CorridorResolution,
	JourneyAnchor,
	JourneyContext,
} from "./types.js";

function stationKey(ctx: CacheContext, stop: Pick<Stop, "feed_id" | "stop_id" | "parent_station">): string {
	return entityKey(
		canonicalStationIdentity(ctx.config, {
			feedId: stop.feed_id,
			localId: stop.parent_station || stop.stop_id,
		}),
	);
}

function getStop(ctx: CacheContext, feedId: string, stopId: string): Stop | undefined {
	return (
		ctx.raw.stopsByKey.get(entityKey({ feedId, localId: stopId })) ??
		ctx.gtfs?.getStops({ feed_id: feedId, stop_id: stopId })[0]
	);
}

/** Return the geometry namespaces explicitly allowed for one journey feed. */
export function geometryFeedIdsForFeed(ctx: CacheContext, feedId: string): string[] {
	const source = ctx.config.corridor.geometrySources.find((candidate) => candidate.feedId === feedId);
	return [...new Set([feedId, ...(source?.borrowFromFeedIds ?? [])])];
}

function anchorFromStopTime(tripId: string, stopTime: StopTime, ctx: CacheContext): JourneyAnchor {
	const stop = getStop(ctx, stopTime.feed_id, stopTime.stop_id);
	const stationId = stationKey(
		ctx,
		stop ?? { feed_id: stopTime.feed_id, stop_id: stopTime.stop_id, parent_station: null },
	);
	const parent = stop?.parent_station ? getStop(ctx, stop.feed_id, stop.parent_station) : stop;
	return {
		id: qualifiedKey(stopTime.feed_id, `${tripId}\0${stopTime.stop_sequence}`),
		stationId,
		name: parent?.stop_name ?? stop?.stop_name,
		lat: stop?.stop_lat ?? parent?.stop_lat ?? null,
		lon: stop?.stop_lon ?? parent?.stop_lon ?? null,
		sequence: stopTime.stop_sequence,
		shapeDistTraveled: stopTime.shape_dist_traveled,
		scheduled: true,
	};
}

/** Convert one static GTFS trip into the provider-neutral journey interface. */
export function createJourneyContext(
	trip: Trip,
	stopTimes: readonly StopTime[],
	ctx: CacheContext,
	sourceId = "gtfs",
): JourneyContext {
	const anchors = [...stopTimes]
		.sort((a, b) => a.stop_sequence - b.stop_sequence)
		.map((stopTime) => anchorFromStopTime(trip.trip_id, stopTime, ctx));
	return {
		sourceId,
		feedId: trip.feed_id,
		tripId: trip.trip_id,
		routeId: trip.route_id ?? null,
		direction: trip.direction_id ?? null,
		shapeId: trip.shape_id ?? null,
		serviceDate: null,
		anchors,
		geometryFeedIds: geometryFeedIdsForFeed(ctx, trip.feed_id),
	};
}

/** Convert a realtime-only trip update into the provider-neutral journey interface. */
export function createRealtimeJourneyContext(
	update: RealtimeTripUpdate,
	ctx: CacheContext,
	sourceId = update.source_id || "gtfs-realtime",
): JourneyContext {
	const orderedUpdates = update.stop_time_updates
		.map((stopTime, index) => ({
			stopTime,
			index,
			sequence: Number.isFinite(stopTime.stop_sequence) ? stopTime.stop_sequence! : index + 1,
		}))
		.filter(({ stopTime }) => Boolean(stopTime.stop_id))
		.sort((a, b) => a.sequence - b.sequence || a.index - b.index);
	const anchors = orderedUpdates.map(({ stopTime, index, sequence }) => {
		const stop = getStop(ctx, update.feed_id, stopTime.stop_id);
		const stationId = stationKey(
			ctx,
			stop ?? { feed_id: update.feed_id, stop_id: stopTime.stop_id, parent_station: null },
		);
		const parent = stop?.parent_station ? getStop(ctx, stop.feed_id, stop.parent_station) : stop;
		return {
			id: qualifiedKey(update.feed_id, `${update.trip.trip_id}\0realtime\0${index}`),
			stationId,
			name: parent?.stop_name ?? stop?.stop_name,
			lat: stop?.stop_lat ?? parent?.stop_lat ?? null,
			lon: stop?.stop_lon ?? parent?.stop_lon ?? null,
			sequence,
			shapeDistTraveled: null,
			scheduled: true,
		} satisfies JourneyAnchor;
	});
	return {
		sourceId,
		feedId: update.feed_id,
		tripId: update.trip.trip_id,
		routeId: update.trip.route_id || null,
		direction: update.trip.direction_id ?? null,
		shapeId: null,
		serviceDate: update.trip.start_date,
		anchors,
		geometryFeedIds: geometryFeedIdsForFeed(ctx, update.feed_id),
	};
}

function configVersion(ctx: CacheContext): string {
	return JSON.stringify({
		version: ctx.config.corridor.version,
		geometry: ctx.config.corridor.geometry,
		geometrySources: ctx.config.corridor.geometrySources,
		manualNetworks: ctx.config.corridor.manualNetworks.map((network) => ({
			id: network.id,
			version: network.version ?? "1",
		})),
		minimumOutputConfidence: ctx.config.corridor.minimumOutputConfidence,
	});
}

function emptyGap(from: JourneyAnchor, to: JourneyAnchor, diagnostic: string): CorridorGapResolution {
	return { status: "unresolved", from, to, nodes: [], diagnostic };
}

function confidenceRank(confidence: CorridorConfidence): number {
	return confidence === "high" ? 3 : confidence === "medium" ? 2 : 1;
}

function meetsMinimumConfidence(gap: CorridorGapResolution, minimum: CorridorConfidence): boolean {
	return gap.status === "resolved" && confidenceRank(gap.confidence ?? "low") >= confidenceRank(minimum);
}

function alignmentCacheKey(
	anchors: readonly JourneyAnchor[],
	shape: IndexedShape,
	useNativeShapeDistance: boolean,
	ctx: CacheContext,
): string {
	return JSON.stringify([
		shape.key,
		useNativeShapeDistance,
		ctx.config.corridor.geometry,
		anchors.map((anchor) => [
			anchor.stationId,
			useNativeShapeDistance ? (anchor.shapeDistTraveled ?? null) : null,
		]),
	]);
}

function rebindAlignment(alignment: ShapeAlignment, anchors: readonly JourneyAnchor[]): ShapeAlignment {
	return {
		...alignment,
		anchors: new Map(
			[...alignment.anchors].map(([index, aligned]) => [index, { ...aligned, anchor: anchors[index] }]),
		),
	};
}

function alignShapeAnchorsCached(
	anchors: readonly JourneyAnchor[],
	shape: IndexedShape,
	useNativeShapeDistance: boolean,
	ctx: CacheContext,
): ShapeAlignment | null {
	const key = alignmentCacheKey(anchors, shape, useNativeShapeDistance, ctx);
	const cached = ctx.augmented.corridorAlignmentCache.get(key);
	if (cached) return rebindAlignment(cached, anchors);
	const alignment = alignShapeAnchors(anchors, shape, ctx.config.corridor, { useNativeShapeDistance });
	if (alignment) ctx.augmented.corridorAlignmentCache.set(key, alignment);
	return alignment;
}

function physicalResolutionCacheKey(journey: JourneyContext, shape: IndexedShape, ctx: CacheContext): string {
	return JSON.stringify([
		"exact-resolution",
		alignmentCacheKey(journey.anchors, shape, true, ctx),
		ctx.config.corridor.minimumOutputConfidence,
		ctx.config.corridor.version,
	]);
}

function nodesFromGaps(gaps: readonly CorridorGapResolution[]): CorridorNode[] {
	const nodes: CorridorNode[] = [];
	for (const gap of gaps) {
		if (gap.status !== "resolved") continue;
		for (const node of gap.nodes) {
			if (nodes.at(-1)?.id === node.id && nodes.at(-1)?.passing === node.passing) continue;
			nodes.push(node);
		}
	}
	return nodes;
}

function rebindPhysicalResolution(resolution: CorridorResolution, journey: JourneyContext): CorridorResolution {
	const gaps = resolution.gaps.map((gap, index) => {
		const from = journey.anchors[index];
		const to = journey.anchors[index + 1];
		if (!from || !to || gap.status !== "resolved") return { ...gap, from: from ?? gap.from, to: to ?? gap.to };
		const nodes = [...gap.nodes];
		if (nodes.length > 0) {
			nodes[0] = { ...nodes[0], id: from.stationId ?? from.id, stationId: from.stationId, name: from.name };
			nodes[nodes.length - 1] = {
				...nodes[nodes.length - 1],
				id: to.stationId ?? to.id,
				stationId: to.stationId,
				name: to.name,
			};
		}
		return { ...gap, from, to, nodes };
	});
	return { gaps, nodes: nodesFromGaps(gaps) };
}

function shapeGap(
	from: JourneyAnchor,
	to: JourneyAnchor,
	fromIndex: number,
	toIndex: number,
	shape: IndexedShape,
	alignment: ShapeAlignment | null,
	journey: JourneyContext,
	index: CorridorIndex,
	ctx: CacheContext,
	evidence: Extract<CorridorEvidence, "exact-shape" | "compatible-shape" | "borrowed-shape">,
	gapContext: ShapeGapContext | undefined,
	validationContext: CorridorValidationContext,
): CorridorGapResolution | null {
	if (!alignment) return null;
	const gap = resolveShapeGap(
		from,
		to,
		fromIndex,
		toIndex,
		shape,
		alignment,
		journey,
		index,
		ctx.config.corridor,
		evidence,
		gapContext,
	);
	if (!gap || !meetsMinimumConfidence(gap, ctx.config.corridor.minimumOutputConfidence)) return null;
	const validation = validateCorridorGap(gap, journey, validationContext);
	return validation.valid ? gap : null;
}

function resolveCompatibleGap(
	from: JourneyAnchor,
	to: JourneyAnchor,
	fromIndex: number,
	journey: JourneyContext,
	index: CorridorIndex,
	ctx: CacheContext,
	candidates: readonly CompatibleShapeCandidate[],
	validationContext: CorridorValidationContext,
): CorridorGapResolution | null {
	const resolved: Array<{
		gap: CorridorGapResolution;
		contextAlignment: ShapeAlignment | null;
		candidateScore: number;
		candidate: CompatibleShapeCandidate;
	}> = [];
	const suffixAlignmentFor = (candidate: CompatibleShapeCandidate): ShapeAlignment | null => {
		const suffixAlignment = alignShapeAnchorsCached(journey.anchors.slice(fromIndex), candidate.shape, false, ctx);
		return suffixAlignment &&
			!suffixAlignment.ambiguous &&
			suffixAlignment.anchors.has(0) &&
			suffixAlignment.anchors.has(1)
			? suffixAlignment
			: null;
	};
	for (const candidate of candidates) {
		// Candidate ranking uses the whole journey, but a partial shape must be
		// aligned locally. An unmatched anchor before this gap can otherwise
		// consume an early projection and move the seam anchor to a later loop
		// position, hiding valid interior stations from this gap.
		const localAlignment = alignShapeAnchorsCached([from, to], candidate.shape, false, ctx);
		const contextAlignment = !localAlignment || localAlignment.ambiguous ? suffixAlignmentFor(candidate) : null;
		const alignment = contextAlignment ?? localAlignment;
		const gap = shapeGap(
			from,
			to,
			0,
			1,
			candidate.shape,
			alignment,
			journey,
			index,
			ctx,
			candidate.evidence,
			undefined,
			validationContext,
		);
		if (gap) resolved.push({ gap, contextAlignment, candidateScore: candidate.score, candidate });
	}
	if (resolved.length === 0) return null;
	const signatures = new Set(
		resolved.map((candidate) => candidate.gap.nodes.map((node) => node.stationId ?? node.id).join("|")),
	);
	if (signatures.size === 1) return resolved[0].gap;

	// Only competing paths need whole-suffix context. Most compatible gaps have
	// one candidate or unanimous local evidence, so avoid allocating and solving
	// a dynamic-programming suffix for every candidate on every gap.
	for (const entry of resolved) {
		if (entry.contextAlignment) continue;
		const contextAlignment = suffixAlignmentFor(entry.candidate);
		if (!contextAlignment) continue;
		const contextualGap = shapeGap(
			from,
			to,
			0,
			1,
			entry.candidate.shape,
			contextAlignment,
			journey,
			index,
			ctx,
			entry.candidate.evidence,
			undefined,
			validationContext,
		);
		if (contextualGap) entry.gap = contextualGap;
		entry.contextAlignment = contextAlignment;
	}
	const contextualSignatures = new Set(
		resolved.map((candidate) => candidate.gap.nodes.map((node) => node.stationId ?? node.id).join("|")),
	);
	if (contextualSignatures.size === 1) return resolved[0].gap;

	// A later anchor can disambiguate two branch shapes, but only when one
	// candidate explains materially more of the ordered suffix (or does so at a
	// clearly lower projection cost). Otherwise preserve the conservative
	// unresolved result instead of choosing the highest-ranked shape arbitrarily.
	const contextual = resolved.filter((candidate) => candidate.contextAlignment);
	if (contextual.length < 2) return null;
	contextual.sort(
		(a, b) =>
			b.contextAlignment!.matchedCount - a.contextAlignment!.matchedCount ||
			a.contextAlignment!.score - b.contextAlignment!.score ||
			b.candidateScore - a.candidateScore,
	);
	const [best, runnerUp] = contextual;
	const bestAlignment = best.contextAlignment!;
	const runnerAlignment = runnerUp.contextAlignment!;
	if (bestAlignment.matchedCount > runnerAlignment.matchedCount || bestAlignment.score + 25 < runnerAlignment.score)
		return best.gap;
	return null;
}

function scheduledNode(
	anchor: JourneyAnchor,
	evidence: CorridorEvidence,
	confidence: CorridorConfidence,
): CorridorNode {
	return {
		id: anchor.stationId ?? anchor.id,
		stationId: anchor.stationId,
		name: anchor.name,
		kind: "station",
		scheduled: true,
		passing: false,
		evidence,
		confidence,
	};
}

function resolveOneGap(
	from: JourneyAnchor,
	to: JourneyAnchor,
	fromIndex: number,
	toIndex: number,
	journey: JourneyContext,
	index: CorridorIndex,
	ctx: CacheContext,
	exactShape: IndexedShape | null,
	exactAlignment: ShapeAlignment | null,
	exactGapContext: ShapeGapContext | undefined,
	compatibleCandidates: () => readonly CompatibleShapeCandidate[],
	validationContext: CorridorValidationContext,
): CorridorGapResolution {
	const exact = exactShape
		? shapeGap(
				from,
				to,
				fromIndex,
				toIndex,
				exactShape,
				exactAlignment,
				journey,
				index,
				ctx,
				"exact-shape",
				exactGapContext,
				validationContext,
			)
		: null;
	if (exact) return exact;

	const authoritativeManual = resolveAuthoritativeManualGap(from, to, journey, index, ctx.config.corridor);
	if (authoritativeManual && "ambiguous" in authoritativeManual)
		return emptyGap(from, to, "Authoritative manual topology has multiple plausible station paths.");
	if (authoritativeManual && "resolution" in authoritativeManual) {
		const validation = validateCorridorGap(authoritativeManual.resolution, journey, validationContext);
		if (
			validation.valid &&
			meetsMinimumConfidence(authoritativeManual.resolution, ctx.config.corridor.minimumOutputConfidence)
		)
			return authoritativeManual.resolution;
	}

	const compatible = resolveCompatibleGap(
		from,
		to,
		fromIndex,
		journey,
		index,
		ctx,
		compatibleCandidates(),
		validationContext,
	);
	if (compatible) return compatible;

	const fallbackManual = resolveFallbackManualGap(from, to, journey, index, ctx.config.corridor);
	if (fallbackManual && "resolution" in fallbackManual) {
		const validation = validateCorridorGap(fallbackManual.resolution, journey, validationContext);
		if (
			validation.valid &&
			meetsMinimumConfidence(fallbackManual.resolution, ctx.config.corridor.minimumOutputConfidence)
		) {
			return fallbackManual.resolution;
		}
	}
	if (fallbackManual && "ambiguous" in fallbackManual)
		return emptyGap(from, to, "Manual topology has multiple plausible station paths.");

	const pattern = resolvePatternGap(from, to, journey, index, ctx);
	if (pattern) {
		const validation = validateCorridorGap(pattern, journey, validationContext);
		if (validation.valid && meetsMinimumConfidence(pattern, ctx.config.corridor.minimumOutputConfidence))
			return pattern;
	}
	return emptyGap(from, to, "No unique shape, manual corridor, or active pattern explains this gap.");
}

function ensureIndex(ctx: CacheContext): CorridorIndex {
	if (!ctx.augmented.corridorIndex.built && ctx.raw.consideredTrips !== undefined && ctx.gtfs) {
		ctx.augmented.corridorIndex = buildCorridorIndex(ctx);
	}
	return ctx.augmented.corridorIndex;
}

/** Resolve every consecutive anchor pair using the strongest available evidence. */
export function resolveJourneyCorridor(journey: JourneyContext, ctx: CacheContext): CorridorResolution {
	const cacheKey = corridorJourneyKey({
		...journey,
		configVersion: configVersion(ctx),
	});
	const cached = ctx.augmented.corridorResolutionCache.get(cacheKey);
	if (cached) return cached;
	const index = ensureIndex(ctx);
	if (!ctx.config.corridor.enabled || journey.anchors.length < 2) {
		const disabled: CorridorResolution = {
			gaps: journey.anchors
				.slice(0, -1)
				.map((from, index) =>
					emptyGap(from, journey.anchors[index + 1], "Corridor resolver is disabled or has too few anchors."),
				),
			nodes: [],
		};
		ctx.augmented.corridorResolutionCache.set(cacheKey, disabled);
		return disabled;
	}

	const exactShape = journey.shapeId
		? (index.shapes.get(qualifiedKey(journey.feedId, journey.shapeId)) ?? null)
		: null;
	const physicalCacheKey = exactShape ? physicalResolutionCacheKey(journey, exactShape, ctx) : null;
	if (physicalCacheKey) {
		const physicalCached = ctx.augmented.corridorPhysicalResolutionCache.get(physicalCacheKey);
		if (physicalCached) {
			const rebound = rebindPhysicalResolution(physicalCached, journey);
			ctx.augmented.corridorResolutionCache.set(cacheKey, rebound);
			return rebound;
		}
	}
	const exactAlignment = exactShape ? alignShapeAnchorsCached(journey.anchors, exactShape, true, ctx) : null;
	const exactGapContext = exactAlignment ? createShapeGapContext(journey, exactAlignment) : undefined;
	const validationContext = createCorridorValidationContext(journey);
	let compatibleCandidates: CompatibleShapeCandidate[] | null = null;
	const getCompatibleCandidates = () => (compatibleCandidates ??= findCompatibleShapes(journey, index, ctx));
	const gaps: CorridorGapResolution[] = [];
	for (let anchorIndex = 0; anchorIndex < journey.anchors.length - 1; anchorIndex++) {
		gaps.push(
			resolveOneGap(
				journey.anchors[anchorIndex],
				journey.anchors[anchorIndex + 1],
				anchorIndex,
				anchorIndex + 1,
				journey,
				index,
				ctx,
				exactShape,
				exactAlignment,
				exactGapContext,
				getCompatibleCandidates,
				validationContext,
			),
		);
	}
	const validatedGaps = validateCorridorResolution({ gaps, nodes: [] }, journey, validationContext).gaps;
	const nodes = nodesFromGaps(validatedGaps);
	const result = { gaps: validatedGaps, nodes };
	ctx.augmented.corridorResolutionCache.set(cacheKey, result);
	if (
		physicalCacheKey &&
		validatedGaps.length === journey.anchors.length - 1 &&
		validatedGaps.every((gap) => gap.status === "resolved" && gap.evidence === "exact-shape")
	) {
		ctx.augmented.corridorPhysicalResolutionCache.set(physicalCacheKey, result);
	}
	logCorridorResolution(journey, result, ctx);
	return result;
}

/** Derive express segments from the same resolved corridor used for passing stops. */
export function expressInfoFromCorridor(resolution: CorridorResolution): Array<{
	type: "express" | "local" | "unknown_segment";
	from: string;
	to: string;
	skipping?: string[];
	message?: string;
}> {
	return resolution.gaps.map((gap) => {
		const from = gap.from.stationId ?? gap.from.id;
		const to = gap.to.stationId ?? gap.to.id;
		if (gap.status !== "resolved") {
			return {
				type: "unknown_segment",
				from,
				to,
				message: gap.diagnostic ?? "Unresolved physical corridor gap.",
			};
		}
		const skipping = gap.nodes
			.filter((node) => node.passing && node.kind === "station" && node.stationId)
			.map((node) => node.stationId!);
		return skipping.length > 0 ? { type: "express", from, to, skipping } : { type: "local", from, to };
	});
}

export const _test = {
	configVersion,
	confidenceRank,
	resolveCompatibleGap,
	alignmentCacheKey,
	physicalResolutionCacheKey,
	rebindPhysicalResolution,
};
