/**
 * Pure, testable resolver that maps a phone GPS observation (with NASID) to a TRAX trip instance.
 * No database, SvelteKit, or plugin state access. Deterministic and versioned.
 *
 * Responsibilities:
 * - candidate window filtering (time + radius)
 * - scoring (distance 55%, time 20%, bearing 10%, alias 10%, continuity 5%)
 * - decision threshold (0.75 + 0.15 margin)
 * - block extraction (gtfs vs seq-diagram provenance)
 * - confidence + reason codes
 *
 * Candidate-to-trip-instance resolution is delegated via `resolveInstance` to avoid
 * ad-hoc ID concatenation; if not supplied, IDs are derived from the candidate descriptor.
 */

import { encodeTripInstanceId } from "./identity.js";
import type { AugmentedTripInstance } from "./utils/augmentedTrip.js";

export const QRT_WIFI_RESOLVER_VERSION = "1.0.0";

export interface VehicleObservation {
  observedAt: string; // ISO instant
  latitude: number;
  longitude: number;
  accuracyM: number;
  bearingDeg?: number | null;
  speedMps?: number | null;
  nasidNormalized: string;
}

export interface VehicleObservationCandidate {
  feedId: string;
  tripId: string;
  tripStartDate?: string | null; // YYYYMMDD
  tripStartTime?: string | null; // HH:MM:SS, may be >24:00
  vehicleId?: string | null;
  latitude: number;
  longitude: number;
  bearing?: number | null;
  speed?: number | null;
  positionAsOf: string; // ISO instant when vehicle position was observed
  snapshotAt: string; // ISO instant when snapshot was taken
  aliasConfidence?: number | null; // 0..1 if NASID alias matches this vehicle
}

export interface VehicleObservationResolution {
  status: "matched" | "ambiguous" | "unmatched";
  tripInstanceId: string | null;
  tripId: string | null;
  vehicleId: string | null;
  gtfsBlockId: string | null;
  seqDiagramBlockId: string | null;
  effectiveBlockId: string | null;
  blockIdSource: "gtfs" | "seq-diagram" | null;
  confidence: number;
  distanceM: number | null;
  candidateCount: number;
  reasons: string[];
}

export interface ResolverConfig {
  /** ± seconds around observation for candidate position */
  timeWindowSeconds: number;
  /** base radius metres when accuracy is perfect */
  baseRadiusM: number;
  /** multiplier for accuracy-based radius */
  accuracyMultiplier: number;
  /** match threshold 0..1 */
  matchThreshold: number;
  /** required margin over second-best */
  marginThreshold: number;
  /** max accuracy before GPS_ACCURACY_LOW */
  maxAccuracyM: number;
  /** scoring weights, must sum to 1 */
  weights: {
    distance: number;
    time: number;
    bearing: number;
    alias: number;
    continuity: number;
  };
}

export const DEFAULT_RESOLVER_CONFIG: ResolverConfig = {
  timeWindowSeconds: 120,
  baseRadiusM: 300,
  accuracyMultiplier: 2,
  matchThreshold: 0.75,
  marginThreshold: 0.15,
  maxAccuracyM: 250,
  weights: {
    distance: 0.55,
    time: 0.2,
    bearing: 0.1,
    alias: 0.1,
    continuity: 0.05,
  },
};

export type ResolveInstanceFn = (
  candidate: VehicleObservationCandidate,
) => { instance: AugmentedTripInstance | null; tripInstanceId: string | null };

export interface ResolveOptions {
  config?: Partial<ResolverConfig>;
  /** continuity: adjacent observations in same session that already resolved to a vehicle/trip */
  sessionContinuity?: { vehicleId?: string | null; tripInstanceId?: string | null } | null;
  /** custom instance resolver (uses TRAX identity logic when supplied) */
  resolveInstance?: ResolveInstanceFn;
  /** networkId used when synthesizing instance IDs */
  networkId?: string;
}

// Haversine distance in metres
export function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function bearingDiff(a: number | null | undefined, b: number | null | undefined): number | null {
  if (a == null || b == null) return null;
  const diff = Math.abs(((a - b + 540) % 360) - 180); // 0..180
  return diff;
}

