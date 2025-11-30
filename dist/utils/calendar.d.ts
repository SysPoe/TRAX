import type * as qdf from "qdf-gtfs";
export declare function getServiceDates(calendars: qdf.Calendar[], calendarDates: qdf.CalendarDate[]): Record<string, string[]>;
export declare function getServiceDatesByTrip(trip_id: string): string[];
