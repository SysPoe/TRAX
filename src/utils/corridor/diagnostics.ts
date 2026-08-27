import logger from "../logger.js";
import type { CacheContext } from "../../cache/types.js";
import type { CorridorEvidence, CorridorResolution, JourneyContext } from "./types.js";

export interface CorridorGapDiagnostic {
	from: string;
	to: string;
	status: "resolved" | "unresolved";
	evidence?: CorridorEvidence;
	confidence?: "high" | "medium" | "low";
	diagnostic?: string;
	resolvedStations: string[];
}

export interface CorridorResolutionDiagnostics {
	sourceId: string;
	feedId: string;
	tripId: string;
	shapeId: string | null;
	gaps: CorridorGapDiagnostic[];
	evidenceCounts: Partial<Record<CorridorEvidence, number>>;
	resolvedGapCount: number;
	unresolvedGapCount: number;
}

/** Convert a resolution to a structured record suitable for logs or shadow comparison. */
export function describeCorridorResolution(
	journey: JourneyContext,
	resolution: CorridorResolution,
): CorridorResolutionDiagnostics {
	const evidenceCounts: Partial<Record<CorridorEvidence, number>> = {};
	const gaps = resolution.gaps.map((gap) => {
		if (gap.evidence) evidenceCounts[gap.evidence] = (evidenceCounts[gap.evidence] ?? 0) + 1;
		return {
			from: gap.from.stationId ?? gap.from.id,
			to: gap.to.stationId ?? gap.to.id,
			status: gap.status,
			evidence: gap.evidence,
			confidence: gap.confidence,
			diagnostic: gap.diagnostic,
			resolvedStations: gap.nodes
				.filter((node) => node.passing && node.kind === "station")
				.map((node) => node.stationId ?? node.id),
		};
	});
	return {
		sourceId: journey.sourceId,
		feedId: journey.feedId,
		tripId: journey.tripId,
		shapeId: journey.shapeId,
		gaps,
		evidenceCounts,
		resolvedGapCount: gaps.filter((gap) => gap.status === "resolved").length,
		unresolvedGapCount: gaps.filter((gap) => gap.status === "unresolved").length,
	};
}

/** Log one resolution when corridor diagnostics are enabled. */
export function logCorridorResolution(
	journey: JourneyContext,
	resolution: CorridorResolution,
	ctx: CacheContext,
): void {
	if (!ctx.config.corridor.diagnostics) return;
	logger.debug(JSON.stringify(describeCorridorResolution(journey, resolution)), {
		module: "corridor",
		function: "resolveJourneyCorridor",
	});
}

/** Compare a legacy station sequence with the resolved station sequence gap by gap. */
export function compareLegacyCorridor(
	journey: JourneyContext,
	resolution: CorridorResolution,
	legacyGaps: readonly (readonly string[])[],
): Array<{ gap: [string, string]; legacy: string[]; resolved: string[] }> {
	const differences: Array<{ gap: [string, string]; legacy: string[]; resolved: string[] }> = [];
	for (let index = 0; index < resolution.gaps.length; index++) {
		const gap = resolution.gaps[index];
		const resolved = gap.nodes
			.filter((node) => node.passing && node.kind === "station")
			.map((node) => node.stationId ?? node.id);
		const legacy = [...(legacyGaps[index] ?? [])];
		if (legacy.join("|") !== resolved.join("|")) {
			differences.push({
				gap: [gap.from.stationId ?? gap.from.id, gap.to.stationId ?? gap.to.id],
				legacy,
				resolved,
			});
		}
	}
	return differences;
}
