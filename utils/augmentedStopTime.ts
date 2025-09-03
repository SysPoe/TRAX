import type * as gtfs from "gtfs";
import { AugmentedStop } from "./augmentedStop.js";
import * as cache from "../cache.js";
import { findExpress } from "./express.js";
import { getSRT } from "./srt.js";
import TRAX, { DEBUG, today } from "../index.js";

// Simple hash function for stop lists
function hashStopList(stops: string[]): string {
  return stops.join('|');
}

export enum ScheduleRelationship {
  "SCHEDULED",    // 0
  "ADDED",        // 1
  "UNSCHEDULED",  // 2
  "CANCELLED",    // 3
  "REPLACEMENT",  // 4
  "DUPLICATED",   // 5
  "NEW",          // 6
  "DELETED",      // 7
}

export type AugmentedStopTime = {
  toSerializable: () => SerializableAugmentedStopTime;

  _stopTime: gtfs.StopTime | null;
  trip_id: string;

  passing: boolean;

  // The actual ones, which are either realtime if availble, or scheduled otherwise

  // Timestamp in seconds since midnight of the offset day
  // e.g. for a trip with the date 20250101 and a arrival time of 25:30:00,
  // the arrival timestamp would be 1:30:00 (1 * 3600 + 30 * 60) with a
  // arrival date offset of +1 day
  actual_arrival_timestamp: number | null;
  actual_departure_timestamp: number | null;
  actual_stop: AugmentedStop | null;
  actual_parent_station: AugmentedStop | null;
  actual_platform_code: string | null;

  // Information on whether the actual_* fields were updated by realtime data
  rt_stop_updated: boolean;
  rt_parent_station_updated: boolean;
  rt_platform_code_updated: boolean;
  rt_arrival_updated: boolean;
  rt_departure_updated: boolean;

  scheduled_arrival_timestamp: number | null; // Timestamp in seconds since midnight of the offset day
  scheduled_departure_timestamp: number | null; // Timestamp in seconds since midnight of the offset day
  scheduled_stop: AugmentedStop | null;
  scheduled_parent_station: AugmentedStop | null;
  scheduled_platform_code: string | null;

  scheduled_arrival_dates: number[]; // Dates in the format YYYYMMDD as a number
  actual_arrival_dates: number[]; // Dates in the format YYYYMMDD as a number
  scheduled_arrival_date_offset: number; // Offset from the trip's start date e.g. +1 day
  actual_arrival_date_offset: number; // Offset from the trip's start date e.g. +1 day

  scheduled_departure_dates: number[]; // Dates in the format YYYYMMDD as a number
  actual_departure_dates: number[]; // Dates in the format YYYYMMDD as a number
  scheduled_departure_date_offset: number; // Offset from the trip's start date e.g. +1 day
  actual_departure_date_offset: number; // Offset from the trip's start date e.g. +1 day

  realtime: boolean;
  realtime_info: {
    delay_secs: number;
    delay_string: "on time" | "scheduled" | string; // e.g. 2m late
    delay_class: "on-time" | "scheduled" | "late" | "very-late" | "early";
    schedule_relationship: ScheduleRelationship;
    propagated: boolean;
  } | null;
};

export type SerializableAugmentedStopTime = Omit<
  AugmentedStopTime,
  | "actual_stop"
  | "actual_parent_station"
  | "scheduled_stop"
  | "scheduled_parent_station"
  | "toSerializable"
> & {
  actual_stop: string | null;
  actual_parent_station: string | null;
  scheduled_stop: string | null;
  scheduled_parent_station: string | null;
};

export function toSerializableAugmentedStopTime(
  st: Omit<AugmentedStopTime, "toSerializable">
): SerializableAugmentedStopTime {
  return {
    ...st,
    actual_stop: st.actual_stop?.stop_id ?? null,
    actual_parent_station: st.actual_parent_station?.stop_id ?? null,
    scheduled_stop: st.scheduled_stop?.stop_id ?? null,
    scheduled_parent_station: st.scheduled_parent_station?.stop_id ?? null,
  };
}

type PassingStopSRT = {
  from: string;
  to: string;
  emu: number;
  passing: boolean;
};

type PassingStopTime = gtfs.StopTime & { _passing: boolean };

