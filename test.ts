import TRAX from "./index.js";
import {AugmentedTrip} from "./utils/augmentedTrip.js";
import chalk from "chalk";

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
    await TRAX.loadGTFS(false, false);
//   const trips = TRAX.getAugmentedTrips("33552736-QR 25_26-39955-T401");
//   if (trips.length === 0) {
//     console.log("No trips found.");
//     return;
//   }
//   for (const trip of trips) {
//     displayTrip(trip);
//   }
    const stop = TRAX.getAugmentedStops("place_virsta")[0];

    const now = `${new Date().getHours().toString().padStart(2, "0")}:${new Date().getMinutes().toString().padStart(2, "0")}:00`;
    const later = `${(new Date().getHours() + 4).toString().padStart(2, "0")}:${new Date().getMinutes().toString().padStart(2, "0")}:00`;
    const departures = stop.getDepartures(20250719, now, later);

    console.log(chalk.bold("Departures for: " + stop.stop_name + " from " + now + " to " + later));
    for (const dep of departures) {
        const time = TRAX.formatTimestamp(dep.actual_departure_timestamp);
        const tripId = chalk.yellow(dep.trip_id.slice(-4));
        const passing = dep.passing ? chalk.magenta(" (passing)") : "";
        const rtString = dep.realtime_info ?
            dep.realtime_info.delay_class == "on-time" ? chalk.green(` (${dep.realtime_info.delay_string})`)
                : dep.realtime_info.delay_class == "scheduled" ? chalk.gray(` (${dep.realtime_info.delay_string})`)
                    : dep.realtime_info.delay_class == "late" ? chalk.red(` (${dep.realtime_info.delay_string})`)
                        : dep.realtime_info.delay_class == "early" ? chalk.redBright(` (${dep.realtime_info.delay_string})`)
                            : chalk.cyan(` (${dep.realtime_info.delay_string})`) : chalk.gray(" (scheduled)");
        console.log(`${chalk.cyan(time)} ${dep.actual_platform_code ? "p" + dep.actual_platform_code.padEnd(2, " ") : dep.scheduled_platform_code ? "p" + dep.scheduled_platform_code.padEnd(2, " ") : "   "} ${dep.realtime ? "RT" : "  "} ${tripId} ${TRAX.getAugmentedTrips(dep.trip_id)[0]._trip.trip_headsign}${rtString}${passing}`);
    }
}

main();
