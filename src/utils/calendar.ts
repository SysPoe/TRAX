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
	const service_id = _ctx.raw.tripServiceIds?.get(trip_id);
	if (!service_id) return [];
	const dates = getServiceDatesForServiceId(service_id, _ctx);
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

function getServiceDatesForServiceId(service_id: string, ctx: CacheContext): string[] {
	const calendar = getCalendars(ctx).find(c => c.service_id === service_id);
	if (!calendar) return [];
	const calendarDates = getCalendarDates(ctx).filter(cd => cd.service_id === service_id);

	const dates = new Set<string>();

	// Add from calendar_dates additions
	for (const cd of calendarDates) {
		if (cd.exception_type === 1 && cd.date) dates.add(cd.date);
	}

	// Add from calendar
	const start = new Date(calendar.start_date.slice(0,4) + '-' + calendar.start_date.slice(4,6) + '-' + calendar.start_date.slice(6,8));
	const end = new Date(calendar.end_date.slice(0,4) + '-' + calendar.end_date.slice(4,6) + '-' + calendar.end_date.slice(6,8));

	for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
		const day = d.getDay();
		let runs = false;
		if (day === 0 && calendar.sunday) runs = true;
		else if (day === 1 && calendar.monday) runs = true;
		else if (day === 2 && calendar.tuesday) runs = true;
		else if (day === 3 && calendar.wednesday) runs = true;
		else if (day === 4 && calendar.thursday) runs = true;
		else if (day === 5 && calendar.friday) runs = true;
		else if (day === 6 && calendar.saturday) runs = true;

		if (runs) {
			const dateStr = d.toISOString().slice(0,10).replace(/-/g, '');
			dates.add(dateStr);
		}
	}

	// Remove exceptions
	for (const cd of calendarDates) {
		if (cd.exception_type === 2 && cd.date) dates.delete(cd.date);
	}

	return Array.from(dates).sort();
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