function findPassingStops(
  stops: string[]
): { stop_id: string; passing: boolean }[] {
  const stopListHash = hashStopList(stops);

  // Check cache first
  const cached = cache.getCachedPassingStops(stopListHash);
  if (cached) {
    return cached;
  }

  let express = findExpress(stops);
  let allStops: { stop_id: string; passing: boolean }[] = [];

  for (const e of express) {
    if (e.type == "unknown_segment") {
      console.error(
        `Unknown segment between ${e.from} and ${e.to}: ${e.message}`
      );
      continue;
    }
    if (e.type == "local") {
      if (allStops.at(-1)?.stop_id != e.from)
        allStops.push({ stop_id: e.from, passing: false });
      for (
        let i = stops.findIndex((v) => v == e.from) + 1;
        i <= stops.length;
        i++
      ) {
        if (stops[i] == e.to) break;
        allStops.push({ stop_id: stops[i], passing: false });
      }
      continue;
    }
    if (allStops.at(-1)?.stop_id != e.from)
      allStops.push({ stop_id: e.from, passing: false });
    allStops.push(
      ...(e.skipping?.map((v) => ({ stop_id: v, passing: true })) || [])
    );
    if (allStops.at(-1)?.stop_id != e.to)
      allStops.push({ stop_id: e.to, passing: false });
  }

  // Cache the result
  cache.cachePassingStops(stopListHash, allStops);

  return allStops;
}

function findPassingStopSRTs(stops: string[]): PassingStopSRT[] {
  let allStops = findPassingStops(stops);

  let allStopSRTs: PassingStopSRT[] = [];
  for (let i = 0; i < allStops.length - 1; i++) {
    let srt = getSRT(allStops[i].stop_id, allStops[i + 1].stop_id);
    if (srt === undefined) {
      // if (DEBUG)
      if (false)
        console.error(
          "[ERROR] No SRT found between",
          allStops[i],
          "and",
          allStops[i + 1]
        );

      allStopSRTs.push({
        from: allStops[i].stop_id,
        to: allStops[i + 1].stop_id,
        emu: 1,
        passing: allStops[i + 1].passing,
      });
      continue;
    }
    allStopSRTs.push({
      from: allStops[i].stop_id,
      to: allStops[i + 1].stop_id,
      emu: srt,
      passing: allStops[i + 1].passing,
    });
  }

  return allStopSRTs;
}

function findPassingStopTimes(stopTimes: gtfs.StopTime[]): PassingStopTime[] {
  let stops = stopTimes
    .sort((a, b) => (a.stop_sequence ?? 0) - (b.stop_sequence ?? 0))
    .map((st) => cache.getRawStops(st.stop_id)[0]?.parent_station)
    .filter((v) => v != undefined) as string[];
  let idsToTimes: Record<string, gtfs.StopTime> = {};
  for (let st of stopTimes) {
    let parent = cache.getRawStops(st.stop_id)[0]?.parent_station;
    if (!parent) continue;
    if (!idsToTimes[parent]) idsToTimes[parent] = st;
  }

  let passingSRTs = findPassingStopSRTs(stops);
  let passingRun: PassingStopSRT[] = [];
  if (!passingSRTs || passingSRTs.length === 0) {
    console.error("No passing SRTs found for stops", stops);
    return [];
  }
  let times: PassingStopTime[] = [
    { ...idsToTimes[passingSRTs[0].from], _passing: false },
  ];

  for (let srt of passingSRTs) {
    if (srt.passing) {
      passingRun.push(srt);
      continue;
    }

    if (passingRun.length == 0) {
      times.push({ ...idsToTimes[srt.to], _passing: false });
      continue;
    }

    let startTime = times.at(-1);
    let endTime = idsToTimes[srt.to];

    if (!startTime) {
      console.error(
        "ERROR: Start time should not be undefined",
        startTime,
        srt
      );
      continue;
    }
    if (!endTime) {
      console.error(
        "ERROR: End time should not be undefined",
        endTime,
        srt.to,
        srt
      );
      continue;
    }
    if (!startTime.departure_timestamp)
      console.error(
        "ERROR: Start time should not be undefined",
        startTime,
        srt
      );
    if (!endTime.departure_timestamp)
      console.error("ERROR: End time should not be undefined", endTime, srt);
    if (!startTime.departure_timestamp || !endTime.departure_timestamp)
      continue;

    let timeDifference = Math.floor(
      (endTime.departure_timestamp - startTime.departure_timestamp) / 60
    );
    let totalTimePass = passingRun.reduce((acc, curr) => acc + curr.emu, 0);
    let rescaledAccumulatedPassingRuns = passingRun
      .map((v) => ({
        ...v,
        emu: Math.floor((v.emu / totalTimePass) * timeDifference),
      }))
      .reduce((acc, curr) => {
        if (acc.length === 0) {
          acc.push(curr);
        } else {
          let last = acc[acc.length - 1];
          acc.push({
            ...curr,
            emu: last.emu + curr.emu,
          });
        }
        return acc;
      }, [] as PassingStopSRT[]);

    for (let i = 0; i < rescaledAccumulatedPassingRuns.length; i++) {
      let run = rescaledAccumulatedPassingRuns[i];
      if (run.emu <= 0) continue;
      times.push({
        _passing: true,
        stop_id: run.to,
        trip_id: stopTimes[0].trip_id,
        stop_sequence:
          stopTimes[0].stop_sequence +
          i / rescaledAccumulatedPassingRuns.length,
        departure_timestamp: startTime.departure_timestamp + run.emu * 60,
        arrival_timestamp:
          (startTime.arrival_timestamp || startTime.departure_timestamp) +
          run.emu * 60,
      });
    }

    times.push({ ...endTime, _passing: false });
    passingRun = [];
  }

  if (
    times.at(-1) &&
    stopTimes.at(-1) &&
    times.at(-1)!.stop_sequence != stopTimes.at(-1)!.stop_sequence
  )
    times.push({ ...stopTimes.at(-1)!, _passing: false });

  return times;
}

