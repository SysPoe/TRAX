import * as gtfs from "gtfs";
import { getRawTrips } from "../cache.js";

export function getServiceDates(
	calendars: gtfs.Calendar[],
	calendarDates: gtfs.CalendarDate[],
): Record<string, number[]> {
	const serviceDates: Record<string, number[]> = {};

	for (const calendar of calendars) {
		const {
			service_id,
			monday,
			tuesday,
			wednesday,
			thursday,
			friday,
			saturday,
			sunday,
			start_date,
			end_date,
		} = calendar;

		serviceDates[service_id] = serviceDates[service_id] || [];

		let currentDate = new Date(
			String(start_date).substring(0, 4) +
				"-" +
				String(start_date).substring(4, 6) +
				"-" +
				String(start_date).substring(6, 8),
		);
		const endDate = new Date(
			String(end_date).substring(0, 4) +
				"-" +
				String(end_date).substring(4, 6) +
				"-" +
				String(end_date).substring(6, 8),
		);

		while (currentDate <= endDate) {
			const dayOfWeek = currentDate.getDay(); // 0 for Sunday, 1 for Monday, etc.
			const dateAsNumber = parseInt(
				currentDate.toISOString().slice(0, 10).replace(/-/g, ""),
				10,
			);

			let serviceRuns = false;
			if (dayOfWeek === 1 && monday === 1) serviceRuns = true;
			if (dayOfWeek === 2 && tuesday === 1) serviceRuns = true;
			if (dayOfWeek === 3 && wednesday === 1) serviceRuns = true;
			if (dayOfWeek === 4 && thursday === 1) serviceRuns = true;
			if (dayOfWeek === 5 && friday === 1) serviceRuns = true;
			if (dayOfWeek === 6 && saturday === 1) serviceRuns = true;
			if (dayOfWeek === 0 && sunday === 1) serviceRuns = true;

			if (serviceRuns) {
				serviceDates[service_id].push(dateAsNumber);
			}

			currentDate.setDate(currentDate.getDate() + 1);
		}
	}

	for (const calendarDate of calendarDates) {
		const { service_id, date, exception_type } = calendarDate;
		serviceDates[service_id] = serviceDates[service_id] || [];

		if (exception_type === 1) {
			// Service added
			if (!serviceDates[service_id].includes(date)) {
				serviceDates[service_id].push(date);
			}
		} else if (exception_type === 2) {
			// Service removed
			const index = serviceDates[service_id].indexOf(date);
			if (index > -1) {
				serviceDates[service_id].splice(index, 1);
			}
		}
	}

	for (const service_id in serviceDates) {
		serviceDates[service_id].sort((a, b) => a - b);
	}

	return serviceDates;
}

/**
 * Get service dates for a specific trip or trip_id using GTFS data directly.
 * @param {string} trip_id - Trip object or trip_id string.
 * @returns {number[]} Array of service dates for the trip.
 */
export function getServiceDatesByTrip(trip_id: string): number[] {
	const trips = getRawTrips().filter((v) => v.trip_id === trip_id);
	const trip = trips && trips.length > 0 ? trips[0] : undefined;
	if (!trip) return [];
	const calendars = gtfs.getCalendars({ service_id: trip.service_id });
	const calendarDates = gtfs.getCalendarDates({
		service_id: trip.service_id,
	});
	const serviceDatesMap = getServiceDates(calendars, calendarDates);
	return serviceDatesMap[trip.service_id] || [];
}
