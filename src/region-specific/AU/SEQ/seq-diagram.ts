import type { GTFS, StopTime, Trip } from "qdf-gtfs";
import type { CacheContext } from "../../../cache.js";
import type { AugmentedStopTime } from "../../../utils/augmentedStopTime.js";
import type { AugmentedTripInstance } from "../../../utils/augmentedTrip.js";
import { isRegion } from "../../../config.js";
import { getServiceDayStart } from "../../../utils/time.js";

/** Minimum time (seconds) between clearing the terminal on leg A and first departure of leg B for a feasible link. */
export const SEQ_DIAGRAM_MIN_TURNAROUND_SEC = 90;

/** Ignore precursor trips that ended more than this many seconds before the next trip starts (parent-station fallback only). */
const SEQ_PARENT_MAX_PRECursors_SEC = 6 * 3600;

const KEY_SEP = "\x1e";

export type SeqDiagramTripEnd = {
	trip_id: string;
	service_id: string;
	route_id: string;
	first_stop_id: string;
	last_stop_id: string;
	first_parent: string;
	last_parent: string;
	first_dep: number;
	last_dep: number;
};

export type SeqDiagramTopology = {
	prevTripId: Map<string, string>;
	nextTripId: Map<string, string>;
	blockIdByTripId: Map<string, number>;
	tripCount: number;
	linkedPrevCount: number;
};

type EndBucketEntry = {
	trip_id: string;
	last_dep: number;
	last_stop_id: string;
	last_parent: string;
};

function extractTripEnds(
	trip: Trip,
	stopTimesSorted: StopTime[],
	parentOfStop: (stopId: string) => string,
): SeqDiagramTripEnd | null {
	if (stopTimesSorted.length < 2) return null;

	const first = stopTimesSorted[0]!;
	const last = stopTimesSorted[stopTimesSorted.length - 1]!;

	const first_dep = first.departure_time ?? first.arrival_time ?? null;
	const last_dep = last.departure_time ?? last.arrival_time ?? null;

	if (first_dep === null || last_dep === null) return null;

	return {
		trip_id: trip.trip_id,
		service_id: trip.service_id,
		route_id: trip.route_id,
		first_stop_id: first.stop_id,
		last_stop_id: last.stop_id,
		first_parent: parentOfStop(first.stop_id),
		last_parent: parentOfStop(last.stop_id),
		first_dep,
		last_dep,
	};
}

/** When several precursors end within this many seconds of the latest one, prefer trip_id numeric proximity over absolute latest arrival. */
const SEQ_DIAGRAM_PRED_TIME_WINDOW_SEC = 45 * 60;

function pickPredecessorForSuccessor(
	candidates: EndBucketEntry[] | undefined,
	first_dep: number,
	succTripId: string,
	self_id: string,
	maxLayoverFromFirst: number | null,
): string | null {
	let valid = (candidates ?? []).filter(
		(c) => c.trip_id !== self_id && c.last_dep + SEQ_DIAGRAM_MIN_TURNAROUND_SEC < first_dep,
	);
	if (maxLayoverFromFirst != null)
		valid = valid.filter((c) => first_dep - c.last_dep <= maxLayoverFromFirst);
	if (!valid.length) return null;

	let maxLast = valid[0]!.last_dep;
	for (const c of valid) if (c.last_dep > maxLast) maxLast = c.last_dep;

	let pool = valid.filter((c) => maxLast - c.last_dep <= SEQ_DIAGRAM_PRED_TIME_WINDOW_SEC);
	if (pool.length === 0) pool = [valid.sort((a, b) => b.last_dep - a.last_dep)[0]!];

	const sn = tripIdNumericPrefix(succTripId);
	let best: EndBucketEntry | null = null;
	let bestScore = Number.POSITIVE_INFINITY;
	for (const c of pool) {
		const d = sn - tripIdNumericPrefix(c.trip_id);
		const score = d > 0 ? d : 1e12 + Math.abs(d);
		if (score < bestScore) {
			bestScore = score;
			best = c;
		}
	}
	return best?.trip_id ?? null;
}

function pickBestPredecessor(
	candidates: EndBucketEntry[] | undefined,
	first_dep: number,
	succTripId: string,
	self_id: string,
): string | null {
	return pickPredecessorForSuccessor(candidates, first_dep, succTripId, self_id, null);
}

