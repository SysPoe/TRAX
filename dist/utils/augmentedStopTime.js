import * as qdf from "qdf-gtfs";
import * as cache from "../cache.js";
import { findExpress } from "./express.js";
import { getSRT } from "./srt.js";
import { today } from "../index.js";
import platformData from "./platformData/data.js";
import logger from "./logger.js";
// Simple hash function for stop lists
function hashStopList(stops) {
    return stops.join("|");
}
export function toSerializableAugmentedStopTime(st) {
    return {
        ...st,
        actual_stop: st.actual_stop?.stop_id ?? null,
        actual_parent_station: st.actual_parent_station?.stop_id ?? null,
        scheduled_stop: st.scheduled_stop?.stop_id ?? null,
        scheduled_parent_station: st.scheduled_parent_station?.stop_id ?? null,
    };
}
function findPassingStops(stops) {
    const stopListHash = hashStopList(stops);
    // Check cache first
    const cached = cache.getCachedPassingStops(stopListHash);
    if (cached) {
        return cached;
    }
    let express = findExpress(stops);
    let allStops = [];
    for (const e of express) {
        if (e.type == "unknown_segment") {
            logger.error(`Unknown segment between ${e.from} and ${e.to}: ${e.message}`, {
                module: "augmentedStopTime",
                function: "findPassingStops",
            });
            continue;
        }
        if (e.type == "local") {
            if (allStops.at(-1)?.stop_id != e.from)
                allStops.push({ stop_id: e.from, passing: false });
            for (let i = stops.findIndex((v) => v == e.from) + 1; i <= stops.length; i++) {
                if (stops[i] == e.to)
                    break;
                allStops.push({ stop_id: stops[i], passing: false });
            }
            continue;
        }
        if (allStops.at(-1)?.stop_id != e.from)
            allStops.push({ stop_id: e.from, passing: false });
        allStops.push(...(e.skipping?.map((v) => ({ stop_id: v, passing: true })) || []));
        if (allStops.at(-1)?.stop_id != e.to)
            allStops.push({ stop_id: e.to, passing: false });
    }
    // Cache the result
    cache.cachePassingStops(stopListHash, allStops);
    return allStops;
}
let logged = {};
function findPassingStopSRTs(stops) {
    let allStops = findPassingStops(stops);
    let allStopSRTs = [];
    for (let i = 0; i < allStops.length - 1; i++) {
        let srt = getSRT(allStops[i].stop_id, allStops[i + 1].stop_id);
        if (srt === undefined) {
            if (!logged[allStops[i].stop_id]?.[allStops[i + 1].stop_id]) {
                logger.error(`No SRT found between ${allStops[i].stop_id} and ${allStops[i + 1].stop_id}`, {
                    module: "augmentedStopTime",
                    function: "findPassingStopSRTs",
                });
            }
            logged[allStops[i].stop_id] = logged[allStops[i].stop_id] || {};
            logged[allStops[i].stop_id][allStops[i + 1].stop_id] = true;
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
function findPassingStopTimes(stopTimes) {
    let stops = stopTimes
        .sort((a, b) => (a.stop_sequence ?? 0) - (b.stop_sequence ?? 0))
        .map((st) => cache.getRawStops(st.stop_id)[0]?.parent_station)
        .filter((v) => v != undefined);
    let idsToTimes = {};
    for (let st of stopTimes) {
        let parent = cache.getRawStops(st.stop_id)[0]?.parent_station;
        if (!parent)
            continue;
        if (!idsToTimes[parent])
            idsToTimes[parent] = st;
    }
    let passingSRTs = findPassingStopSRTs(stops);
    let passingRun = [];
    if (!passingSRTs || passingSRTs.length === 0) {
        logger.error(`No passing SRTs found for stops ${stops.join(", ")}`, {
            module: "augmentedStopTime",
            function: "findPassingStopTimes",
        });
        return [];
    }
    let times = [{ ...idsToTimes[passingSRTs[0].from], _passing: false }];
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
            logger.error(`Start time should not be undefined`, {
                module: "augmentedStopTime",
                function: "findPassingStopTimes",
                startTime,
                srt,
            });
            continue;
        }
        if (!endTime) {
            logger.error(`End time should not be undefined`, {
                module: "augmentedStopTime",
                function: "findPassingStopTimes",
                endTime,
                to: srt.to,
                srt,
            });
            continue;
        }
        if (!startTime.departure_time)
            logger.error(`Start time should not be undefined`, {
                module: "augmentedStopTime",
                function: "findPassingStopTimes",
                startTime,
                srt,
            });
        if (!endTime.departure_time)
            logger.error(`End time should not be undefined`, {
                module: "augmentedStopTime",
                function: "findPassingStopTimes",
                endTime,
                srt,
            });
        if (!startTime.departure_time || !endTime.departure_time)
            continue;
        let timeDifference = Math.floor((endTime.departure_time - startTime.departure_time) / 60);
        let totalTimePass = passingRun.reduce((acc, curr) => acc + curr.emu, 0);
        let rescaledAccumulatedPassingRuns = passingRun
            .map((v) => ({
            ...v,
            emu: Math.floor((v.emu / totalTimePass) * timeDifference),
        }))
            .reduce((acc, curr) => {
            if (acc.length === 0) {
                acc.push(curr);
            }
            else {
                let last = acc[acc.length - 1];
                acc.push({
                    ...curr,
                    emu: last.emu + curr.emu,
                });
            }
            return acc;
        }, []);
        for (let i = 0; i < rescaledAccumulatedPassingRuns.length; i++) {
            let run = rescaledAccumulatedPassingRuns[i];
            if (run.emu <= 0)
                continue;
            times.push({
                _passing: true,
                stop_id: run.to,
                trip_id: stopTimes[0].trip_id,
                stop_sequence: stopTimes[0].stop_sequence + i / rescaledAccumulatedPassingRuns.length,
                departure_time: startTime.departure_time + run.emu * 60,
                arrival_time: (startTime.arrival_time ?? startTime.departure_time) + run.emu * 60,
                drop_off_type: qdf.DropOffType.None,
                pickup_type: qdf.PickupType.None,
                continuous_drop_off: qdf.ContinuousDropOff.None,
                continuous_pickup: qdf.ContinuousPickup.None,
                shape_dist_traveled: -1,
                stop_headsign: "",
                timepoint: -1
            });
        }
        times.push({ ...endTime, _passing: false });
        passingRun = [];
    }
    if (times.at(-1) && stopTimes.at(-1) && times.at(-1).stop_sequence != stopTimes.at(-1).stop_sequence)
        times.push({ ...stopTimes.at(-1), _passing: false });
    return times;
}
function intermediateAToAST(st) {
    let intA = [];
    let intA_AltS = [];
    let intA_AltA = [];
    let intA_AltB = [];
    let prevActualTrackCode = "";
    let prevScheduledTrackCode = "";
    for (let i = 0; i < st.length; i++) {
        if (st[i].passing) {
            intA.push({
                ...st[i],
                actual_exit_side: null,
                scheduled_exit_side: null,
            });
            let actualExitData = platformData[st[i].actual_parent_station?.stop_id ?? ""] ??
                platformData[st[i].actual_stop?.stop_id ?? ""];
            let scheduledExitData = platformData[st[i].scheduled_parent_station?.stop_id ?? ""] ??
                platformData[st[i].scheduled_stop?.stop_id ?? ""];
            let actualPlatform = actualExitData?.find((v) => v.trackCode == prevActualTrackCode) ?? null;
            let scheduledPlatform = scheduledExitData?.find((v) => v.trackCode == prevScheduledTrackCode) ?? null;
            if (!actualPlatform)
                prevActualTrackCode = "";
            if (!scheduledPlatform)
                prevScheduledTrackCode = "";
            intA_AltB.push({
                ...st[i],
                actual_exit_side: null,
                scheduled_exit_side: null,
                actual_platform_code: actualPlatform?.platform_code?.toString() ?? null,
                scheduled_platform_code: scheduledPlatform?.platform_code?.toString() ?? null,
            });
            intA_AltA.push({
                ...st[i],
                actual_exit_side: null,
                scheduled_exit_side: null,
                actual_platform_code: actualPlatform?.platform_code?.toString() ?? null,
            });
            intA_AltS.push({
                ...st[i],
                actual_exit_side: null,
                scheduled_exit_side: null,
                scheduled_platform_code: scheduledPlatform?.platform_code?.toString() ?? null,
            });
            continue;
        }
        let actualExitData = platformData[st[i].actual_parent_station?.stop_id ?? ""] ?? platformData[st[i].actual_stop?.stop_id ?? ""];
        let actualPlatform = actualExitData
            ? (actualExitData.find((v) => v.platform_code == Number.parseInt(st[i].actual_platform_code ?? "0")) ??
                null)
            : null;
        let scheduledExitData = platformData[st[i].scheduled_parent_station?.stop_id ?? ""] ??
            platformData[st[i].scheduled_stop?.stop_id ?? ""];
        let scheduledPlatform = scheduledExitData
            ? (scheduledExitData.find((v) => v.platform_code == Number.parseInt(st[i].scheduled_platform_code ?? "0")) ?? null)
            : null;
        const swap = {
            left: "right",
            right: "left",
            both: "both",
        };
        if (actualPlatform?.trackCode == prevActualTrackCode && scheduledPlatform?.trackCode == prevScheduledTrackCode)
            intA = intA_AltB;
        else if (actualPlatform?.trackCode == prevActualTrackCode)
            intA = intA_AltA;
        else if (scheduledPlatform?.trackCode == prevScheduledTrackCode)
            intA = intA_AltS;
        intA.push({
            ...st[i],
            actual_exit_side: (actualPlatform
                ? actualPlatform.next.includes(st[i + 1]?.actual_stop?.stop_id ?? "") ||
                    actualPlatform.next.includes(st[i + 1]?.actual_parent_station?.stop_id ?? "") ||
                    (i > 0 && actualPlatform.from.includes(st[i - 1]?.actual_stop?.stop_id ?? "")) ||
                    (i > 0 && actualPlatform.from.includes(st[i - 1]?.actual_parent_station?.stop_id ?? ""))
                    ? actualPlatform.exitSide
                    : swap[actualPlatform.exitSide]
                : null),
            scheduled_exit_side: (scheduledPlatform
                ? scheduledPlatform.next.includes(st[i + 1]?.scheduled_stop?.stop_id ?? "") ||
                    scheduledPlatform.next.includes(st[i + 1]?.scheduled_parent_station?.stop_id ?? "") ||
                    (i > 0 && scheduledPlatform.from.includes(st[i - 1]?.scheduled_stop?.stop_id ?? "")) ||
                    (i > 0 && scheduledPlatform.from.includes(st[i - 1]?.scheduled_parent_station?.stop_id ?? ""))
                    ? scheduledPlatform.exitSide
                    : swap[scheduledPlatform.exitSide]
                : null),
        });
        intA_AltB = intA.slice();
        intA_AltS = intA.slice();
        intA_AltA = intA.slice();
        prevActualTrackCode = actualPlatform?.trackCode ?? "";
        prevScheduledTrackCode = scheduledPlatform?.trackCode ?? "";
    }
    return intA.map((v) => ({
        ...v,
        toSerializable: () => toSerializableAugmentedStopTime(v),
    }));
}
export function augmentStopTimes(stopTimes, serviceDates) {
    if (!stopTimes.map((v) => v.trip_id == stopTimes[0].trip_id).every((v) => v))
        logger.error(`All stopTimes must belong to the same trip: ${stopTimes[0].trip_id}`, {
            module: "augmentedStopTime",
            function: "augmentStopTimes",
            tripId: stopTimes[0].trip_id,
            stopTimes,
        });
    let initialScheduledArrivalTime = 0;
    let initialScheduledDepartureTime = 0;
    let initialActualArrivalTime = 0;
    let initialActualDepartureTime = 0;
    const trip_id = stopTimes[0].trip_id;
    let tripUpdate = cache.getTripUpdates(trip_id)[0];
    let stopTimeUpdates = tripUpdate.stop_time_updates;
    let passingStopTimes = findPassingStopTimes(stopTimes);
    let augmentedStopTimes = [];
    // Propagation state
    let lastDelay = 0;
    let lastScheduleRelationship = qdf.StopTimeScheduleRelationship.NO_DATA;
    let propagateOnTime = tripUpdate && tripUpdate.trip.schedule_relationship === qdf.TripScheduleRelationship.SCHEDULED;
    for (let passingStopTime of passingStopTimes) {
        let stopId = passingStopTime.stop_id;
        // Get the actual stop information
        let actualStop = cache.getAugmentedStops(stopId)[0];
        let actualParentStation = actualStop?.parent_station
            ? cache.getAugmentedStops(actualStop.parent_station)[0]
            : null;
        let realtimeUpdate = stopTimeUpdates.find((update) => update.stop_id == stopId ||
            actualParentStation?.stop_id == update.stop_id ||
            cache.getAugmentedStops(stopId)[0].children.some((child) => child.stop_id == update.stop_id));
        // Get scheduled stop information
        let scheduledStop = cache.getAugmentedStops(stopId)[0];
        let scheduledParentStation = scheduledStop?.parent_station
            ? cache.getAugmentedStops(scheduledStop.parent_station)[0]
            : null;
        // Calculate times
        let scheduledArrivalTime = passingStopTime.arrival_time;
        let scheduledDepartureTime = passingStopTime.departure_time;
        let actualArrivalTime = scheduledArrivalTime;
        let actualDepartureTime = scheduledDepartureTime;
        // Propagation logic
        let rtArrivalUpdated = false;
        let rtDepartureUpdated = false;
        let rtStopUpdated = false;
        let rtParentStationUpdated = false;
        let rtPlatformCodeUpdated = false;
        let propagated = false;
        let delaySecs = lastDelay;
        let platformCode = null;
        let scheduleRelationship = lastScheduleRelationship;
        if (realtimeUpdate) {
            if (realtimeUpdate.departure_delay !== undefined) {
                actualDepartureTime =
                    scheduledDepartureTime !== undefined
                        ? scheduledDepartureTime + realtimeUpdate.departure_delay
                        : undefined;
                rtDepartureUpdated = true;
                delaySecs = realtimeUpdate.departure_delay;
                lastDelay = delaySecs;
                propagated = false;
            }
            else if (lastDelay) {
                actualDepartureTime =
                    scheduledDepartureTime !== undefined ? scheduledDepartureTime + lastDelay : undefined;
                propagated = true;
            }
            if (realtimeUpdate.arrival_delay !== undefined) {
                actualArrivalTime =
                    scheduledArrivalTime !== undefined
                        ? scheduledArrivalTime + realtimeUpdate.arrival_delay
                        : undefined;
                rtArrivalUpdated = true;
                delaySecs = realtimeUpdate.arrival_delay;
                lastDelay = delaySecs;
                propagated = false;
            }
            else if (lastDelay) {
                actualArrivalTime =
                    scheduledArrivalTime !== undefined ? scheduledArrivalTime + lastDelay : undefined;
                propagated = true;
            }
            if (cache.getRawStops(realtimeUpdate.stop_id)[0]?.platform_code) {
                platformCode = cache.getRawStops(realtimeUpdate.stop_id)[0]?.platform_code ?? null;
                rtPlatformCodeUpdated = true;
            }
            if (realtimeUpdate.schedule_relationship) {
                scheduleRelationship = realtimeUpdate.schedule_relationship;
                lastScheduleRelationship = realtimeUpdate.schedule_relationship;
            }
            if (realtimeUpdate.stop_id && realtimeUpdate.stop_id !== stopId) {
                actualStop = cache.getAugmentedStops(realtimeUpdate.stop_id)[0];
                actualParentStation = actualStop?.parent_station
                    ? cache.getAugmentedStops(actualStop.parent_station)[0]
                    : null;
                rtStopUpdated = true;
                rtParentStationUpdated = true;
            }
        }
        else if (lastDelay) {
            // Propagate previous delay if no explicit update
            actualArrivalTime =
                scheduledArrivalTime !== undefined ? scheduledArrivalTime + lastDelay : undefined;
            actualDepartureTime =
                scheduledDepartureTime !== undefined ? scheduledDepartureTime + lastDelay : undefined;
            propagated = true;
        }
        else if (propagateOnTime) {
            // No realtime updates, but tripUpdate is SCHEDULED: propagate on time
            delaySecs = 0;
            propagated = true;
            scheduleRelationship = qdf.StopTimeScheduleRelationship.SCHEDULED;
        }
        // Calculate realtime info
        let realtimeInfo = null;
        let hasRealtime = !!realtimeUpdate || propagated || !!tripUpdate;
        if (hasRealtime) {
            let delayString;
            let delayClass;
            if (delaySecs === 0) {
                delayString = "on time";
                delayClass = "on-time";
            }
            else if (Math.abs(delaySecs) <= 60) {
                delayString = "on time";
                delayClass = "on-time";
            }
            else if (delaySecs > 0 && delaySecs <= 300) {
                delayString = `${Math.round(delaySecs / 60)}m late`;
                delayClass = "late";
            }
            else if (delaySecs > 300) {
                delayString = `${Math.round(delaySecs / 60)}m late`;
                delayClass = "very-late";
            }
            else {
                delayString = `${Math.round(Math.abs(delaySecs) / 60)}m early`;
                delayClass = "early";
            }
            propagated = propagated && !passingStopTime._passing;
            realtimeInfo = {
                delay_secs: delaySecs,
                delay_string: delayString,
                delay_class: delayClass,
                schedule_relationship: scheduleRelationship,
                propagated,
            };
        }
        if (passingStopTime.stop_sequence == 1) {
            initialScheduledArrivalTime = scheduledArrivalTime ?? 0;
            initialScheduledDepartureTime = scheduledDepartureTime ?? 0;
            initialActualArrivalTime = actualArrivalTime ?? 0;
            initialActualDepartureTime = actualDepartureTime ?? 0;
        }
        let initial_scheduled_arrival_date_offset = initialScheduledArrivalTime
            ? Math.floor(initialScheduledArrivalTime / 86400)
            : 0;
        let initial_scheduled_departure_date_offset = initialScheduledDepartureTime
            ? Math.floor(initialScheduledDepartureTime / 86400)
            : 0;
        let initial_actual_arrival_date_offset = initialActualArrivalTime
            ? Math.floor(initialActualArrivalTime / 86400)
            : 0;
        let initial_actual_departure_date_offset = initialActualDepartureTime
            ? Math.floor(initialActualDepartureTime / 86400)
            : 0;
        // Calculate arrival/departure date offsets
        let scheduled_arrival_date_offset = scheduledArrivalTime
            ? Math.floor(scheduledArrivalTime / 86400)
            : 0;
        let actual_arrival_date_offset = actualArrivalTime ? Math.floor(actualArrivalTime / 86400) : 0;
        let scheduled_departure_date_offset = scheduledDepartureTime
            ? Math.floor(scheduledDepartureTime / 86400)
            : 0;
        let actual_departure_date_offset = actualDepartureTime ? Math.floor(actualDepartureTime / 86400) : 0;
        let scheduled_arrival_dates = serviceDates.map((d) => d + scheduled_arrival_date_offset);
        let scheduled_departure_dates = serviceDates.map((d) => d + scheduled_departure_date_offset);
        let actual_arrival_dates = serviceDates.map((d) => d == today() ? d + actual_arrival_date_offset : d + scheduled_arrival_date_offset);
        let actual_departure_dates = serviceDates.map((d) => d == today() ? d + actual_departure_date_offset : d + scheduled_departure_date_offset);
        scheduled_arrival_date_offset -= initial_scheduled_arrival_date_offset;
        actual_arrival_date_offset -= initial_actual_arrival_date_offset;
        scheduled_departure_date_offset -= initial_scheduled_departure_date_offset;
        actual_departure_date_offset -= initial_actual_departure_date_offset;
        let partialAugmentedStopTime = {
            _stopTime: passingStopTime._passing ? null : passingStopTime,
            trip_id: stopTimes[0].trip_id,
            passing: passingStopTime._passing,
            actual_arrival_time: actualArrivalTime ? actualArrivalTime % 86400 : null,
            actual_departure_time: actualDepartureTime ? actualDepartureTime % 86400 : null,
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
            scheduled_arrival_time: scheduledArrivalTime ? scheduledArrivalTime % 86400 : null,
            scheduled_departure_time: scheduledDepartureTime ? scheduledDepartureTime % 86400 : null,
            scheduled_stop: scheduledStop,
            scheduled_parent_station: scheduledParentStation,
            scheduled_platform_code: passingStopTime._passing ? null : (scheduledStop.platform_code ?? null),
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
        augmentedStopTimes.push(partialAugmentedStopTime);
    }
    return intermediateAToAST(augmentedStopTimes);
}
