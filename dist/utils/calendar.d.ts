import type * as gtfsTypes from "qdf-gtfs";
export declare function getServiceDates(calendars: gtfsTypes.Calendar[], calendarDates: gtfsTypes.CalendarDate[]): Record<string, string[]>;
export declare function getServiceDatesByTrip(trip_id: string): string[];
