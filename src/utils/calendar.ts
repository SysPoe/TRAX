import type { Calendar, CalendarDate, QualifiedEntityId } from "qdf-gtfs";
import type { CacheContext } from "../cache/index.js";
import { getEpochDayFromServiceDate, getServiceDateFromEpochDay } from "./time.js";
import { entityKey } from "../identity.js";
import { serviceHandleFor, tripHandleFor } from "../cache/handles.js";

function serviceKeyForTrip(trip: QualifiedEntityId, ctx: CacheContext): string {
	const tripKey = entityKey(trip);
	const mapped = ctx.raw.tripServiceIds?.get(tripKey);
	if (mapped) return mapped;
	const rawTrip = ctx.raw.tripsByKey.get(tripKey);
	return rawTrip ? entityKey({ feedId: rawTrip.feed_id, localId: rawTrip.service_id }) : tripKey;
}

function serviceDatesFromStaticCalendar(
	serviceKey: string,
	ctx: CacheContext,
	minEpochDay = -1,
	maxEpochDay = -1,
): string[] {
	const rules = ctx.runtimeState.serviceCalendarRules.get(serviceKey) ?? [];
	const exceptions = ctx.runtimeState.serviceCalendarExceptions.get(serviceKey);
	let first = minEpochDay;
	let last = maxEpochDay;
	if (first < 0) {
		first = Math.min(...rules.map((rule) => rule.startEpochDay), ...(exceptions ? exceptions.keys() : []));
	}
	if (last < 0) {
		last = Math.max(...rules.map((rule) => rule.endEpochDay), ...(exceptions ? exceptions.keys() : []));
	}
	if (!Number.isFinite(first) || !Number.isFinite(last) || last < first) return [];

	const result: string[] = [];
	for (let epochDay = first; epochDay <= last; epochDay++) {
		const exception = exceptions?.get(epochDay);
		const weekday = ((epochDay + 3) % 7 + 7) % 7;
		const scheduled = rules.some(
			(rule) =>
				epochDay >= rule.startEpochDay &&
				epochDay <= rule.endEpochDay &&
				(rule.weekdayMask & (1 << weekday)) !== 0,
		);
		if (exception === 1 || (exception !== 2 && scheduled)) result.push(getServiceDateFromEpochDay(epochDay));
	}
	return result;
}

export function getServiceDatesByTrip(
	trip: QualifiedEntityId,
	ctx: CacheContext,
	minEpochDay = -1,
	maxEpochDay = -1,
): string[] {
	if (!ctx.gtfs) return [];
	const serviceKey = serviceKeyForTrip(trip, ctx);
	const cacheKey = `${serviceKey}|${minEpochDay}|${maxEpochDay}`;
	const cached = ctx.runtimeState.serviceDates.get(cacheKey);
	if (cached) return cached;
	const fallbackDates = () => {
		const gtfs = ctx.gtfs as typeof ctx.gtfs & {
			getServiceDatesByTrip?: (value: QualifiedEntityId) => string[];
			getServiceDates?: (value: QualifiedEntityId) => string[];
		};
		if (typeof gtfs.getServiceDatesByTrip === "function") return gtfs.getServiceDatesByTrip(trip);
		const rawTrip = ctx.raw.tripsByKey.get(entityKey(trip));
		return rawTrip && typeof gtfs.getServiceDates === "function"
			? gtfs.getServiceDates({ feedId: rawTrip.feed_id, localId: rawTrip.service_id })
			: [];
	};
	const result = ctx.runtimeState.serviceCalendarLoaded
		? serviceDatesFromStaticCalendar(serviceKey, ctx, minEpochDay, maxEpochDay)
		: fallbackDates().filter((date) => {
				const epochDay = getEpochDayFromServiceDate(date);
				return (
					Number.isFinite(epochDay) &&
					(minEpochDay < 0 || epochDay >= minEpochDay) &&
					(maxEpochDay < 0 || epochDay <= maxEpochDay)
				);
			});
	ctx.runtimeState.serviceDates.set(cacheKey, result);
	return result;
}

/** Return one feed-qualified service calendar without repeating it per trip. */
export function getServiceDatesByService(
	service: QualifiedEntityId,
	ctx: CacheContext,
	fallbackTrip?: QualifiedEntityId,
): string[] {
	if (!ctx.gtfs) return [];
	const serviceKey = entityKey(service);
	const cacheKey = `service|${serviceKey}`;
	const cached = ctx.runtimeState.serviceDates.get(cacheKey);
	if (cached) return cached;
	const result = ctx.runtimeState.serviceCalendarLoaded
		? serviceDatesFromStaticCalendar(serviceKey, ctx)
		: typeof ctx.gtfs.getServiceDates === "function"
			? ctx.gtfs.getServiceDates(service)
			: fallbackTrip
				? ctx.gtfs.getServiceDatesByTrip(fallbackTrip)
				: [];
	ctx.runtimeState.serviceDates.set(cacheKey, result);
	return result;
}

