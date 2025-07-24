import { getServiceDatesByTrip } from "./calendar.js";
import { augmentStopTimes } from "./augmentedStopTime.js";
import { findExpress } from "./express.js";
import * as cache from "../cache.js";
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
    return {
        _trip: trip,
        serviceDates,
        get stopTimes() {
            return augmentStopTimes(rawStopTimes);
        },
        expressInfo,
        tracks,
        run: trip.trip_id.slice(-4),
    };
}
