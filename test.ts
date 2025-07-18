import TRAX from "./index.js";
import {AugmentedTrip} from "./utils/augmentedTrip.js";

function displayTrip(trip: AugmentedTrip): void {
    console.log(`Trip ID: ${trip._trip.trip_id}`);
    console.log(`Service Dates: ${trip.serviceDates.join(", ")}`);
    console.log("Stop Times:");
    for (const st of trip.stopTimes) {
        const name =
            st.actual_stop?.stop_name ||
            st.scheduled_stop?.stop_name ||
            st.actual_stop?.stop_id || st.scheduled_stop?.stop_id;
        const actDep = TRAX.formatTimestamp(st.actual_departure_timestamp);
        console.log(
            `  ${name}: ${actDep} ${st.passing ? "(Passing)" : ""} ${
                st.realtime_info
                    ? st.realtime_info.propagated
                        ? st.realtime_info.delay_string + " PROP"
                        : st.realtime_info.delay_string
                    : ""
            }`
        );
    }
    console.log("");
}

async function main() {
    await TRAX.loadGTFS();
//   const trips = TRAX.getAugmentedTrips("33552736-QR 25_26-39955-T401");
//   if (trips.length === 0) {
//     console.log("No trips found.");
//     return;
//   }
//   for (const trip of trips) {
//     displayTrip(trip);
//   }
    console.time("getDepartures");
    const departures = TRAX.getAugmentedStops("place_aucsta")[0].getDepartures(20250718, "15:58:00", "16:58:00");
    console.timeEnd("getDepartures");

    console.log("Departures:");
    for (const dep of departures) {
        console.log(`${dep.passing? "(Passing)" : ""}  ${dep.trip_id}: ${TRAX.formatTimestamp(dep.actual_departure_timestamp)} ${dep.express_string}`);
    }
}

main();
