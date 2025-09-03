import type * as gtfs from "gtfs";
import { AugmentedStop } from "./augmentedStop.js";
export declare enum ScheduleRelationship {
    "SCHEDULED" = 0,
    "ADDED" = 1,
    "UNSCHEDULED" = 2,
    "CANCELED" = 3,
    "REPLACEMENT" = 4,
    "DUPLICATED" = 5,
    "NEW" = 6,
    "DELETED" = 7
}
export type AugmentedStopTime = {
    toSerializable: () => SerializableAugmentedStopTime;
    _stopTime: gtfs.StopTime | null;
    trip_id: string;
    passing: boolean;
    actual_arrival_timestamp: number | null;
    actual_departure_timestamp: number | null;
    actual_stop: AugmentedStop | null;
    actual_parent_station: AugmentedStop | null;
    actual_platform_code: string | null;
    rt_stop_updated: boolean;
    rt_parent_station_updated: boolean;
    rt_platform_code_updated: boolean;
    rt_arrival_updated: boolean;
    rt_departure_updated: boolean;
    scheduled_arrival_timestamp: number | null;
    scheduled_departure_timestamp: number | null;
    scheduled_stop: AugmentedStop | null;
    scheduled_parent_station: AugmentedStop | null;
    scheduled_platform_code: string | null;
    scheduled_arrival_dates: number[];
    actual_arrival_dates: number[];
    scheduled_arrival_date_offset: number;
    actual_arrival_date_offset: number;
    scheduled_departure_dates: number[];
    actual_departure_dates: number[];
    scheduled_departure_date_offset: number;
    actual_departure_date_offset: number;
    realtime: boolean;
    realtime_info: {
        delay_secs: number;
        delay_string: "on time" | "scheduled" | string;
        delay_class: "on-time" | "scheduled" | "late" | "very-late" | "early";
        schedule_relationship: ScheduleRelationship;
        propagated: boolean;
    } | null;
};
export type SerializableAugmentedStopTime = Omit<AugmentedStopTime, "actual_stop" | "actual_parent_station" | "scheduled_stop" | "scheduled_parent_station" | "toSerializable"> & {
    actual_stop: string | null;
    actual_parent_station: string | null;
    scheduled_stop: string | null;
    scheduled_parent_station: string | null;
};
export declare function toSerializableAugmentedStopTime(st: Omit<AugmentedStopTime, "toSerializable">): SerializableAugmentedStopTime;
export declare function augmentStopTimes(stopTimes: gtfs.StopTime[], serviceDates: number[]): AugmentedStopTime[];
