import type * as gtfs from "gtfs";
export declare function getServiceDates(calendars: gtfs.Calendar[], calendarDates: gtfs.CalendarDate[]): Record<string, number[]>;
export declare function getServiceDatesByTrip(trip_id: string): number[];