function pickBestPredecessorParent(
	candidates: EndBucketEntry[] | undefined,
	first_dep: number,
	first_parent: string,
	succTripId: string,
	self_id: string,
): string | null {
	if (!first_parent) return null;
	const filtered = (candidates ?? []).filter((c) => c.last_parent === first_parent);
	return pickPredecessorForSuccessor(filtered, first_dep, succTripId, self_id, SEQ_PARENT_MAX_PRECursors_SEC);
}

function tripIdNumericPrefix(trip_id: string): number {
	const i = trip_id.indexOf("-");
	const head = i === -1 ? trip_id : trip_id.slice(0, i);
	const n = Number.parseInt(head, 10);
	return Number.isFinite(n) ? n : 0;
}

/**
 * Multiple trips can tie as successors of the same predecessor (e.g. parent-station match at Beenleigh).
 * Keep one successor per predecessor — prefer the smallest *forward* jump in the numeric trip_id prefix
 * (Translink encodes diagram order there, e.g. 37326341 → 37326342).
 */
function resolveSharedPredecessors(
	prevDraft: Map<string, string>,
): { prevTripId: Map<string, string>; nextTripId: Map<string, string> } {
	const byPred = new Map<string, string[]>();
	for (const [trip, pred] of prevDraft.entries()) {
		let arr = byPred.get(pred);
		if (!arr) {
			arr = [];
			byPred.set(pred, arr);
		}
		arr.push(trip);
	}

	const prevTripId = new Map<string, string>();
	const nextTripId = new Map<string, string>();

	for (const [pred, succs] of byPred.entries()) {
		if (succs.length === 1) {
			const s = succs[0]!;
			prevTripId.set(s, pred);
			nextTripId.set(pred, s);
			continue;
		}
		const predNum = tripIdNumericPrefix(pred);
		let best = succs[0]!;
		let bestScore = Number.POSITIVE_INFINITY;
		for (const s of succs) {
			const sn = tripIdNumericPrefix(s);
			const d = sn - predNum;
			const score = d > 0 ? d : 1e12 + Math.abs(d);
			if (score < bestScore) {
				bestScore = score;
				best = s;
			}
		}
		prevTripId.set(best, pred);
		nextTripId.set(pred, best);
	}

	return { prevTripId, nextTripId };
}

/**
 * Build prev/next trip links for Translink SEQ from static GTFS only.
 * One full-table scan of stop_times; O(trips + stop_times) with hash maps.
 */
export function buildSeqDiagramTopology(gtfs: GTFS, trips: Trip[]): SeqDiagramTopology {
	const stops = gtfs.getStops();
	const parentByStop = new Map<string, string>();
	for (const s of stops) {
		parentByStop.set(s.stop_id, s.parent_station ?? "");
	}
	const parentOfStop = (id: string) => parentByStop.get(id) ?? "";

	const consideredIds = new Set<string>();
	for (const t of trips) consideredIds.add(t.trip_id);

	const byTrip = new Map<string, StopTime[]>();
	const allStopTimes = gtfs.getStopTimes();
	for (let i = 0; i < allStopTimes.length; i++) {
		const st = allStopTimes[i]!;
		if (!consideredIds.has(st.trip_id)) continue;
		let arr = byTrip.get(st.trip_id);
		if (!arr) {
			arr = [];
			byTrip.set(st.trip_id, arr);
		}
		arr.push(st);
	}

	const tripEnds = new Map<string, SeqDiagramTripEnd>();
	for (const t of trips) {
		const sts = byTrip.get(t.trip_id);
		if (!sts?.length) continue;
		if (sts.length < 2) continue;
		sts.sort((a, b) => a.stop_sequence - b.stop_sequence);
		const end = extractTripEnds(t, sts, parentOfStop);
		if (end) tripEnds.set(t.trip_id, end);
	}

	const endExact = new Map<string, EndBucketEntry[]>();
	const endParent = new Map<string, EndBucketEntry[]>();

	for (const e of tripEnds.values()) {
		const entry: EndBucketEntry = {
			trip_id: e.trip_id,
			last_dep: e.last_dep,
			last_stop_id: e.last_stop_id,
			last_parent: e.last_parent,
		};
		const kExact = e.last_stop_id + KEY_SEP + e.service_id;
		let arr = endExact.get(kExact);
		if (!arr) {
			arr = [];
			endExact.set(kExact, arr);
		}
		arr.push(entry);

		if (e.last_parent) {
			const kP = e.last_parent + KEY_SEP + e.service_id;
			let parr = endParent.get(kP);
			if (!parr) {
				parr = [];
				endParent.set(kP, parr);
			}
			parr.push(entry);
		}
	}

	const prevDraft = new Map<string, string>();
	for (const e of tripEnds.values()) {
		const keyFirst = e.first_stop_id + KEY_SEP + e.service_id;
		let pred = pickBestPredecessor(endExact.get(keyFirst), e.first_dep, e.trip_id, e.trip_id);
		if (!pred && e.first_parent) {
			const keyPar = e.first_parent + KEY_SEP + e.service_id;
			pred = pickBestPredecessorParent(endParent.get(keyPar), e.first_dep, e.first_parent, e.trip_id, e.trip_id);
		}
		if (pred) prevDraft.set(e.trip_id, pred);
	}

	const { prevTripId, nextTripId } = resolveSharedPredecessors(prevDraft);
	const linkedPrev = prevTripId.size;

	const blockIdByTripId = new Map<string, number>();
	const root = new Map<string, string>();

	function findRoot(t: string): string {
		let r = root.get(t);
		if (!r) {
			root.set(t, t);
			return t;
		}
		if (r === t) return t;
		const z = findRoot(r);
		root.set(t, z);
		return z;
	}

	function union(a: string, b: string): void {
		const ra = findRoot(a);
		const rb = findRoot(b);
		if (ra !== rb) root.set(ra, rb);
	}

	for (const t of tripEnds.keys()) {
		if (!root.has(t)) root.set(t, t);
	}

	for (const [trip, pred] of prevTripId) union(trip, pred);

	let nextBlock = 1;
	const blockByRoot = new Map<string, number>();
	for (const t of tripEnds.keys()) {
		const r = findRoot(t);
		let bid = blockByRoot.get(r);
		if (bid === undefined) {
			bid = nextBlock++;
			blockByRoot.set(r, bid);
		}
		blockIdByTripId.set(t, bid);
	}

	return {
		prevTripId,
		nextTripId,
		blockIdByTripId,
		tripCount: tripEnds.size,
		linkedPrevCount: linkedPrev,
	};
}

