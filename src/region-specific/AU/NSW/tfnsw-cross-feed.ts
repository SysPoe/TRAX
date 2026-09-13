import { getPlaceForStation } from "../../../config.js";
import { entityKey, encodeTripInstanceId } from "../../../identity.js";
import type { CacheContext } from "../../../cache/types.js";
import type { AugmentedTripInstance } from "../../../utils/augmentedTrip.js";
import type { AugmentedStopTime } from "../../../utils/augmentedStopTime.js";
import { calculateDelayClass } from "../../../utils/augmentedStopTime.js";
import { getPluginState } from "../../../plugins/types.js";
import { TripScheduleRelationship } from "qdf-gtfs";

export const TFNSW_SYDNEY_TRAINS_FEED_ID = "nsw-sydney-trains";
export const TFNSW_TRAINLINK_FEED_ID = "nsw-trainlink";
const STATE_KEY = "au-nsw-tfnsw-rail:cross-feed";
const MAX_DELTA = 120;
type Instance = AugmentedTripInstance;
type Row = AugmentedStopTime;
export type TfnswCrossFeedPair = {
	primaryInstanceId: string;
	secondaryInstanceId: string;
	canonicalInstanceId: string;
	primaryTripKey: string;
	secondaryTripKey: string;
	serviceDate: string;
	runNumber: string;
};
type Index = {
	pairs: TfnswCrossFeedPair[];
	byInstance: Map<string, TfnswCrossFeedPair>;
	byTrip: Map<string, TfnswCrossFeedPair[]>;
};
function state(ctx: CacheContext): { index: Index | null } {
	return getPluginState(ctx, STATE_KEY, () => ({ index: null as Index | null }));
}
export function normalizeTfnswRunNumber(value: string | null | undefined): string | null {
	return value?.trim().toUpperCase() || null;
}