/** Build compact service rules without expanding every calendar into date strings. */
export function loadServiceCalendarRules(
	ctx: CacheContext,
	calendars: readonly Calendar[] = [],
	calendarDates: readonly CalendarDate[] = [],
): void {
	ctx.runtimeState.serviceDates.clear();
	ctx.runtimeState.serviceCalendarRules.clear();
	ctx.runtimeState.serviceCalendarExceptions.clear();
	for (const calendar of calendars) {
		const serviceKey = entityKey({ feedId: calendar.feed_id, localId: calendar.service_id });
		const rules = ctx.runtimeState.serviceCalendarRules.get(serviceKey) ?? [];
		const weekdayMask =
			(Number(calendar.sunday) << 0) |
			(Number(calendar.monday) << 1) |
			(Number(calendar.tuesday) << 2) |
			(Number(calendar.wednesday) << 3) |
			(Number(calendar.thursday) << 4) |
			(Number(calendar.friday) << 5) |
			(Number(calendar.saturday) << 6);
		rules.push({
			startEpochDay: getEpochDayFromServiceDate(calendar.start_date),
			endEpochDay: getEpochDayFromServiceDate(calendar.end_date),
			weekdayMask,
		});
		ctx.runtimeState.serviceCalendarRules.set(serviceKey, rules);
	}
	for (const exception of calendarDates) {
		if (!exception.date || (exception.exception_type !== 1 && exception.exception_type !== 2)) continue;
		const serviceKey = entityKey({ feedId: exception.feed_id, localId: exception.service_id });
		const exceptions = ctx.runtimeState.serviceCalendarExceptions.get(serviceKey) ?? new Map<number, 1 | 2>();
		exceptions.set(getEpochDayFromServiceDate(exception.date), exception.exception_type);
		ctx.runtimeState.serviceCalendarExceptions.set(serviceKey, exceptions);
	}
	ctx.runtimeState.serviceCalendarLoaded = true;
}

/** Rebuild integer-handle inverse indexes for lazy date resolution. */
export function rebuildServiceInverseIndexes(ctx: CacheContext): void {
	ctx.runtimeState.servicesByDateHandle.clear();
	ctx.runtimeState.tripsByServiceHandle.clear();
	for (const [tripKey, trip] of ctx.raw.tripsByKey) {
		const serviceHandle = serviceHandleFor(trip.feed_id, trip.service_id);
		let set = ctx.runtimeState.tripsByServiceHandle.get(serviceHandle);
		if (!set) { set = new Set(); ctx.runtimeState.tripsByServiceHandle.set(serviceHandle, set); }
		set.add(tripHandleFor(trip.feed_id, trip.trip_id));
	}
	for (const serviceKey of ctx.runtimeState.serviceCalendarRules.keys()) {
		const colon = serviceKey.indexOf(":");
		if (colon < 0) continue;
		const len = parseInt(serviceKey.slice(0, colon), 10);
		const rest = serviceKey.slice(colon+1);
		const feedId = rest.slice(0, len);
		const localId = rest.slice(len);
		const serviceHandle = serviceHandleFor(feedId, localId);
		const dates = getServiceDatesByService({ feedId, localId }, ctx);
		for (const d of dates) {
			let set = ctx.runtimeState.servicesByDateHandle.get(d);
			if (!set) { set = new Set(); ctx.runtimeState.servicesByDateHandle.set(d, set); }
			set.add(serviceHandle);
		}
	}
	for (const [serviceKey, exceptions] of ctx.runtimeState.serviceCalendarExceptions) {
		const colon = serviceKey.indexOf(":");
		if (colon < 0) continue;
		const len = parseInt(serviceKey.slice(0, colon), 10);
		const rest = serviceKey.slice(colon+1);
		const feedId = rest.slice(0, len);
		const localId = rest.slice(len);
		const serviceHandle = serviceHandleFor(feedId, localId);
		for (const [epochDay, exc] of exceptions) {
			if (exc !== 1) continue;
			const date = getServiceDateFromEpochDay(epochDay);
			let set = ctx.runtimeState.servicesByDateHandle.get(date);
			if (!set) { set = new Set(); ctx.runtimeState.servicesByDateHandle.set(date, set); }
			set.add(serviceHandle);
		}
	}
}
