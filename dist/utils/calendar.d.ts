import type * as gtfs from "gtfs";
export declare function getServiceDates(calendars: gtfs.Calendar[], calendarDates: gtfs.CalendarDate[]): Record<string, number[]>;
/**
 * Get service dates for a specific trip or trip_id using GTFS data directly.
 * @param {string} trip_id - Trip object or trip_id string.
 * @returns {number[]} Array of service dates for the trip.
 */
export declare function getServiceDatesByTrip(trip_id: string): number[];
