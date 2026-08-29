import type { Calendar, CalendarDate, QualifiedEntityId } from "qdf-gtfs";
import type { CacheContext } from "../cache/index.js";
import { getEpochDayFromServiceDate, getServiceDateFromEpochDay } from "./time.js";
import { entityKey } from "../identity.js";

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
export function syncCalendarsToWasm(
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
