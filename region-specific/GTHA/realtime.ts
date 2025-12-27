import { CacheContext, getAugmentedTripInstance, getAugmentedTrips, getTripUpdates } from "../../cache.js";
import { GTFS, StopTime } from "qdf-gtfs";
import { GTHADeparturesResponse, UPEDeparturesResponse } from "./types.js";
import logger from "../../utils/logger.js";
import { getServiceDayStart } from "../../utils/time.js";
import { isConsideredTripId } from "../../utils/considered.js";

let prevs: {
    tripInstanceId: string;
    stopId: string;
    actualPlatform: string | null;
    scheduledPlatform: string | null;
}[] = [];

export async function updateGTHAPlatforms(ctx: CacheContext, gtfs: GTFS) {
    const now = new Date();
    const serviceDayStart = getServiceDayStart(now.toISOString().slice(0, 10).replace(/-/g, ""), ctx.config.timezone);
    const nowSecs = Math.floor(now.getTime() / 1000 - serviceDayStart + 86400) % 86400;

    const UP_ids = ["UN", "PA", "BL", "MD", "WE"];

    // Query stop times for the next 10 minutes
    const stopTimes = gtfs
        .getStopTimes({ start_time: nowSecs, end_time: nowSecs + 600 })
        .concat(
            UP_ids.reduce(
                (a, stop_id) => a.concat(gtfs.getStopTimes({ stop_id, start_time: nowSecs, end_time: nowSecs + 7200 })),
                [] as StopTime[],
            ),
        )
        .filter((v) => isConsideredTripId(v.trip_id, gtfs))
        .map((v) => ({ stop_id: v.stop_id, trip_id: v.trip_id }))
        .concat(
            getTripUpdates(ctx).flatMap(
                (update) =>
                    update.stop_time_updates
                        ?.filter(
                            (stu) =>
                                (stu.departure_time ?? stu.arrival_time) &&
                                ((stu.departure_time ?? stu.arrival_time ?? 0) - nowSecs + 86400) % 86400 <= 600,
                        )
                        .map((stu) => ({ stop_id: stu.stop_id, trip_id: update.trip.trip_id })) ?? [],
            ),
        )
        .filter((v) => v);

    const stopIds = new Set(stopTimes.map((v) => v.stop_id));

    logger.debug(`Updating GTHA platforms for ${stopIds.size} stops`, {
        module: "region-specific/GTHA/realtime",
        function: "updateGTHAPlatforms",
    });

    prevs.forEach((v) => {
        let ti = getAugmentedTripInstance(ctx, v.tripInstanceId);
        if (!ti) return;
        let st = ti.stopTimes.find((st) => (st.actual_stop_id ?? st.scheduled_stop_id) === v.stopId);
        if (!st) return;

        st.actual_platform_code = v.actualPlatform;
        st.scheduled_platform_code = v.scheduledPlatform;
    });

    await Promise.all(
        Array.from(stopIds).map(async (stop_id) => {
            try {
                const url = `https://api.metrolinx.com/external/go/departures/stops/${stop_id}/departures?page=1&pageLimit=10`;
                const response = await fetch(url);
                if (!response.ok) return;

                const data: GTHADeparturesResponse = await response.json();

                for (const departure of data.trainDepartures.items) {
                    const tripNumber = departure.tripNumber;
                    let platform = departure.platform.replaceAll("-", "").trim() === "" ? null : departure.platform;
                    let scheduledPlatform =
                        departure.scheduledPlatform?.replaceAll("-", "")?.trim() === ""
                            ? null
                            : departure.scheduledPlatform;

                    if (!platform && scheduledPlatform) platform = scheduledPlatform;
                    if (!scheduledPlatform && platform) scheduledPlatform = platform;

                    for (const st of stopTimes) {
                        if (!st.trip_id.endsWith(tripNumber)) continue;
                        const augmentedStopTimes = getAugmentedTrips(ctx, st.trip_id)[0]?.instances.find((v) => {
                            if (v.serviceDate === departure.scheduledDateTime.slice(0, 10).replace(/-/g, ""))
                                return true;
                            let offset = v.stopTimes.find(
                                (st) => st.actual_stop_id === stop_id,
                            )?.scheduled_departure_date_offset;

                            if (!offset) return false;

                            let prevDate = new Date(
                                Date.UTC(
                                    Number.parseInt(departure.scheduledDateTime.slice(0, 4)),
                                    Number.parseInt(departure.scheduledDateTime.slice(5, 7)) - 1,
                                    Number.parseInt(departure.scheduledDateTime.slice(8, 10)),
                                ),
                            );
                            prevDate.setDate(prevDate.getDate() - offset);

                            if (prevDate.toUTCString().slice(0, 10).replaceAll(/-/g, "") === v.serviceDate) return true;
                            return false;
                        })?.stopTimes;

                        if (augmentedStopTimes) {
                            const ast = augmentedStopTimes.find((ast) => ast.actual_stop_id === st.stop_id);

                            if (ast?.actual_stop_id === stop_id) {
                                prevs = prevs.filter(
                                    (v) => !(v.tripInstanceId === ast?.instance_id && v.stopId === ast?.actual_stop_id),
                                );

                                prevs.push({
                                    tripInstanceId: ast.instance_id,
                                    stopId: ast.actual_stop_id,
                                    actualPlatform: platform,
                                    scheduledPlatform: scheduledPlatform,
                                });

                                ast.actual_platform_code = platform;
                                ast.scheduled_platform_code = scheduledPlatform;
                                ast.rt_platform_code_updated = true;
                            }
                        }
                    }
                }

                if (!UP_ids.includes(stop_id)) return;

                const upeUrl = `https://api.metrolinx.com/external/upe/tdp/up/departures/${stop_id}`;
                const upeResponse = await fetch(upeUrl);
                if (upeResponse.ok) {
                    const upeData: UPEDeparturesResponse = await upeResponse.json();
                    const dateStr = upeData.metadata.timeStamp.slice(0, 10).replace(/-/g, "");

                    for (const departure of upeData.departures) {
                        const tripNumber = departure.tripNumber;
                        let platform = departure.platform.replaceAll("-", "").trim() === "" ? null : departure.platform;

                        for (const st of stopTimes) {
                            if (!st.trip_id.endsWith(tripNumber)) continue;
                            const augmentedStopTimes = getAugmentedTrips(ctx, st.trip_id)[0]?.instances.find(
                                (v) => v.serviceDate === dateStr,
                            )?.stopTimes;

                            if (augmentedStopTimes) {
                                const ast = augmentedStopTimes.find((ast) => ast.actual_stop_id === st.stop_id);

                                if (ast?.actual_stop_id === stop_id) {
                                    prevs = prevs.filter(
                                        (v) =>
                                            !(
                                                v.tripInstanceId === ast?.instance_id &&
                                                v.stopId === ast?.actual_stop_id
                                            ),
                                    );

                                    prevs.push({
                                        tripInstanceId: ast.instance_id,
                                        stopId: ast.actual_stop_id,
                                        actualPlatform: platform,
                                        scheduledPlatform: null,
                                    });

                                    ast.actual_platform_code = platform;
                                    ast.rt_platform_code_updated = true;
                                }
                            }
                        }
                    }
                }
            } catch (e) {
                logger.error(`Failed to update GTHA platforms for stop ${stop_id}`, {
                    error: e,
                    module: "region-specific/GTHA/realtime",
                    function: "updateGTHAPlatforms",
                });

                console.error(e);
            }
        }),
    );
    logger.debug(`Completed updating GTHA platforms`, {
        module: "region-specific/GTHA/realtime",
        function: "updateGTHAPlatforms",
    });
}
