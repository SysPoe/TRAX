import type { GTFS, RealtimeFilter } from "qdf-gtfs";
import type { CacheContext } from "./types.js";
import { LRUCache } from "./lruCache.js";
import { YieldBudget } from "../utils/cooperative.js";

const nativeRealtimeOwners = new WeakMap<GTFS, GTFS>();

/** Static reads share the native snapshot; realtime reads belong to one publication. */
export function createRealtimeReadView(gtfs: GTFS): GTFS {
	const native = getRealtimeOwner(gtfs);
	const trips = native.getRealtimeTripUpdates();
	const vehicles = native.getRealtimeVehiclePositions?.() ?? [];
	const alerts = native.getRealtimeAlerts?.() ?? [];
	const revision = native.getRealtimeRevision?.() ?? 0;
	const changed = native.getLastChangedTripIds?.() ?? [];
	const sourceMatches = (value: { feed_id: string; source_id: string }, filter: RealtimeFilter = {}) =>
		(!("feed_id" in filter) || value.feed_id === filter.feed_id) &&
		(!("source_id" in filter) || value.source_id === filter.source_id);
	const matches = (value: (typeof trips)[number] | (typeof vehicles)[number], filter: RealtimeFilter = {}) =>
		sourceMatches(value, filter) &&
		(!("trip_id" in filter) || value.trip.trip_id === filter.trip_id) &&
		(!("route_id" in filter) || value.trip.route_id === filter.route_id) &&
		(!("vehicle_id" in filter) || value.vehicle.id === filter.vehicle_id) &&
		(!("stop_id" in filter) ||
			("stop_time_updates" in value
				? value.stop_time_updates.some((stop) => stop.stop_id === filter.stop_id)
				: value.stop_id === filter.stop_id));
	const methods: Record<string, unknown> = {
		getRealtimeTripUpdates: (filter?: RealtimeFilter) =>
			structuredClone(trips.filter((value) => matches(value, filter))),
		getRealtimeVehiclePositions: (filter?: RealtimeFilter) =>
			structuredClone(vehicles.filter((value) => matches(value, filter))),
		// Native alert filtering only recognizes feed_id and source_id.
		getRealtimeAlerts: (filter?: RealtimeFilter) =>
			structuredClone(alerts.filter((value) => sourceMatches(value, filter))),
		getRealtimeRevision: () => revision,
		getLastChangedTripIds: () => [...changed],
		getSnapshotRevision: () => ({ ...native.getSnapshotRevision(), realtime_revision: revision }),
		getStaticSnapshotInfo: () => ({ ...native.getStaticSnapshotInfo(), realtime_revision: revision }),
	};
	const view = new Proxy(native, {
		get(target, property) {
			if (typeof property === "string" && property in methods) return methods[property];
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	nativeRealtimeOwners.set(view, native);
	return view;
}

export function getRealtimeOwner(gtfs: GTFS): GTFS {
	return nativeRealtimeOwners.get(gtfs) ?? gtfs;
}

function cloneSnapshotValue<T>(value: T, seen: Map<object, unknown>): T {
	if (!value || typeof value !== "object") return value;
	if (seen.has(value)) return seen.get(value) as T;
	if (value instanceof LRUCache) {
		const result = value.fork();
		seen.set(value, result);
		return result as T;
	}
	if (value instanceof Map) {
		const result = new Map();
		seen.set(value, result);
		for (const [key, item] of value) result.set(key, cloneSnapshotValue(item, seen));
		return result as T;
	}
	if (value instanceof Set) {
		const result = new Set(value);
		seen.set(value, result);
		return result as T;
	}
	if (Array.isArray(value)) {
		const result: unknown[] = [];
		seen.set(value, result);
		for (const item of value) result.push(cloneSnapshotValue(item, seen));
		return result as T;
	}
	// Clients, promises, typed static arrays, and timers retain their owners.
	if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return value;
	const result: Record<string, unknown> = {};
	seen.set(value, result);
	for (const [key, item] of Object.entries(value)) result[key] = cloneSnapshotValue(item, seen);
	return result as T;
}

function retainAsyncPluginOwners(ctx: CacheContext, seen: Map<object, unknown>, staticRefresh: boolean): void {
	const share = (value: unknown) => {
		if (value && typeof value === "object") seen.set(value, value);
	};
	// These independently published/on-demand resources own async callbacks.
	// Preserve their owner objects so pending requests finish into live caches.
	for (const [id, state] of ctx.pluginState) {
		if (
			(!staticRefresh && id === "au-seq:data") ||
			id === "au-seq:capacity" ||
			id.startsWith("au-seq-qrt-") ||
			id === "ca-via:consist" ||
			id === "au-nsw-tfnsw-regional-booking"
		)
			share(state);
		if (id === "au-vic-vline" && state && typeof state === "object") {
			for (const field of [
				"journeyCache",
				"journeyInFlight",
				"bookingCache",
				"bookingInFlight",
				"bookingSnapshots",
				"bookingPrefetchAttempted",
			])
				share((state as Record<string, unknown>)[field]);
		}
	}
}

/** Yield within a large trip or plugin table as well as between top-level buckets. */
function cooperativeCloner(seen: Map<object, unknown>, budget: YieldBudget) {
	const pending: Array<{ source: object; target: object }> = [];
	let copiedFields = 0;
	function clone<T>(value: T): T {
		if (!value || typeof value !== "object") return value;
		if (seen.has(value)) return seen.get(value) as T;
		if (value instanceof LRUCache) {
			const result = value.fork();
			seen.set(value, result);
			return result as T;
		}
		let target: object;
		if (value instanceof Map) target = new Map();
		else if (value instanceof Set) target = new Set();
		else if (Array.isArray(value)) target = [];
		else if (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
			target = {};
		else return value;
		seen.set(value, target);
		pending.push({ source: value, target });
		return target as T;
	}
	async function drain(): Promise<void> {
		while (pending.length) {
			const { source, target } = pending.pop()!;
			if (source instanceof Map) {
				for (const [key, value] of source) {
					(target as Map<unknown, unknown>).set(key, clone(value));
					if ((++copiedFields & 127) === 0) await budget.maybeYield();
				}
			} else if (source instanceof Set) {
				for (const value of source) {
					(target as Set<unknown>).add(value);
					if ((++copiedFields & 127) === 0) await budget.maybeYield();
				}
			} else if (Array.isArray(source)) {
				for (const value of source) {
					(target as unknown[]).push(clone(value));
					if ((++copiedFields & 127) === 0) await budget.maybeYield();
				}
			} else {
				for (const key of Object.keys(source)) {
					(target as Record<string, unknown>)[key] = clone((source as Record<string, unknown>)[key]);
					if ((++copiedFields & 127) === 0) await budget.maybeYield();
				}
			}
		}
	}
	return { clone, drain };
}

/** Keep supplemental last-good data while static provider hooks rebuild aliases. */
export function forkStaticPluginState(ctx: CacheContext): CacheContext["pluginState"] {
	const seen = new Map<object, unknown>();
	retainAsyncPluginOwners(ctx, seen, true);
	return cloneSnapshotValue(ctx.pluginState, seen);
}

/**
 * Copy active mutable data while sharing static rows and physical-route plans.
 * One candidate is retained per refresh. The caller keeps the prior publication
 * until this candidate is complete; failed candidates are discarded.
 */
export async function forkRealtimeContext(ctx: CacheContext): Promise<CacheContext> {
	while (true) {
		const revision = ctx.runtimeState.lazyMaterializationRevision ?? 0;
		const candidate = await forkRealtimeContextOnce(ctx);
		if ((ctx.runtimeState.lazyMaterializationRevision ?? 0) === revision) return candidate;
		// A public date query changed the authoritative graph during a yield.
		// Discard this mixed copy and retry from the complete source state.
	}
}

async function forkRealtimeContextOnce(ctx: CacheContext): Promise<CacheContext> {
	ctx.publicationOwner ??= { current: ctx };
	const seen = new Map<object, unknown>();
	const share = (value: unknown) => {
		if (value && typeof value === "object") seen.set(value, value);
	};
	for (const value of [
		ctx.config,
		ctx.gtfs,
		ctx.augmented.stops,
		ctx.augmented.stopsRec,
		ctx.augmented.railStations,
		ctx.augmented.shapes,
		ctx.augmented.corridorIndex,
		ctx.runtimeState.serviceCalendarRules,
		ctx.runtimeState.serviceCalendarExceptions,
		ctx.runtimeState.servicesByDateHandle,
	])
		share(value);
	for (const values of [
		ctx.raw.routesByKey,
		ctx.raw.tripsByKey,
		ctx.raw.stopsByKey,
		ctx.raw.stopsByFeed,
		ctx.raw.tripStopTimeBoundsByKey,
		ctx.raw.frequenciesByTripKey,
		ctx.augmented.rawTripsRec,
		ctx.augmented.rawStopTimesCache,
		ctx.augmented.rawPackedCache,
		ctx.augmented.staticTemplates,
		ctx.augmented.linkedTransfersFromTrip,
	])
		for (const value of values.values()) share(value);
	share(ctx.raw.consideredTrips);
	retainAsyncPluginOwners(ctx, seen, false);
	const budget = new YieldBudget();
	const { clone, drain } = cooperativeCloner(seen, budget);
	async function copyRecord<T extends object>(record: T): Promise<T> {
		const result: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(record)) {
			if (
				value &&
				typeof value === "object" &&
				!seen.has(value) &&
				(value instanceof Map || Array.isArray(value))
			) {
				const copied: Map<unknown, unknown> | unknown[] = value instanceof Map ? new Map() : [];
				seen.set(value, copied);
				let count = 0;
				for (const [entryKey, item] of value.entries()) {
					if (copied instanceof Map) copied.set(entryKey, clone(item));
					else copied.push(clone(item));
					if ((++count & 127) === 0) {
						await drain();
						await budget.maybeYield();
					}
				}
				result[key] = copied;
			} else result[key] = clone(value);
			await drain();
			await budget.maybeYield();
		}
		return result as T;
	}
	const result = {
		...ctx,
		raw: await copyRecord(ctx.raw),
		augmented: await copyRecord(ctx.augmented),
		runtimeState: await copyRecord(ctx.runtimeState),
		pluginState: clone(ctx.pluginState),
	};
	await drain();
	// An auxiliary request can settle while cooperative copies yield. Use its
	// current owner rather than inheriting a promise which already finalized.
	result.augmented.qrtRefreshInFlight = ctx.augmented.qrtRefreshInFlight;
	return result;
}
