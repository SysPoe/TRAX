import { getServiceDatesByTrip } from "./calendar.js";
import { augmentStopTimes, toSerializableAugmentedStopTime, } from "./augmentedStopTime.js";
import { findExpress } from "./express.js";
import * as cache from "../cache.js";
export function toSerializableAugmentedTrip(trip) {
    return {
        _trip: trip._trip,
        serviceDates: trip.serviceDates,
        tracks: trip.tracks,
        stopTimes: Array.isArray(trip.stopTimes)
            ? trip.stopTimes.map((st) => toSerializableAugmentedStopTime(st))
            : [],
        expressInfo: trip.expressInfo,
        run: trip.run,
    };
}
export function augmentTrip(trip) {
    const serviceDates = getServiceDatesByTrip(trip.trip_id);
    let rawStopTimes = cache
        .getRawStopTimes(trip.trip_id)
        .sort((a, b) => a.stop_sequence - b.stop_sequence);
    let parentStops = rawStopTimes.map((st) => cache.getRawStops(st.stop_id)[0]?.parent_station ?? "");
    let expressInfo = findExpress(parentStops.filter((id) => !!id));
    let tracks = {};
    for (const serviceDate of serviceDates) {
        tracks[serviceDate] = "Not implemented";
    }
    // Pre-calculate stop times during trip creation instead of on-demand
    let cachedStopTimes = null;
    return {
        _trip: trip,
        serviceDates,
        get stopTimes() {
            // Use cached version if available
            let stopTimes = cache.getAugmentedStopTimes(trip.trip_id);
            if (stopTimes.length > 0)
                return stopTimes;
            // Calculate once and cache
            if (!cachedStopTimes) {
                cachedStopTimes = augmentStopTimes(rawStopTimes);
            }
            return cachedStopTimes;
        },
        expressInfo,
        tracks,
        run: trip.trip_id.slice(-4),
        toSerializable: () => {
            // Use cached version if available
            let stopTimes = cache.getAugmentedStopTimes(trip.trip_id);
            if (stopTimes.length === 0) {
                if (!cachedStopTimes) {
                    cachedStopTimes = augmentStopTimes(rawStopTimes);
                }
                stopTimes = cachedStopTimes;
            }
            return toSerializableAugmentedTrip({
                _trip: trip,
                serviceDates,
                stopTimes,
                expressInfo,
                tracks,
                run: trip.trip_id.slice(-4),
            });
        },
    };
}
