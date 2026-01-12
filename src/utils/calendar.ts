import type * as qdf from "qdf-gtfs";
import { getRawTrips, getCalendars, getCalendarDates, CacheContext } from "../cache.js";
import {
	clearStaticData,
	addWasmCalendar,
	addWasmCalendarDate,
	getServiceDatesByTripWasm,
	addWasmTripRecord,
} from "../../build/release.js";

export function getServiceDatesByTrip(trip_id: string, _ctx: CacheContext): string[] {
	return getServiceDatesByTripWasm(trip_id);
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
			String(c.end_date)
		);
	}
	const calendarDates = getCalendarDates(ctx);
	for (const cd of calendarDates) {
		addWasmCalendarDate(cd.service_id, String(cd.date), cd.exception_type);
	}
	const trips = getRawTrips(ctx);
	for (const t of trips) {
		addWasmTripRecord(t.trip_id, t.service_id);
	}
}
