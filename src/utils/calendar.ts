import type * as qdf from "qdf-gtfs";
import { getRawTrips, getCalendars, getCalendarDates, CacheContext } from "../cache.js";
import { getEpochDayFromServiceDate } from "./time.js";
import {
	clearStaticData,
	addWasmCalendar,
	addWasmCalendarDate,
	getServiceDatesByTripWasm,
	addWasmTripRecord,
} from "../../build/release.js";

export function getServiceDatesByTrip(
	trip_id: string,
	_ctx: CacheContext,
	minEpochDay: number = -1,
	maxEpochDay: number = -1,
): string[] {
	const dates = getServiceDatesByTripWasm(trip_id);
	const hasMin = minEpochDay >= 0;
	const hasMax = maxEpochDay >= 0;
	if (!hasMin && !hasMax) return dates;

	return dates.filter((date) => {
		const epochDay = getEpochDayFromServiceDate(date);
		if (!Number.isFinite(epochDay)) return false;
		if (hasMin && epochDay < minEpochDay) return false;
		if (hasMax && epochDay > maxEpochDay) return false;
		return true;
	});
}

export function syncCalendarsToWasm(ctx: CacheContext) {
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