function parseInstant(value: string): number {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : NaN;
}

function normalizeTripStartDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, "");
  if (/^\d{8}$/.test(digits)) return digits;
  return null;
}

function normalizeTripStartTime(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = value.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return value;
  const h = String(Number(m[1])).padStart(2, "0");
  const mm = m[2];
  const ss = m[3] ?? "00";
  return `${h}:${mm}:${ss}`;
}

function effectiveBlock(
  gtfsBlockId: string | null,
  seqDiagramBlockId: string | null,
): { effective: string | null; source: "gtfs" | "seq-diagram" | null } {
  const gtfs = gtfsBlockId?.trim() ? gtfsBlockId : null;
  if (gtfs) return { effective: gtfs, source: "gtfs" };
  const seq = seqDiagramBlockId?.trim() ? seqDiagramBlockId : null;
  if (seq) return { effective: seq, source: "seq-diagram" };
  return { effective: null, source: null };
}

function scoreCandidate(
  observation: VehicleObservation,
  candidate: VehicleObservationCandidate,
  config: ResolverConfig,
  distanceM: number,
  radiusM: number,
  timeDeltaSec: number,
  continuityVehicleId: string | null | undefined,
): { score: number; components: { distance: number; time: number; bearing: number; alias: number; continuity: number }; reasons: string[] } {
  const distanceScore = Math.max(0, 1 - distanceM / radiusM);
  const timeScore = Math.max(0, 1 - Math.abs(timeDeltaSec) / config.timeWindowSeconds);
  const bDiff = bearingDiff(observation.bearingDeg, candidate.bearing);
  const bearingScore = bDiff == null ? 0.5 : Math.max(0, 1 - bDiff / 180);
  const aliasScore = candidate.aliasConfidence != null ? Math.max(0, Math.min(1, candidate.aliasConfidence)) : 0;
  const continuityScore =
    continuityVehicleId && candidate.vehicleId && continuityVehicleId === candidate.vehicleId ? 1 : 0;

  const { distance: wD, time: wT, bearing: wB, alias: wA, continuity: wC } = config.weights;
  const score = wD * distanceScore + wT * timeScore + wB * bearingScore + wA * aliasScore + wC * continuityScore;

  const reasons: string[] = [];
  if (aliasScore > 0) reasons.push("ALIAS_MATCH");
  if (continuityScore > 0) reasons.push("SESSION_CONTINUITY");
  if (bDiff != null && bDiff < 30) reasons.push("BEARING_AGREEMENT");
  if (bDiff != null && bDiff > 90) reasons.push("BEARING_DISAGREEMENT");

  return { score, components: { distance: distanceScore, time: timeScore, bearing: bearingScore, alias: aliasScore, continuity: continuityScore }, reasons };
}

function synthesizeTripInstanceId(candidate: VehicleObservationCandidate, networkId: string): string | null {
  const date = normalizeTripStartDate(candidate.tripStartDate ?? null);
  const time = normalizeTripStartTime(candidate.tripStartTime ?? null);
  // For feed-qualified collisions we use the feed in the instance id via TRAX identity codec; fallback to synthesize with feed prefix
  try {
    return encodeTripInstanceId({
      networkId,
      feedId: candidate.feedId,
      kind: "trip" as const,
      localId: candidate.tripId,
      serviceDate: date ?? "19700101",
      realtimeStartTime: time ?? "",
    });
  } catch {
    return null;
  }
}

