import * as qdf from "qdf-gtfs";
import { getSRT } from "../SRT.js";
import type { CacheContext } from "../../cache/types.js";
import { getCachedActivePatterns } from "./patternIndex.js";
import { manualEdgeMinutes } from "./manualNetwork.js";
import type { CorridorGapResolution, CorridorNode, JourneyContext } from "./types.js";
import type { CorridorIndex } from "./shapeIndex.js";
import { parseEntityKey } from "../../identity.js";
import { qualifiedRouteDirectionKey } from "./keys.js";
import { interpolateTimes } from "../interpolateTimes.js";

export type StopTimeWithPassingMeta = qdf.StopTime & {
	_passing?: boolean;
	_segmentEmus?: number[];
};

export interface CorridorTimingRecord {
	node: CorridorNode;
	/** Weight of the visible leg immediately before this node. */
	precedingWeight: number | null;
	/** Configured/observed duration of the visible leg, when one is known. */
	precedingMinutes: number | null;
	/** Interpolated instant for an interior node, or null for endpoints. */
	instant: number | null;
}

export interface CorridorTiming {
	records: CorridorTimingRecord[];
	/** One weight for each leg between consecutive visible station records. */
	weights: number[];
}

function positive(value: number | null | undefined): number | null {
	return value != null && Number.isFinite(value) && value > 0 ? value : null;
}

function patternEdgeKey(fromStationId: string, toStationId: string): string {
	return `${fromStationId}\0${toStationId}`;
}

function patternEdgeMinutesIndex(
	journey: JourneyContext,
	index: CorridorIndex,
	ctx: CacheContext,
): ReadonlyMap<string, number> {
	const routeDirectionKey = qualifiedRouteDirectionKey(journey.feedId, journey.routeId, journey.direction);
	const cacheKey = `${routeDirectionKey}\0${journey.serviceDate ?? "*"}`;
	const cached = ctx.augmented.corridorPatternEdgeMinutesCache.get(cacheKey);
	if (cached) return cached;
	const scopedPatterns =
		journey.routeId === null
			? index.patterns
			: (index.patternsByRouteDirection.get(routeDirectionKey) ?? []);
	const valuesByEdge = new Map<string, number[]>();
	for (const pattern of getCachedActivePatterns(scopedPatterns, journey, ctx)) {
		for (let position = 1; position < pattern.stations.length; position++) {
			const value = positive(pattern.edgeMinutes?.[position - 1]);
			if (value == null) continue;
			const key = patternEdgeKey(pattern.stations[position - 1], pattern.stations[position]);
			const values = valuesByEdge.get(key) ?? [];
			values.push(value);
			valuesByEdge.set(key, values);
		}
	}
	const result = new Map<string, number>();
	for (const [key, values] of valuesByEdge) {
		values.sort((a, b) => a - b);
		result.set(key, values[Math.floor(values.length / 2)]);
	}
	ctx.augmented.corridorPatternEdgeMinutesCache.set(cacheKey, result);
	return result;
}

function patternEdgeMinutes(
	from: CorridorNode,
	to: CorridorNode,
	patternMinutes: ReadonlyMap<string, number>,
): number | null {
	if (!from.stationId || !to.stationId) return null;
	return patternMinutes.get(patternEdgeKey(from.stationId, to.stationId)) ?? null;
}

interface LegTiming {
	weight: number;
	minutes: number | null;
}

function legTiming(
	from: CorridorNode,
	to: CorridorNode,
	journey: JourneyContext,
	ctx: CacheContext,
	patternMinutes: ReadonlyMap<string, number>,
): LegTiming {
	const manual = positive(manualEdgeMinutes(from.id, to.id, ctx.config.corridor, journey));
	if (manual != null) return { weight: manual, minutes: manual };
	const pattern = patternEdgeMinutes(from, to, patternMinutes);
	if (pattern != null) return { weight: pattern, minutes: pattern };
	// The generated SRT matrix is feed-wide physical-edge evidence. Scoped
	// pattern observations above it keep another route's runtime from changing
	// interpolation on this journey.
	const srt = ctx.gtfs && from.stationId && to.stationId ? positive(getSRT(from.stationId, to.stationId, ctx)) : null;
	if (srt != null) return { weight: srt, minutes: srt };
	const distance =
		from.distanceAlongMeters != null && to.distanceAlongMeters != null
			? positive(Math.abs(to.distanceAlongMeters - from.distanceAlongMeters))
			: null;
	return { weight: distance ?? 1, minutes: null };
}

function visiblePathWeights(
	nodes: readonly CorridorNode[],
	journey: JourneyContext,
	index: CorridorIndex,
	ctx: CacheContext,
): CorridorTiming {
	const visible: CorridorNode[] = [];
	const weights: number[] = [];
	const minutes: Array<number | null> = [];
	const patternMinutes = patternEdgeMinutesIndex(journey, index, ctx);
	let accumulated = 0;
	let accumulatedMinutes: number | null = 0;
	let previous: CorridorNode | null = null;
	for (const node of nodes) {
		if (previous) {
			const leg = legTiming(previous, node, journey, ctx, patternMinutes);
			accumulated += leg.weight;
			if (leg.minutes == null) accumulatedMinutes = null;
			else if (accumulatedMinutes != null) accumulatedMinutes += leg.minutes;
		}
		previous = node;
		if (node.kind !== "station") continue;
		if (visible.length > 0) {
			weights.push(Math.max(accumulated, 0.001));
			minutes.push(accumulatedMinutes != null && accumulatedMinutes > 0 ? accumulatedMinutes : null);
			accumulated = 0;
			accumulatedMinutes = 0;
		}
		visible.push(node);
	}
	return {
		records: visible.map((node, index) => ({
			node,
			precedingWeight: index === 0 ? null : (weights[index - 1] ?? null),
			precedingMinutes: index === 0 ? null : (minutes[index - 1] ?? null),
			instant: null,
		})),
		weights,
	};
}