function formatRunClock(seconds: number): string {
	const total = Math.floor(seconds);
	const hh = Math.floor(total / 3600);
	const mm = Math.floor((total % 3600) / 60);
	const ss = total % 60;
	return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

/**
 * Normalized run identity for canonical instance IDs. Frequency runs share
 * trip/date/run-number but are distinct instances; without the frequency
 * start time their canonical IDs collide. Raw start_time forms (6:00:00 vs
 * 06:00:00) normalize to one canonical clock.
 */
function normalizedTfnswRunIdentity(instance: Instance): string {
	const freq = (instance as { frequency_start_time?: number | null }).frequency_start_time;
	if (typeof freq === "number" && Number.isFinite(freq)) return formatRunClock(freq);
	const raw = instance.realtime_update?.trip.start_time;
	if (raw != null && String(raw).trim() !== "") {
		const trimmed = String(raw).trim();
		const match = /^(\d+):(\d{2})(?::(\d{2}))?$/.exec(trimmed);
		if (match) {
			const h = Number(match[1]);
			const m = Number(match[2]);
			const s = Number(match[3] ?? "0");
			if (Number.isFinite(h) && Number.isFinite(m) && Number.isFinite(s) && m <= 59 && s <= 59 && h >= 0) {
				return formatRunClock(h * 3600 + m * 60 + s);
			}
		}
		return trimmed;
	}
	return "";
}
function station(ctx: CacheContext, row: Row): string {
	const localId = row.scheduled_parent_station_id ?? row.scheduled_stop_id;
	const place = localId && getPlaceForStation(ctx.config, { feedId: row.feed_id, localId });
	return place ? `place:${place.id}` : entityKey({ feedId: row.feed_id, localId: localId ?? "" });
}
function scheduled(row: Row, terminal = false): number | null {
	return terminal
		? (row.scheduled_arrival_time ?? row.scheduled_departure_time)
		: (row.scheduled_departure_time ?? row.scheduled_arrival_time);
}

/** Match passenger calls, not generated passing points or terminal layover times.
 * Full ordered itineraries must agree, with at least three calls and a unique
 * partner in each feed. Uncertain matches remain separate.
 */
function matches(ctx: CacheContext, a: Instance, b: Instance): boolean {
	const left = a.stopTimes.filter((row) => !row.passing);
	const right = b.stopTimes.filter((row) => !row.passing);
	if (left.length < 3 || left.length !== right.length) return false;
	return left.every((row, i) => {
		const l = scheduled(row, i === left.length - 1);
		const r = scheduled(right[i], i === right.length - 1);
		return station(ctx, row) === station(ctx, right[i]) && l != null && r != null && Math.abs(l - r) <= MAX_DELTA;
	});
}

export function buildTfnswCrossFeedIndex(ctx: CacheContext): Index {
	const index: Index = { pairs: [], byInstance: new Map(), byTrip: new Map() };
	// Some third-party plugin callers only provide the fields their hooks need.
	if (!ctx.augmented?.tripsRec || !ctx.config?.network?.feeds || !ctx.pluginState) return index;
	const feeds = new Set(ctx.config.network.feeds.map(feed => feed.id));
	if (!feeds.has(TFNSW_SYDNEY_TRAINS_FEED_ID) || !feeds.has(TFNSW_TRAINLINK_FEED_ID)) {
		state(ctx).index = index;
		return index;
	}
	const groups = new Map<string, { primary: Instance[]; secondary: Instance[] }>();
	for (const trip of ctx.augmented.tripsRec.values()) {
		const primary = trip.feed_id === TFNSW_SYDNEY_TRAINS_FEED_ID;
		if (!primary && trip.feed_id !== TFNSW_TRAINLINK_FEED_ID) continue;
		for (const instance of trip.instances) {
			const relationship = instance.realtime_update?.trip.schedule_relationship;
			if (relationship != null && relationship !== TripScheduleRelationship.SCHEDULED &&
				relationship !== TripScheduleRelationship.CANCELED) continue;
			const run = normalizeTfnswRunNumber(instance.trip_number);
			if (!run || instance.nonRevenue) continue;
			const key = `${instance.serviceDate}:${run}`;
			let group = groups.get(key);
			if (!group) groups.set(key, (group = { primary: [], secondary: [] }));
			(primary ? group.primary : group.secondary).push(instance);
		}
	}
	for (const group of groups.values()) {
		const candidates = new Map<Instance, Instance[]>();
		for (const a of group.primary)
			for (const b of group.secondary) {
				if (!matches(ctx, a, b)) continue;
				candidates.set(a, [...(candidates.get(a) ?? []), b]);
				candidates.set(b, [...(candidates.get(b) ?? []), a]);
			}
		for (const a of group.primary) {
			const partners = candidates.get(a);
			if (partners?.length !== 1) continue;
			const b = partners[0];
			if (candidates.get(b)?.length !== 1) continue;
			const pair: TfnswCrossFeedPair = {
				primaryInstanceId: a.instance_id,
				secondaryInstanceId: b.instance_id,
				canonicalInstanceId: encodeTripInstanceId({
					networkId: ctx.config.network.id,
					feedId: a.feed_id,
					kind: "trip",
					localId: a.trip_id,
					serviceDate: a.serviceDate,
					realtimeStartTime: normalizedTfnswRunIdentity(a),
				}),
				primaryTripKey: entityKey({ feedId: a.feed_id, localId: a.trip_id }),
				secondaryTripKey: entityKey({ feedId: b.feed_id, localId: b.trip_id }),
				serviceDate: a.serviceDate,
				runNumber: normalizeTfnswRunNumber(a.trip_number)!,
			};
			index.pairs.push(pair);
			for (const id of [a.instance_id, b.instance_id, pair.canonicalInstanceId]) index.byInstance.set(id, pair);
			for (const key of [pair.primaryTripKey, pair.secondaryTripKey])
				index.byTrip.set(key, [...(index.byTrip.get(key) ?? []), pair]);
		}
	}
	// A timestamp-only update can change the winning source without reaugmentation.
	// Invalidate only paired stop caches, including pairs dissolved by this rebuild.
	for (const pair of [...(state(ctx).index?.pairs ?? []), ...index.pairs]) {
		for (const id of [pair.primaryInstanceId, pair.secondaryInstanceId]) {
			for (const row of ctx.augmented.instancesRec.get(id)?.stopTimes ?? []) {
				for (const localId of [
					row.scheduled_stop_id,
					row.scheduled_parent_station_id,
					row.actual_stop_id,
					row.actual_parent_station_id,
				]) {
					if (localId) ctx.augmented.stopDeparturesCached.delete(entityKey({ feedId: row.feed_id, localId }));
				}
			}
		}
	}
	state(ctx).index = index;
	return index;
}
export function getTfnswCrossFeedPair(ctx: CacheContext, id: string): TfnswCrossFeedPair | null {
	return ctx.pluginState ? (state(ctx).index?.byInstance.get(id) ?? null) : null;
}
export function resolveTfnswCanonicalInstanceId(ctx: CacheContext, id: string): string {
	return getTfnswCrossFeedPair(ctx, id)?.canonicalInstanceId ?? id;
}
export function expandTfnswChangedTripKeys(ctx: CacheContext, changed: ReadonlySet<string>): Set<string> {
	const expanded = new Set(changed);
	const index = ctx.pluginState ? state(ctx).index : null;
	for (const key of changed)
		for (const pair of index?.byTrip.get(key) ?? []) {
			expanded.add(pair.primaryTripKey);
			expanded.add(pair.secondaryTripKey);
		}
	return expanded;
}

/** Match each visit by station and ordered occurrence, including passing visits. */
function visits(ctx: CacheContext, rows: readonly Row[]): Map<string, Row> {
	const counts = new Map<string, number>();
	const result = new Map<string, Row>();
	for (const row of rows) {
		const key = station(ctx, row);
		const occurrence = counts.get(key) ?? 0;
		counts.set(key, occurrence + 1);
		result.set(`${key}:${occurrence}`, row);
	}
	return result;
}

function mergeRow(ctx: CacheContext, primary: Row, secondary: Row, preferSecondary: boolean): Row {
	let target = { ...primary };
	if (secondary.realtime && (!primary.realtime || preferSecondary)) {
		const delay =
			(secondary.actual_departure_time ?? secondary.actual_arrival_time ?? 0) -
			(primary.scheduled_departure_time ?? primary.scheduled_arrival_time ?? 0);
		const { str, cls } = calculateDelayClass(delay);
		target = {
			...target,
			actual_arrival_time: secondary.actual_arrival_time,
			actual_departure_time: secondary.actual_departure_time,
			actual_arrival_dates: secondary.actual_arrival_dates,
			actual_departure_dates: secondary.actual_departure_dates,
			actual_arrival_date_offset: secondary.actual_arrival_date_offset,
			actual_departure_date_offset: secondary.actual_departure_date_offset,
			rt_arrival_updated: secondary.rt_arrival_updated,
			rt_departure_updated: secondary.rt_departure_updated,
			realtime: true,
			realtime_info: { ...secondary.realtime_info, delay_secs: delay, delay_string: str, delay_class: cls },
		};
		// Translate only stops known in the canonical feed. Never reuse a foreign ID.
		const alternate =
			secondary.actual_stop_id &&
			ctx.augmented.stopsRec.get(entityKey({ feedId: primary.feed_id, localId: secondary.actual_stop_id }));
		if (secondary.rt_stop_updated && alternate) {
			target.actual_stop_id = alternate.stop_id;
			target.actual_stop = alternate;
			target.actual_parent_station_id = alternate.parent_stop_id;
			target.actual_parent_station = alternate.parent_stop_id
				? ctx.augmented.stopsRec.get(entityKey({ feedId: primary.feed_id, localId: alternate.parent_stop_id }))
				: null;
			target.rt_stop_updated = true;
			target.rt_parent_station_updated = secondary.rt_parent_station_updated;
		}
		if (secondary.rt_platform_code_updated) {
			target.actual_platform_code = secondary.actual_platform_code;
			target.rt_platform_code_updated = true;
		}
		target.actual_arrival_boarding_locations = secondary.actual_arrival_boarding_locations;
		target.actual_departure_boarding_locations = secondary.actual_departure_boarding_locations;
	}
	if (
		secondary.occupancy &&
		(!primary.occupancy || (secondary.occupancy.observed_at ?? "") > (primary.occupancy.observed_at ?? ""))
	)
		target.occupancy = secondary.occupancy;
	return target;
}

/** Keep raw feed instances intact; old links and departures share this projection. */
export function getTfnswCanonicalTripInstance(ctx: CacheContext, id: string): Instance | null {
	const pair = getTfnswCrossFeedPair(ctx, id);
	if (!pair) return ctx.augmented.instancesRec.get(id) ?? null;
	const primary = ctx.augmented.instancesRec.get(pair.primaryInstanceId);
	const secondary = ctx.augmented.instancesRec.get(pair.secondaryInstanceId);
	if (!primary || !secondary) return primary ?? secondary ?? null;
	const preferSecondary =
		Boolean(secondary.realtime_update) &&
		(!primary.realtime_update ||
			(secondary.realtime_update?.timestamp ?? 0) > (primary.realtime_update?.timestamp ?? 0));
	const secondaryVisits = visits(ctx, secondary.stopTimes);
	const stopTimes: Row[] = [];
	for (const [key, row] of visits(ctx, primary.stopTimes)) {
		const other = secondaryVisits.get(key);
		const merged = other ? mergeRow(ctx, row, other, preferSecondary) : { ...row };
		stopTimes.push({ ...merged, instance_id: pair.canonicalInstanceId });
		secondaryVisits.delete(key);
	}
	// Preserve source-only passing points, such as the interstate border tunnel.
	let syntheticSequence = -1;
	for (const row of secondaryVisits.values()) {
		stopTimes.push({
			...row,
			instance_id: pair.canonicalInstanceId,
			_stopTime: row._stopTime ? { ...row._stopTime, stop_sequence: syntheticSequence-- } : null,
		});
	}
	stopTimes.sort((a, b) => (scheduled(a) ?? 0) - (scheduled(b) ?? 0));
	const relationship = preferSecondary ? secondary.schedule_relationship : primary.schedule_relationship;
	for (const row of stopTimes) row.schedule_relationship = relationship;
	return {
		...primary,
		instance_id: pair.canonicalInstanceId,
		stopTimes,
		schedule_relationship: relationship,
		// Preserve feed-qualified realtime metadata; consumers must not rematch its sequences.
		realtime_update: preferSecondary ? secondary.realtime_update : primary.realtime_update,
		vehicle_id: preferSecondary
			? (secondary.vehicle_id ?? primary.vehicle_id)
			: (primary.vehicle_id ?? secondary.vehicle_id),
		vehicle_model: preferSecondary
			? (secondary.vehicle_model ?? primary.vehicle_model)
			: (primary.vehicle_model ?? secondary.vehicle_model),
		consist: preferSecondary ? (secondary.consist ?? primary.consist) : (primary.consist ?? secondary.consist),
		passenger_cars: preferSecondary
			? (secondary.passenger_cars ?? primary.passenger_cars)
			: (primary.passenger_cars ?? secondary.passenger_cars),
	};
}

export function reconcileTfnswDepartures(ctx: CacheContext, rows: readonly Row[]): Row[] {
	if (!ctx.pluginState || !state(ctx).index?.pairs.length) return [...rows];
	const result = new Map<string, Row>();
	const presentations = new Map<string, Map<string, Row>>();
	const rawVisits = new Map<string, Map<Row, string>>();
	for (const row of rows) {
		const pair = getTfnswCrossFeedPair(ctx, row.instance_id);
		let selected = row;
		if (pair) {
			let projection = presentations.get(pair.canonicalInstanceId);
			if (!projection) {
				const instance = getTfnswCanonicalTripInstance(ctx, row.instance_id);
				projection = visits(ctx, instance?.stopTimes ?? []);
				presentations.set(pair.canonicalInstanceId, projection);
			}
			let keys = rawVisits.get(row.instance_id);
			if (!keys) {
				const raw = ctx.augmented.instancesRec.get(row.instance_id);
				keys = new Map([...visits(ctx, raw?.stopTimes ?? [])].map(([key, value]) => [value, key]));
				rawVisits.set(row.instance_id, keys);
			}
			const key = keys.get(row);
			if (key) selected = projection.get(key) ?? row;
		}
		const key = `${selected.instance_id}:${selected._stopTime?.stop_sequence ?? station(ctx, selected)}`;
		result.set(key, selected);
	}
	return [...result.values()];
}
