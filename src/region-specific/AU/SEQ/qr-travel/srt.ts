import type { QRTStationDetails, QRTTrainMovementDTO } from "./types.js";
import { getDefaultTimeZone, canonicalStationIdentity } from "../../../../config.js";
import { getRawStops } from "../../../../cache/gtfsReads.js";
import type { CacheContext } from "../../../../cache/index.js";
import { entityKey, parseEntityKey, qualifiedKey } from "../../../../identity.js";
import {
	getCorridorTimingWeights,
	interpolateCorridorInstants,
	withCorridorTimingInstants,
} from "../../../../utils/corridor/timing.js";
import { geometryFeedIdsForFeed, resolveJourneyCorridor } from "../../../../utils/corridor/resolver.js";
import type { CorridorNode, JourneyContext } from "../../../../utils/corridor/types.js";
import { buildQRTStationLookupMap, normalizeQRTStationLookupKey } from "./stations.js";
import { getSeqState } from "../../../../plugins/seq-state.js";
import { getLocalISOString, parseTimeWithConfig } from "../../../../utils/time.js";
import { getQrtManualNetwork, manualNodeKind, QRT_MANUAL_FEED_ID, QRT_SOURCE_ID } from "./manual-network.js";
import type { SRTEntry } from "./manual-network.js";

export type { SRTEntry } from "./manual-network.js";
export { getQrtManualNetwork } from "./manual-network.js";

export interface QRTSRTStop {
	placeName: string;
	placeCode: string;
	sourceStopId: string | null;
	stationDetails?: QRTStationDetails;
	isStop: boolean;
	plannedArrival: string;
	plannedDeparture: string;
	actualArrival?: string;
	actualDeparture?: string;
	srtMinutes?: number;
	estimatedPassingTime?: string;
	arrivalDelaySeconds?: number | null;
	arrivalDelayClass?: "on-time" | "scheduled" | "late" | "very-late" | "early";
	arrivalDelayString?: "on time" | string;
	departureDelaySeconds?: number | null;
	departureDelayClass?: "on-time" | "scheduled" | "late" | "very-late" | "early";
	departureDelayString?: "on time" | string;
}

const INVALID_QRT_TIME = "0001-01-01T00:00:00";

function qrtGeometryFeedIds(ctx: CacheContext): string[] {
	const configured = geometryFeedIdsForFeed(ctx, QRT_MANUAL_FEED_ID).filter(
		(feedId) => feedId !== QRT_MANUAL_FEED_ID,
	);
	return configured;
}

function sourceStationId(sourceStopId: string | null, ctx: CacheContext): string | null {
	if (!sourceStopId) return null;
	const raw = qrtGeometryFeedIds(ctx).flatMap((feedId) =>
		getRawStops(ctx, { feed_id: feedId, stop_id: sourceStopId }),
	)[0];
	if (!raw) return null;
	return entityKey(
		canonicalStationIdentity(ctx.config, {
			feedId: raw.feed_id,
			localId: raw.parent_station || raw.stop_id,
		}),
	);
}

function stationDetailsForNode(node: CorridorNode, ctx: CacheContext): QRTStationDetails | undefined {
	const state = getSeqState(ctx);
	const lookup = buildQRTStationLookupMap(state.qrtStations);
	if (node.stationId) {
		try {
			const station = parseEntityKey(node.stationId);
			const byStop = lookup.get(station.localId);
			if (byStop) return byStop;
		} catch {
			// A manual station can have no feed-qualified GTFS identity.
		}
	}
	if (!node.name) return undefined;
	return lookup.get(normalizeQRTStationLookupKey(node.name));
}

function placeCodeForNode(node: CorridorNode, details: QRTStationDetails | undefined, ctx: CacheContext): string {
	if (details?.qrt_PlaceCode) return details.qrt_PlaceCode;
	const target = normalizeQRTStationLookupKey(node.name ?? "");
	return (
		getSeqState(ctx).qrtPlaces.find((place) => normalizeQRTStationLookupKey(place.Title) === target)
			?.qrt_PlaceCode ?? ""
	);
}

function validTime(value: string | undefined, config: CacheContext["config"]): number | null {
	if (!value || value === INVALID_QRT_TIME) return null;
	const parsed = parseTimeWithConfig(value, getDefaultTimeZone(config));
	return Number.isFinite(parsed) && parsed !== 0 ? parsed : null;
}

function delaySeconds(
	actual: string | undefined,
	planned: string | undefined,
	config: CacheContext["config"],
): number | null {
	const actualMs = validTime(actual, config);
	const plannedMs = validTime(planned, config);
	return actualMs != null && plannedMs != null ? Math.round((actualMs - plannedMs) / 1000) : null;
}

function delayInfo(delay: number | null): {
	delayString: string;
	delayClass: "on-time" | "scheduled" | "late" | "very-late" | "early";
} {
	if (delay == null) return { delayString: "scheduled", delayClass: "scheduled" };
	if (delay === 0) return { delayString: "on time", delayClass: "on-time" };
	const minutes = Math.max(1, Math.round(Math.abs(delay) / 60));
	return {
		delayString: `${minutes}m ${delay > 0 ? "late" : "early"}`,
		delayClass: delay > 300 ? "very-late" : delay > 0 ? "late" : "early",
	};
}