/** Attach interpolation results to their visible node records by position. */
export function withCorridorTimingInstants(timing: CorridorTiming, instants: readonly number[]): CorridorTiming {
	return {
		...timing,
		records: timing.records.map((record, index) => ({
			...record,
			instant: index === 0 || index === timing.records.length - 1 ? null : (instants[index - 1] ?? null),
		})),
	};
}

/** Return timing weights after hiding operational waypoints from passengers. */
export function getCorridorTimingWeights(
	nodes: readonly CorridorNode[],
	journey: JourneyContext,
	index: CorridorIndex,
	ctx: CacheContext,
): CorridorTiming {
	return visiblePathWeights(nodes, journey, index, ctx);
}

function interpolatedTimes(from: qdf.StopTime, to: qdf.StopTime, weights: readonly number[]): number[] {
	const start = from.departure_time ?? from.arrival_time;
	const end = to.arrival_time ?? to.departure_time;
	if (start == null || end == null || end <= start || weights.length === 0) return [];
	return interpolateTimes(start, end, weights);
}

/** Interpolate one corridor segment with the same weights used by GTFS rows. */
export function interpolateCorridorTimes(from: qdf.StopTime, to: qdf.StopTime, weights: readonly number[]): number[] {
	return interpolatedTimes(from, to, weights);
}

/** Interpolate wall-clock milliseconds for a provider adapter. */
export function interpolateCorridorInstants(
	start: number | null,
	end: number | null,
	weights: readonly number[],
): number[] {
	if (
		start == null ||
		end == null ||
		!Number.isFinite(start) ||
		!Number.isFinite(end) ||
		end <= start ||
		weights.length === 0
	)
		return [];
	const total = weights.reduce((sum, weight) => sum + Math.max(weight, 0.001), 0);
	let elapsed = 0;
	const result: number[] = [];
	for (let index = 0; index < weights.length - 1; index++) {
		const weight = weights[index];
		elapsed += Math.max(weight, 0.001);
		result.push(start + ((end - start) * elapsed) / total);
	}
	return result;
}

function syntheticStopTime(
	node: CorridorNode,
	sequence: number,
	time: number | null,
	tripId: string,
	weights: readonly number[],
): StopTimeWithPassingMeta | null {
	if (!node.stationId) return null;
	let station;
	try {
		station = parseEntityKey(node.stationId);
	} catch {
		return null;
	}
	return {
		_passing: true,
		_segmentEmus: [...weights],
		stop_id: station.localId,
		trip_id: tripId,
		stop_sequence: sequence,
		arrival_time: time,
		departure_time: time,
		pickup_type: qdf.PickupType.None,
		drop_off_type: qdf.DropOffType.None,
		continuous_pickup: qdf.ContinuousPickup.None,
		continuous_drop_off: qdf.ContinuousDropOff.None,
		shape_dist_traveled: null,
		stop_headsign: null,
		timepoint: 0,
		feed_id: station.feedId,
	};
}

/** Expand only resolved corridor gaps into synthetic GTFS stop-time rows. */
export function expandStopTimesWithCorridor(
	stopTimes: readonly StopTimeWithPassingMeta[],
	journey: JourneyContext,
	corridor: { gaps: CorridorGapResolution[] },
	ctx: CacheContext,
): StopTimeWithPassingMeta[] {
	const sorted = [...stopTimes].sort((a, b) => a.stop_sequence - b.stop_sequence);
	if (sorted.length < 2) return sorted.map((stopTime) => ({ ...stopTime, _passing: false }));
	const index = ctx.augmented.corridorIndex;
	const result: StopTimeWithPassingMeta[] = [];
	result.push({ ...sorted[0], _passing: Boolean(sorted[0]._passing) });
	for (let gapIndex = 0; gapIndex < sorted.length - 1; gapIndex++) {
		const gap = corridor.gaps[gapIndex];
		if (
			gap?.status === "resolved" &&
			gap.nodes.some((node) => node.passing && node.kind === "station" && node.stationId)
		) {
			const timing = visiblePathWeights(gap.nodes, journey, index, ctx);
			const timed = withCorridorTimingInstants(
				timing,
				interpolatedTimes(sorted[gapIndex], sorted[gapIndex + 1], timing.weights),
			);
			const passingRecords = timed.records.filter(({ node }) => node.passing && node.stationId);
			for (let passingIndex = 0; passingIndex < passingRecords.length; passingIndex++) {
				const record = passingRecords[passingIndex];
				const sequence =
					sorted[gapIndex].stop_sequence +
					((passingIndex + 1) * (sorted[gapIndex + 1].stop_sequence - sorted[gapIndex].stop_sequence)) /
						(passingRecords.length + 1);
				const synthetic = syntheticStopTime(
					record.node,
					sequence,
					record.instant,
					sorted[0].trip_id,
					timing.weights,
				);
				if (synthetic) result.push(synthetic);
			}
		}
		result.push({ ...sorted[gapIndex + 1], _passing: Boolean(sorted[gapIndex + 1]._passing) });
	}
	return result;
}

export const _test = {
	patternEdgeMinutes,
	patternEdgeMinutesIndex,
	visiblePathWeights,
	interpolatedTimes,
	withCorridorTimingInstants,
};
