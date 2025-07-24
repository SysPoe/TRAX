import * as cache from "../cache.js";
import { getAugmentedTrips } from "../cache.js";
import { findExpressString } from "./express.js";
export function augmentStop(stop) {
    const getChildren = () => {
        const childStops = cache
            .getRawStops()
            .filter((s) => s.parent_station === stop.stop_id);
        return childStops.map((s) => augmentStop(s));
    };
    const getParent = () => {
        if (!stop.parent_station)
            return null;
        return cache.getAugmentedStops(stop.parent_station)[0];
    };
    return {
        ...stop,
        get parent() {
            return getParent();
        },
        get children() {
            return getChildren();
        },
        getDepartures: (date, start_time, end_time) => {
            const startSec = timeSeconds(start_time);
            const endSec = timeSeconds(end_time);
            const parentId = getParent()?.stop_id;
            const childIds = getChildren().map((c) => c.stop_id);
            const validStops = new Set([stop.stop_id, parentId, ...childIds].filter(Boolean));
            const tripCache = new Map();
            const results = [];
            for (const st of cache.getAugmentedStopTimes()) {
                if (!st.actual_stop || !validStops.has(st.actual_stop.stop_id))
                    continue;
                let trip = tripCache.get(st.trip_id);
                if (!trip) {
                    trip = getAugmentedTrips(st.trip_id)[0];
                    tripCache.set(st.trip_id, trip);
                }
                if (!trip?.serviceDates?.includes(date))
                    continue;
                const ts = st.actual_departure_timestamp;
                if (ts == null || ts < startSec || ts > endSec)
                    continue;
                results.push({ st, trip });
            }
            return results
                .sort((a, b) => (a.st.actual_departure_timestamp ?? 0) - (b.st.actual_departure_timestamp ?? 0))
                .map(({ st, trip }) => {
                const expressString = findExpressString(trip.expressInfo, st.actual_parent_station?.stop_id ||
                    st.actual_stop?.parent_station ||
                    st.actual_stop?.stop_id ||
                    "");
                return {
                    ...st,
                    express_string: expressString,
                };
            });
        },
    };
}
function timeSeconds(time) {
    const [hours, minutes, seconds] = time.split(":").map(Number);
    return hours * 3600 + minutes * 60 + seconds;
}