function scheduledOutput(movement: QRTTrainMovementDTO, ctx: CacheContext): QRTSRTStop {
	const arrivalDelaySeconds = delaySeconds(movement.ActualArrival, movement.PlannedArrival, ctx.config);
	const departureDelaySeconds = delaySeconds(movement.ActualDeparture, movement.PlannedDeparture, ctx.config);
	const arrival = delayInfo(arrivalDelaySeconds);
	const departure = delayInfo(departureDelaySeconds);
	return {
		placeName: movement.PlaceName,
		placeCode: movement.PlaceCode,
		sourceStopId: movement.sourceStopId,
		stationDetails: movement.stationDetails,
		isStop: true,
		plannedArrival: movement.PlannedArrival,
		plannedDeparture: movement.PlannedDeparture,
		actualArrival: movement.ActualArrival,
		actualDeparture: movement.ActualDeparture,
		arrivalDelaySeconds,
		arrivalDelayClass: arrival.delayClass,
		arrivalDelayString: arrival.delayString,
		departureDelaySeconds,
		departureDelayClass: departure.delayClass,
		departureDelayString: departure.delayString,
	};
}

function syntheticOutput(
	node: CorridorNode,
	minutes: number | undefined,
	passingTime: number | undefined,
	ctx: CacheContext,
): QRTSRTStop {
	const details = stationDetailsForNode(node, ctx);
	let sourceStopId: string | null = null;
	if (node.stationId) {
		try {
			const identity = parseEntityKey(node.stationId);
			if (qrtGeometryFeedIds(ctx).includes(identity.feedId)) sourceStopId = identity.localId;
		} catch {
			// A manual station can have no feed-qualified GTFS identity.
		}
	}
	return {
		placeName: node.name ?? details?.Title ?? "",
		placeCode: placeCodeForNode(node, details, ctx),
		sourceStopId,
		stationDetails: details,
		isStop: false,
		plannedArrival: INVALID_QRT_TIME,
		plannedDeparture: INVALID_QRT_TIME,
		srtMinutes: minutes,
		estimatedPassingTime:
			passingTime != null ? getLocalISOString(new Date(passingTime), getDefaultTimeZone(ctx.config)) : undefined,
		arrivalDelaySeconds: null,
		departureDelaySeconds: null,
	};
}

function qrtDate(value: string): string | null {
	const isoLike = value.match(/\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b/);
	if (isoLike) {
		return `${isoLike[1]}${isoLike[2].padStart(2, "0")}${isoLike[3].padStart(2, "0")}`;
	}
	const monthFirst = value.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
	if (monthFirst) {
		return `${monthFirst[3]}${monthFirst[1].padStart(2, "0")}${monthFirst[2].padStart(2, "0")}`;
	}
	const digits = value.replace(/\D/g, "");
	return /^\d{8}/.test(digits) ? digits.slice(0, 8) : null;
}

function qrtJourney(
	stoppingMovements: readonly QRTTrainMovementDTO[],
	metadata: { serviceId?: string; serviceDate?: string; line?: string; direction?: string },
	ctx: CacheContext,
): JourneyContext {
	return {
		sourceId: QRT_SOURCE_ID,
		feedId: QRT_MANUAL_FEED_ID,
		tripId: metadata.serviceId ?? "qrt-live",
		routeId: metadata.line ?? null,
		direction: metadata.direction ?? null,
		shapeId: null,
		serviceDate: metadata.serviceDate ? qrtDate(metadata.serviceDate) : null,
		anchors: stoppingMovements.map((movement, sequence) => {
			const stationId = sourceStationId(movement.sourceStopId, ctx);
			const details = movement.stationDetails;
			return {
				id: qualifiedKey(QRT_MANUAL_FEED_ID, `${metadata.serviceId ?? "live"}\0${sequence}`),
				stationId,
				name: movement.PlaceName,
				lat: details?.lat != null && Number.isFinite(Number(details.lat)) ? Number(details.lat) : null,
				lon: details?.lng != null && Number.isFinite(Number(details.lng)) ? Number(details.lng) : null,
				sequence,
				scheduled: true,
			};
		}),
		geometryFeedIds: qrtGeometryFeedIds(ctx),
	};
}

/** Resolve QRT's live movements through the same generic corridor resolver as GTFS trips. */
export function expandWithSRTPassingStops(
	stoppingMovements: QRTTrainMovementDTO[],
	ctx: CacheContext,
	metadata: { serviceId?: string; serviceDate?: string; line?: string; direction?: string } = {},
): QRTSRTStop[] {
	if (stoppingMovements.length === 0) return [];
	const journey = qrtJourney(stoppingMovements, metadata, ctx);
	const corridor = resolveJourneyCorridor(journey, ctx);
	const result: QRTSRTStop[] = [scheduledOutput(stoppingMovements[0], ctx)];
	for (let gapIndex = 0; gapIndex < stoppingMovements.length - 1; gapIndex++) {
		const gap = corridor.gaps[gapIndex];
		if (gap?.status === "resolved") {
			const from = stoppingMovements[gapIndex];
			const to = stoppingMovements[gapIndex + 1];
			const start = validTime(from.ActualDeparture, ctx.config) ?? validTime(from.PlannedDeparture, ctx.config);
			const end = validTime(to.ActualArrival, ctx.config) ?? validTime(to.PlannedArrival, ctx.config);
			const timing = getCorridorTimingWeights(gap.nodes, journey, ctx.augmented.corridorIndex, ctx);
			const timed = withCorridorTimingInstants(timing, interpolateCorridorInstants(start, end, timing.weights));
			for (const record of timed.records) {
				if (!record.node.passing || record.node.kind !== "station") continue;
				result.push(
					syntheticOutput(
						record.node,
						record.precedingMinutes ?? undefined,
						record.instant ?? undefined,
						ctx,
					),
				);
			}
		}
		result.push(scheduledOutput(stoppingMovements[gapIndex + 1], ctx));
	}
	return result;
}

export const _test = { getQrtManualNetwork, manualNodeKind, qrtDate, delayInfo };