export function augmentStopTimes(
  stopTimes: gtfs.StopTime[],
  serviceDates: number[] // Dates in the format YYYYMMDD as a number
): AugmentedStopTime[] {
  if (!stopTimes.map((v) => v.trip_id == stopTimes[0].trip_id).every((v) => v))
    console.error(
      "[ERROR] All stopTimes must belong to the same trip: ",
      stopTimes[0].trip_id,
      stopTimes
    );

  let initialScheduledArrivalTimestamp;
  let initialScheduledDepartureTimestamp;
  let initialActualArrivalTimestamp;
  let initialActualDepartureTimestamp;

  let realtimeUpdates = cache
    .getStopTimeUpdates()
    .filter((v) => v.trip_id === stopTimes[0].trip_id)
    .sort((a, b) => (a.stop_sequence ?? 0) - (b.stop_sequence ?? 0));

  let tripUpdate = cache.getTripUpdates().find((tu: any) => tu.trip_id === stopTimes[0].trip_id)

  let passingStopTimes = findPassingStopTimes(stopTimes);

  let augmentedStopTimes: AugmentedStopTime[] = [];

  // Propagation state
  let lastDelay = 0;
  let lastScheduleRelationship = ScheduleRelationship.SCHEDULED;
  let lastPlatformCode = null;

  let propagateOnTime = tripUpdate && tripUpdate.schedule_relationship === "SCHEDULED";

  for (let passingStopTime of passingStopTimes) {
    let stopId = passingStopTime.stop_id;

    // Get the actual stop information
    let actualStop = cache.getAugmentedStops(stopId)[0];
    let actualParentStation = actualStop?.parent_station
      ? cache.getAugmentedStops(actualStop.parent_station)[0]
      : null;

    let realtimeUpdate = realtimeUpdates.find(
      (update) =>
        update.stop_id == stopId ||
        actualParentStation?.stop_id == update.stop_id ||
        cache
          .getAugmentedStops(stopId)[0]
          .children.some((child) => child.stop_id == update.stop_id)
    );

    // Get scheduled stop information
    let scheduledStop = cache.getAugmentedStops(stopId)[0];
    let scheduledParentStation = scheduledStop?.parent_station
      ? cache.getAugmentedStops(scheduledStop.parent_station)[0]
      : null;

    // Calculate timestamps
    let scheduledArrivalTimestamp = passingStopTime.arrival_timestamp;
    let scheduledDepartureTimestamp = passingStopTime.departure_timestamp;

    let actualArrivalTimestamp = scheduledArrivalTimestamp;
    let actualDepartureTimestamp = scheduledDepartureTimestamp;

    // Propagation logic
    let rtArrivalUpdated = false;
    let rtDepartureUpdated = false;
    let rtStopUpdated = false;
    let rtParentStationUpdated = false;
    let rtPlatformCodeUpdated = false;
    let propagated = false;

    let delaySecs = lastDelay;
    let platformCode: string | null = lastPlatformCode;
    let scheduleRelationship: ScheduleRelationship = lastScheduleRelationship;

    if (realtimeUpdate) {
      if (realtimeUpdate.departure_delay !== undefined) {
        actualDepartureTimestamp =
          scheduledDepartureTimestamp !== undefined
            ? scheduledDepartureTimestamp + realtimeUpdate.departure_delay
            : undefined;
        rtDepartureUpdated = true;
        delaySecs = realtimeUpdate.departure_delay;
        lastDelay = delaySecs;
        propagated = false;
      } else if (lastDelay) {
        actualDepartureTimestamp =
          scheduledDepartureTimestamp !== undefined
            ? scheduledDepartureTimestamp + lastDelay
            : undefined;
        propagated = true;
      }
      if (realtimeUpdate.arrival_delay !== undefined) {
        actualArrivalTimestamp =
          scheduledArrivalTimestamp !== undefined
            ? scheduledArrivalTimestamp + realtimeUpdate.arrival_delay
            : undefined;
        rtArrivalUpdated = true;
        delaySecs = realtimeUpdate.arrival_delay;
        lastDelay = delaySecs;
        propagated = false;
      } else if (lastDelay) {
        actualArrivalTimestamp =
          scheduledArrivalTimestamp !== undefined
            ? scheduledArrivalTimestamp + lastDelay
            : undefined;
        propagated = true;
      }
      if (cache.getRawStops(realtimeUpdate.stop_id)[0]?.platform_code) {
        platformCode =
          cache.getRawStops(realtimeUpdate.stop_id)[0]?.platform_code ?? null;
        lastPlatformCode = platformCode;
        rtPlatformCodeUpdated = true;
      }
      if (realtimeUpdate.schedule_relationship) {
        scheduleRelationship =
          ScheduleRelationship[
          realtimeUpdate.schedule_relationship as keyof typeof ScheduleRelationship
          ] ?? ScheduleRelationship.SCHEDULED;
        lastScheduleRelationship = scheduleRelationship;
      }
      if (realtimeUpdate.stop_id && realtimeUpdate.stop_id !== stopId) {
        actualStop = cache.getAugmentedStops(realtimeUpdate.stop_id)[0];
        actualParentStation = actualStop?.parent_station
          ? cache.getAugmentedStops(actualStop.parent_station)[0]
          : null;
        rtStopUpdated = true;
        rtParentStationUpdated = true;
      }
    } else if (lastDelay) {
      // Propagate previous delay if no explicit update
      actualArrivalTimestamp =
        scheduledArrivalTimestamp !== undefined
          ? scheduledArrivalTimestamp + lastDelay
          : undefined;
      actualDepartureTimestamp =
        scheduledDepartureTimestamp !== undefined
          ? scheduledDepartureTimestamp + lastDelay
          : undefined;
      propagated = true;
    } else if (propagateOnTime) {
      // No realtime updates, but tripUpdate is SCHEDULED: propagate on time
      delaySecs = 0;
      propagated = true;
      scheduleRelationship = ScheduleRelationship.SCHEDULED;
    }

    // Calculate realtime info
    let realtimeInfo = null;
    let hasRealtime = !!realtimeUpdate || propagated;

    if (hasRealtime) {
      let delayString: string;
      let delayClass: "on-time" | "scheduled" | "late" | "very-late" | "early";

      if (delaySecs === 0) {
        delayString = "on time";
        delayClass = "on-time";
      } else if (Math.abs(delaySecs) <= 60) {
        delayString = "on time";
        delayClass = "on-time";
      } else if (delaySecs > 0 && delaySecs <= 300) {
        delayString = `${Math.round(delaySecs / 60)}m late`;
        delayClass = "late";
      } else if (delaySecs > 300) {
        delayString = `${Math.round(delaySecs / 60)}m late`;
        delayClass = "very-late";
      } else {
        delayString = `${Math.round(Math.abs(delaySecs) / 60)}m early`;
        delayClass = "early";
      }

      propagated = propagated && !passingStopTime._passing;

      realtimeInfo = {
        delay_secs: delaySecs,
        delay_string: delayString as "on time" | "scheduled" | string,
        delay_class: delayClass,
        schedule_relationship: scheduleRelationship,
        propagated,
      };
    }

    if(passingStopTime.stop_sequence == 1) {
      initialScheduledArrivalTimestamp = scheduledArrivalTimestamp;
      initialScheduledDepartureTimestamp = scheduledDepartureTimestamp;
      initialActualArrivalTimestamp = actualArrivalTimestamp;
      initialActualDepartureTimestamp = actualDepartureTimestamp;
    }

    let initial_scheduled_arrival_date_offset = initialScheduledArrivalTimestamp ? Math.floor(initialScheduledArrivalTimestamp / 86400) : 0;
    let initial_scheduled_departure_date_offset = initialScheduledDepartureTimestamp ? Math.floor(initialScheduledDepartureTimestamp / 86400) : 0;
    let initial_actual_arrival_date_offset = initialActualArrivalTimestamp ? Math.floor(initialActualArrivalTimestamp / 86400) : 0;
    let initial_actual_departure_date_offset = initialActualDepartureTimestamp ? Math.floor(initialActualDepartureTimestamp / 86400) : 0;

    // Calculate arrival/departure date offsets
    let scheduled_arrival_date_offset = scheduledArrivalTimestamp ? Math.floor(scheduledArrivalTimestamp / 86400) : 0;
    let actual_arrival_date_offset = actualArrivalTimestamp ? Math.floor(actualArrivalTimestamp / 86400) : 0;
    let scheduled_departure_date_offset = scheduledDepartureTimestamp ? Math.floor(scheduledDepartureTimestamp / 86400) : 0;
    let actual_departure_date_offset = actualDepartureTimestamp ? Math.floor(actualDepartureTimestamp / 86400) : 0;

    let scheduled_arrival_dates = serviceDates.map(d => d + scheduled_arrival_date_offset);
    let scheduled_departure_dates = serviceDates.map(d => d + scheduled_departure_date_offset);

    let actual_arrival_dates = serviceDates.map(d =>
      d == today() ? d + actual_arrival_date_offset : d + scheduled_arrival_date_offset
    );
    let actual_departure_dates = serviceDates.map(d =>
      d == today() ? d + actual_departure_date_offset : d + scheduled_departure_date_offset
    );

    scheduled_arrival_date_offset -= initial_scheduled_arrival_date_offset;
    actual_arrival_date_offset -= initial_actual_arrival_date_offset;
    scheduled_departure_date_offset -= initial_scheduled_departure_date_offset;
    actual_departure_date_offset -= initial_actual_departure_date_offset;

    let partialAugmentedStopTime: Omit<AugmentedStopTime, "toSerializable"> = {
      _stopTime: passingStopTime._passing ? null : passingStopTime,
      trip_id: stopTimes[0].trip_id,
      passing: passingStopTime._passing,
      actual_arrival_timestamp: actualArrivalTimestamp ? actualArrivalTimestamp % 86400 : null,
      actual_departure_timestamp: actualDepartureTimestamp ? actualDepartureTimestamp % 86400 : null,
      actual_stop: actualStop,
      actual_parent_station: actualParentStation,
      actual_platform_code: passingStopTime._passing
        ? null
        : (platformCode ?? scheduledStop.platform_code ?? null),
      rt_stop_updated: rtStopUpdated,
      rt_parent_station_updated: rtParentStationUpdated,
      rt_platform_code_updated: rtPlatformCodeUpdated,
      rt_arrival_updated: rtArrivalUpdated,
      rt_departure_updated: rtDepartureUpdated,
      scheduled_arrival_timestamp: scheduledArrivalTimestamp ? scheduledArrivalTimestamp % 86400 : null,
      scheduled_departure_timestamp: scheduledDepartureTimestamp ? scheduledDepartureTimestamp % 86400 : null,
      scheduled_stop: scheduledStop,
      scheduled_parent_station: scheduledParentStation,
      scheduled_platform_code: passingStopTime._passing
        ? null
        : (scheduledStop.platform_code ?? null),
      realtime: hasRealtime,
      realtime_info: realtimeInfo,
      scheduled_arrival_dates,
      actual_arrival_dates,
      scheduled_arrival_date_offset,
      actual_arrival_date_offset,
      scheduled_departure_dates,
      actual_departure_dates,
      scheduled_departure_date_offset,
      actual_departure_date_offset,
    };

    augmentedStopTimes.push({
      ...partialAugmentedStopTime,
      toSerializable: () =>
        toSerializableAugmentedStopTime(partialAugmentedStopTime),
    });
  }

  return augmentedStopTimes;
}