function expandSeqDiagramNeighborhood(top: SeqDiagramTopology, seeds: Set<string>): Set<string> {
	const out = new Set<string>();
	for (const t of seeds) {
		out.add(t);
		const p = top.prevTripId.get(t);
		const n = top.nextTripId.get(t);
		if (p) out.add(p);
		if (n) out.add(n);
	}
	return out;
}

function findInstanceIdForDate(ctx: CacheContext, trip_id: string, serviceDate: string): string | null {
	const t = ctx.augmented.tripsRec.get(trip_id);
	if (!t) return null;
	for (const inst of t.instances) {
		if (inst.serviceDate === serviceDate) return inst.instance_id;
		if (inst.actualTripDates.includes(serviceDate)) return inst.instance_id;
	}
	return null;
}

/** Absolute epoch seconds for first departure or last departure of an instance (handles date offsets on stop times). type only used for first/last discrimination via stop index. */
function endpointAbsUnix(
	ctx: CacheContext,
	inst: AugmentedTripInstance,
	which: "first" | "last",
): number | null {
	const sts = inst.stopTimes;
	if (!sts.length) return null;
	const st: AugmentedStopTime = which === "first" ? sts[0]! : sts[sts.length - 1]!;
	const sec =
		st.actual_departure_time ??
		st.scheduled_departure_time ??
		st.actual_arrival_time ??
		st.scheduled_arrival_time;
	if (sec == null) return null;
	const off =
		which === "first"
			? (st.actual_departure_date_offset ?? st.scheduled_departure_date_offset ?? 0)
			: (st.actual_departure_date_offset ?? st.scheduled_departure_date_offset ?? 0);
	const base = getServiceDayStart(st.service_date, ctx.config.timezone);
	return base + off * 86400 + sec;
}

/**
 * Copy static topology onto instances and resolve instance_id links for the same service date.
 */
export function applySeqDiagramToInstances(ctx: CacheContext, top: SeqDiagramTopology): void {
	ctx.augmented.seqDiagram = top;

	for (const trip of ctx.augmented.tripsRec.values()) {
		const bid = top.blockIdByTripId.get(trip.trip_id) ?? null;
		const p = top.prevTripId.get(trip.trip_id) ?? null;
		const n = top.nextTripId.get(trip.trip_id) ?? null;

		for (const inst of trip.instances) {
			inst.seq_diagram_prev_trip_id = p;
			inst.seq_diagram_next_trip_id = n;
			inst.seq_diagram_block_id = bid;
			inst.seq_diagram_prev_instance_id = p ? findInstanceIdForDate(ctx, p, inst.serviceDate) : null;
			inst.seq_diagram_next_instance_id = n ? findInstanceIdForDate(ctx, n, inst.serviceDate) : null;
			inst.seq_diagram_prev_link_broken = false;
			inst.seq_diagram_next_link_broken = false;
		}
	}
}

