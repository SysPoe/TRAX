import { getRawTrips, getCalendars, getCalendarDates, CacheContext } from "../cache/index.js";
import { getEpochDayFromServiceDate } from "./time.js";
import {
	clearStaticData,
	addWasmCalendar,
	addWasmCalendarDate,
	addWasmTripRecord,
	getServiceDatesForServiceIdWasm,
} from "../../build/release.js";

/**
 * Caches filtered service-date arrays by (service_id, minEpochDay, maxEpochDay).
 * Many trips share the same service_id, so computing once per service_id per horizon
 * avoids redundant WASM calls and epoch-day filtering across the entire trip set.
 * Cleared by syncCalendarsToWasm at the start of each static refresh.
 */
const serviceDateCache = new Map<string, string[]>();

export function getServiceDatesByTrip(
	trip_id: string,
	_ctx: CacheContext,
	minEpochDay: number = -1,
	maxEpochDay: number = -1,
): string[] {
	const service_id = _ctx.raw.tripServiceIds?.get(trip_id);
	if (!service_id) return [];

	const cacheKey = `${service_id}|${minEpochDay}|${maxEpochDay}`;
	const cached = serviceDateCache.get(cacheKey);
	if (cached !== undefined) return cached;

	const dates = getServiceDatesForServiceIdWasm(service_id);
	const hasMin = minEpochDay >= 0;
	const hasMax = maxEpochDay >= 0;

	let result: string[];
	if (!hasMin && !hasMax) {
		result = dates;
	} else {
		result = dates.filter((date) => {
			const epochDay = getEpochDayFromServiceDate(date);
			if (!Number.isFinite(epochDay)) return false;
			if (hasMin && epochDay < minEpochDay) return false;
			if (hasMax && epochDay > maxEpochDay) return false;
			return true;
		});
	}

	serviceDateCache.set(cacheKey, result);
	return result;
}

export function syncCalendarsToWasm(ctx: CacheContext) {
	// Invalidate per-service_id date cache so a fresh WASM state is reflected.
	serviceDateCache.clear();
	clearStaticData();
	const calendars = getCalendars(ctx);
	for (const c of calendars) {
		addWasmCalendar(
			c.service_id,
			!!c.monday,
			!!c.tuesday,
			!!c.wednesday,
			!!c.thursday,
			!!c.friday,
			!!c.saturday,
			!!c.sunday,
			String(c.start_date),
			String(c.end_date),
		);
	}
	const calendarDates = getCalendarDates(ctx);
	for (const cd of calendarDates) {
		addWasmCalendarDate(cd.service_id, String(cd.date), cd.exception_type ?? 0);
	}
	const trips = getRawTrips(ctx);
	for (const t of trips) {
		addWasmTripRecord(t.trip_id, t.service_id);
	}
}