export function resolveVehicleObservation(
  observation: VehicleObservation,
  candidates: VehicleObservationCandidate[],
  options: ResolveOptions = {},
): VehicleObservationResolution {
  const config: ResolverConfig = { ...DEFAULT_RESOLVER_CONFIG, ...options.config, weights: { ...DEFAULT_RESOLVER_CONFIG.weights, ...(options.config?.weights ?? {}) } };
  const reasons: string[] = [];

  const observedMs = parseInstant(observation.observedAt);
  if (!Number.isFinite(observedMs)) {
    return {
      status: "unmatched",
      tripInstanceId: null,
      tripId: null,
      vehicleId: null,
      gtfsBlockId: null,
      seqDiagramBlockId: null,
      effectiveBlockId: null,
      blockIdSource: null,
      confidence: 0,
      distanceM: null,
      candidateCount: 0,
      reasons: ["INVALID_OBSERVATION_TIME"],
    };
  }

  if (!Number.isFinite(observation.accuracyM) || observation.accuracyM <= 0) {
    return {
      status: "unmatched",
      tripInstanceId: null,
      tripId: null,
      vehicleId: null,
      gtfsBlockId: null,
      seqDiagramBlockId: null,
      effectiveBlockId: null,
      blockIdSource: null,
      confidence: 0,
      distanceM: null,
      candidateCount: 0,
      reasons: ["GPS_ACCURACY_INVALID"],
    };
  }

  if (observation.accuracyM > config.maxAccuracyM) {
    reasons.push("GPS_ACCURACY_LOW");
  }

  if (candidates.length === 0) {
    reasons.push("NO_POSITION_SNAPSHOT");
    return {
      status: "unmatched",
      tripInstanceId: null,
      tripId: null,
      vehicleId: null,
      gtfsBlockId: null,
      seqDiagramBlockId: null,
      effectiveBlockId: null,
      blockIdSource: null,
      confidence: 0,
      distanceM: null,
      candidateCount: 0,
      reasons,
    };
  }

  const radiusM = Math.max(config.baseRadiusM, observation.accuracyM * config.accuracyMultiplier);
  const continuityVehicleId = options.sessionContinuity?.vehicleId ?? null;

  const scored = candidates
    .map((candidate) => {
      const posMs = parseInstant(candidate.positionAsOf);
      if (!Number.isFinite(posMs)) return null;
      const deltaSec = (posMs - observedMs) / 1000;
      if (Math.abs(deltaSec) > config.timeWindowSeconds) return null;
      const distanceM = haversineM(observation.latitude, observation.longitude, candidate.latitude, candidate.longitude);
      if (distanceM > radiusM) return null;
      // stale snapshot check: snapshotAt far from positionAsOf suggests stale feed
      const snapMs = parseInstant(candidate.snapshotAt);
      const stalenessSec = Number.isFinite(snapMs) ? Math.abs(snapMs - posMs) / 1000 : 0;
      const stale = stalenessSec > 180; // heuristic
      const { score, components, reasons: candReasons } = scoreCandidate(observation, candidate, config, distanceM, radiusM, deltaSec, continuityVehicleId);
      return { candidate, distanceM, deltaSec, stalenessSec, stale, score, components, candReasons };
    })
    .filter((v): v is NonNullable<typeof v> => v !== null)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    // distinguish no candidate within radius vs stale vs time
    const anyWithinTime = candidates.some((c) => {
      const posMs = parseInstant(c.positionAsOf);
      return Number.isFinite(posMs) && Math.abs((posMs - observedMs) / 1000) <= config.timeWindowSeconds;
    });
    if (!anyWithinTime) reasons.push("STALE_POSITION");
    else reasons.push("NO_CANDIDATE_WITHIN_RADIUS");
    return {
      status: "unmatched",
      tripInstanceId: null,
      tripId: null,
      vehicleId: null,
      gtfsBlockId: null,
      seqDiagramBlockId: null,
      effectiveBlockId: null,
      blockIdSource: null,
      confidence: 0,
      distanceM: null,
      candidateCount: 0,
      reasons,
    };
  }

  // attach stale reason if best is stale
  if (scored[0]!.stale) reasons.push("STALE_POSITION");

  const candidateCount = scored.length;
  const top = scored[0]!;
  const second = scored[1] ?? null;
  const margin = second ? top.score - second.score : 1;

  // Decision
  if (top.score < config.matchThreshold) {
    reasons.push("TOP_CANDIDATE_BELOW_THRESHOLD");
    if (margin < config.marginThreshold) reasons.push("TOP_CANDIDATE_MARGIN_LOW");
    reasons.push(...top.candReasons);
    return {
      status: "ambiguous",
      tripInstanceId: null,
      tripId: null,
      vehicleId: null,
      gtfsBlockId: null,
      seqDiagramBlockId: null,
      effectiveBlockId: null,
      blockIdSource: null,
      confidence: top.score,
      distanceM: top.distanceM,
      candidateCount,
      reasons,
    };
  }

  if (second && margin < config.marginThreshold) {
    reasons.push("TOP_CANDIDATE_MARGIN_LOW");
    reasons.push(...top.candReasons);
    return {
      status: "ambiguous",
      tripInstanceId: null,
      tripId: null,
      vehicleId: null,
      gtfsBlockId: null,
      seqDiagramBlockId: null,
      effectiveBlockId: null,
      blockIdSource: null,
      confidence: top.score,
      distanceM: top.distanceM,
      candidateCount,
      reasons,
    };
  }

  // Resolve trip instance and blocks
  const networkId = options.networkId ?? "au-rail";
  let resolved: { instance: AugmentedTripInstance | null; tripInstanceId: string | null } | null = null;
  let hasResolver = typeof options.resolveInstance === "function";
  if (hasResolver) {
    try {
      resolved = options.resolveInstance!(top.candidate);
    } catch {
      resolved = null;
    }
    if (!resolved || !resolved.instance) {
      reasons.push("TRIP_INSTANCE_NOT_FOUND");
      reasons.push(...top.candReasons);
      return {
        status: "unmatched",
        tripInstanceId: null,
        tripId: null,
        vehicleId: null,
        gtfsBlockId: null,
        seqDiagramBlockId: null,
        effectiveBlockId: null,
        blockIdSource: null,
        confidence: top.score,
        distanceM: top.distanceM,
        candidateCount,
        reasons,
      };
    }
  }

  let tripInstanceId: string | null;
  let tripId: string | null;
  let vehicleId: string | null;
  let gtfsBlockId: string | null = null;
  let seqDiagramBlockId: string | null = null;

  if (hasResolver && resolved?.instance) {
    tripInstanceId = resolved.instance.instance_id;
    tripId = resolved.instance.trip_id;
    vehicleId = resolved.instance.vehicle_id ?? top.candidate.vehicleId ?? null;
    gtfsBlockId = (resolved.instance as any).block_id ?? null;
    seqDiagramBlockId = (resolved.instance as any).seq_diagram_block_id ?? null;
    if (!tripInstanceId) reasons.push("TRIP_INSTANCE_NOT_FOUND");
  } else {
    // No resolver supplied (pure scoring unit test): synthesize ID and preserve candidate ids
    tripInstanceId = synthesizeTripInstanceId(top.candidate, networkId);
    tripId = top.candidate.tripId ?? null;
    vehicleId = top.candidate.vehicleId ?? null;
    if (!tripInstanceId) {
      reasons.push("TRIP_INSTANCE_NOT_FOUND");
      return {
        status: "unmatched",
        tripInstanceId: null,
        tripId: null,
        vehicleId: null,
        gtfsBlockId: null,
        seqDiagramBlockId: null,
        effectiveBlockId: null,
        blockIdSource: null,
        confidence: top.score,
        distanceM: top.distanceM,
        candidateCount,
        reasons,
      };
    }
    // Blocks unknown without instance
    gtfsBlockId = null;
    seqDiagramBlockId = null;
  }

  const block = effectiveBlock(gtfsBlockId, seqDiagramBlockId);
  if (hasResolver) {
    if (block.source === "gtfs") reasons.push("MATCHED_GTFS_BLOCK");
    else if (block.source === "seq-diagram") reasons.push("MATCHED_SEQ_DIAGRAM_BLOCK");
    else reasons.push("NO_BLOCK_AVAILABLE");
  } else {
    // In pure scoring mode, block extraction is not applicable; still report NO_BLOCK_AVAILABLE for determinism
    reasons.push("NO_BLOCK_AVAILABLE");
  }

  reasons.push(...top.candReasons);

  return {
    status: "matched",
    tripInstanceId,
    tripId,
    vehicleId,
    gtfsBlockId,
    seqDiagramBlockId,
    effectiveBlockId: block.effective,
    blockIdSource: block.source,
    confidence: top.score,
    distanceM: top.distanceM,
    candidateCount,
    reasons,
  };
}

// Helper for tests: deterministic normalization of nasid (same as server would do)
export function normalizeNasid(raw: string): string {
  return raw.trim().toUpperCase();
}
