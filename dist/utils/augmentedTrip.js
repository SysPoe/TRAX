import { getServiceDatesByTrip } from "./calendar.js";
import { augmentStopTimes, } from "./augmentedStopTime.js";
import { findExpress } from "./express.js";
import * as cache from "../cache.js";
export function toSerializableAugmentedTrip(trip) {
    return {
        _trip: trip._trip,
        scheduledStartServiceDates: trip.scheduledStartServiceDates,
        scheduledTripDates: trip.scheduledTripDates,
        actualTripDates: trip.actualTripDates,
        runSeries: trip.runSeries,
        stopTimes: Array.isArray(trip.stopTimes)
            ? trip.stopTimes.map((st) => st.toSerializable())
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
        tracks[serviceDate] = null;
    }
    // Pre-calculate stop times during trip creation instead of on-demand
    let cachedStopTimes = null;
    return {
        _trip: trip,
        scheduledStartServiceDates: serviceDates,
        get scheduledTripDates() {
            // Use cached version if available
            let stopTimes = cache.getAugmentedStopTimes(trip.trip_id);
            let stopTimesToUse;
            if (stopTimes.length > 0) {
                stopTimesToUse = stopTimes;
            }
            else {
                // Calculate once and cache
                if (!cachedStopTimes) {
                    cachedStopTimes = augmentStopTimes(rawStopTimes, serviceDates);
                }
                stopTimesToUse = cachedStopTimes;
            }
            let dates = [
                ...new Set(stopTimesToUse
                    .map((st) => [
                    ...(st.scheduled_arrival_dates || []),
                    ...(st.scheduled_departure_dates || []),
                ])
                    .flat()),
            ];
            return dates.sort((a, b) => a - b);
        },
        get actualTripDates() {
            let stopTimes = cache.getAugmentedStopTimes(trip.trip_id);
            let stopTimesToUse;
            if (stopTimes.length > 0) {
                stopTimesToUse = stopTimes;
            }
            else {
                // Calculate once and cache
                if (!cachedStopTimes) {
                    cachedStopTimes = augmentStopTimes(rawStopTimes, serviceDates);
                }
                stopTimesToUse = cachedStopTimes;
            }
            let dates = [
                ...new Set(stopTimesToUse
                    .map((st) => [
                    ...(st.actual_arrival_dates || []),
                    ...(st.actual_departure_dates || []),
                ])
                    .flat()),
            ];
            return dates.sort((a, b) => a - b);
        },
        get stopTimes() {
            // Use cached version if available
            let stopTimes = cache.getAugmentedStopTimes(trip.trip_id);
            if (stopTimes.length > 0)
                return stopTimes;
            // Calculate once and cache
            if (!cachedStopTimes) {
                cachedStopTimes = augmentStopTimes(rawStopTimes, serviceDates);
            }
            return cachedStopTimes;
        },
        expressInfo,
        runSeries: tracks,
        run: trip.trip_id.slice(-4),
        toSerializable: function () {
            // Use cached version if available
            let stopTimes = cache.getAugmentedStopTimes(trip.trip_id);
            if (stopTimes.length === 0) {
                if (!cachedStopTimes) {
                    cachedStopTimes = augmentStopTimes(rawStopTimes, serviceDates);
                }
                stopTimes = cachedStopTimes;
            }
            return toSerializableAugmentedTrip({
                _trip: trip,
                scheduledStartServiceDates: serviceDates,
                scheduledTripDates: this.scheduledTripDates,
                actualTripDates: this.actualTripDates,
                stopTimes,
                expressInfo,
                runSeries: tracks,
                run: trip.trip_id.slice(-4),
            });
        },
    };
}