/**
 * Re-check diagram links using current (possibly realtime) times. Marks `*_link_broken` when the next
 * trip would need to depart before the current trip clears the terminal (+ minimum turnaround).
 */
export function revalidateSeqDiagramRealtimeEdges(ctx: CacheContext, affectedTripIds: Set<string> | null): void {
	if (!isRegion(ctx.config.region, "AU/SEQ")) return;
	const top = ctx.augmented.seqDiagram;
	if (!top) return;

	const tripIds = affectedTripIds
		? expandSeqDiagramNeighborhood(top, affectedTripIds)
		: new Set(ctx.augmented.tripsRec.keys());

	const minGap = SEQ_DIAGRAM_MIN_TURNAROUND_SEC;

	for (const tripId of tripIds) {
		const trip = ctx.augmented.tripsRec.get(tripId);
		if (!trip) continue;

		for (const inst of trip.instances) {
			const nextInstId = inst.seq_diagram_next_instance_id;
			if (!nextInstId) inst.seq_diagram_next_link_broken = false;
			else {
				const nextInst = ctx.augmented.instancesRec.get(nextInstId);
				if (!nextInst) inst.seq_diagram_next_link_broken = true;
				else {
					const lastOut = endpointAbsUnix(ctx, inst, "last");
					const firstNext = endpointAbsUnix(ctx, nextInst, "first");
					if (lastOut === null || firstNext === null) inst.seq_diagram_next_link_broken = false;
					else inst.seq_diagram_next_link_broken = firstNext < lastOut + minGap;
				}
			}

			const prevInstId = inst.seq_diagram_prev_instance_id;
			if (!prevInstId) inst.seq_diagram_prev_link_broken = false;
			else {
				const prevInst = ctx.augmented.instancesRec.get(prevInstId);
				if (!prevInst) inst.seq_diagram_prev_link_broken = true;
				else {
					const prevLast = endpointAbsUnix(ctx, prevInst, "last");
					const firstHere = endpointAbsUnix(ctx, inst, "first");
					if (prevLast === null || firstHere === null) inst.seq_diagram_prev_link_broken = false;
					else inst.seq_diagram_prev_link_broken = firstHere < prevLast + minGap;
				}
			}
		}
	}
}

/** Build topology and attach to ctx (static refresh, AU/SEQ). */
export function buildAndApplySeqDiagram(ctx: CacheContext, gtfs: GTFS, trips: Trip[]): SeqDiagramTopology {
	const top = buildSeqDiagramTopology(gtfs, trips);
	applySeqDiagramToInstances(ctx, top);
	revalidateSeqDiagramRealtimeEdges(ctx, null);
	return top;
}

/**
 * After selected trips were re-augmented, refresh instance pointers for those trips and their diagram neighbours,
 * then revalidate realtime feasibility.
 */
export function refreshSeqDiagramAfterRealtimeBatch(ctx: CacheContext, updatedTripIds: Set<string>): void {
	if (!isRegion(ctx.config.region, "AU/SEQ")) return;
	const top = ctx.augmented.seqDiagram;
	if (!top || updatedTripIds.size === 0) return;

	const neighborhood = expandSeqDiagramNeighborhood(top, updatedTripIds);

	for (const tripId of neighborhood) {
		const trip = ctx.augmented.tripsRec.get(tripId);
		if (!trip) continue;

		const bid = top.blockIdByTripId.get(tripId) ?? null;
		const p = top.prevTripId.get(tripId) ?? null;
		const n = top.nextTripId.get(tripId) ?? null;

		for (const inst of trip.instances) {
			inst.seq_diagram_prev_trip_id = p;
			inst.seq_diagram_next_trip_id = n;
			inst.seq_diagram_block_id = bid;
			inst.seq_diagram_prev_instance_id = p ? findInstanceIdForDate(ctx, p, inst.serviceDate) : null;
			inst.seq_diagram_next_instance_id = n ? findInstanceIdForDate(ctx, n, inst.serviceDate) : null;
		}
	}

	revalidateSeqDiagramRealtimeEdges(ctx, neighborhood);
}
