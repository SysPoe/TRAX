import type { CorridorGapResolution, CorridorResolution, JourneyContext } from "./types.js";

/** Validate every candidate path before it can add a synthetic station. */
export function validateCorridorGap(
	gap: CorridorGapResolution,
	journey: JourneyContext,
): { valid: true } | { valid: false; diagnostic: string } {
	if (gap.status !== "resolved") return { valid: true };
	if (gap.nodes.length < 2) return { valid: false, diagnostic: "Resolved gap has no endpoint pair." };
	const first = gap.nodes[0];
	const last = gap.nodes[gap.nodes.length - 1];
	if (first.stationId !== gap.from.stationId || last.stationId !== gap.to.stationId) {
		return { valid: false, diagnostic: "Resolved gap endpoints do not match its anchors." };
	}
	const scheduledIds = new Set(
		journey.anchors
			.filter((anchor) => anchor.id !== gap.from.id && anchor.id !== gap.to.id)
			.map((anchor) => anchor.stationId)
			.filter((stationId): stationId is string => stationId !== null),
	);
	const seen = new Set<string>();
	let previousDistance = -Infinity;
	for (const [index, node] of gap.nodes.entries()) {
		if (node.stationId && node.passing) {
			if (seen.has(node.stationId))
				return { valid: false, diagnostic: "Resolved gap repeats a synthetic station." };
			if (scheduledIds.has(node.stationId)) {
				return { valid: false, diagnostic: "Resolved gap revisits another scheduled journey anchor." };
			}
			seen.add(node.stationId);
		}
		if (node.distanceAlongMeters != null) {
			if (node.distanceAlongMeters + 2 < previousDistance) {
				return { valid: false, diagnostic: "Resolved gap moves backwards along its corridor." };
			}
			previousDistance = node.distanceAlongMeters;
		}
		if (index > 0 && node.id === gap.nodes[index - 1].id) {
			return { valid: false, diagnostic: "Resolved gap duplicates an adjacent node." };
		}
	}
	return { valid: true };
}

/**
 * Apply journey-wide safety checks after each provider has resolved its gaps.
 * A station repeated by two independent gap candidates is safer to omit from
 * the later gap than to expose a duplicated synthetic stop.
 */
export function validateCorridorResolution(
	resolution: CorridorResolution,
	journey: JourneyContext,
): CorridorResolution {
	const seenSyntheticStations = new Set<string>();
	const gaps = resolution.gaps.map((gap) => {
		if (gap.status !== "resolved") return gap;
		const validation = validateCorridorGap(gap, journey);
		if (!validation.valid) {
			return {
				status: "unresolved" as const,
				from: gap.from,
				to: gap.to,
				nodes: [],
				diagnostic: validation.diagnostic,
			};
		}
		const syntheticStations = gap.nodes
			.filter((node) => node.passing && node.kind === "station" && node.stationId)
			.map((node) => node.stationId!);
		if (syntheticStations.some((stationId) => seenSyntheticStations.has(stationId))) {
			return {
				status: "unresolved" as const,
				from: gap.from,
				to: gap.to,
				nodes: [],
				diagnostic: "Resolved journey would repeat a synthetic station.",
			};
		}
		for (const stationId of syntheticStations) seenSyntheticStations.add(stationId);
		return gap;
	});
	return { ...resolution, gaps };
}
