import TRAX from "./index.js";
import { AugmentedTrip } from "./utils/augmentedTrip.js";

function formatTimestamp(ts?: number | null): string {
  if (!ts) return "--:--";
  const d = new Date(ts * 1000);
  return d.toISOString().slice(11, 16);
}

function displayTrip(trip: AugmentedTrip): void {
  console.log(`Trip ID: ${trip._trip.trip_id}`);
  console.log(`Service Dates: ${trip.serviceDates.join(", ")}`);
  console.log("Stop Times:");
  for (const st of trip.stopTimes) {
    const name =
      st.actual_stop?.stop_name ||
      st.scheduled_stop?.stop_name ||
      st.actual_stop?.stop_id || st.scheduled_stop?.stop_id;
    const actDep = formatTimestamp(st.actual_departure_timestamp);
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
  const trips = TRAX.getAugmentedTrips("33551755-QR 25_26-39954-DK88");
  if (trips.length === 0) {
    console.log("No trips found.");
    return;
  }
  for (const trip of trips) {
    displayTrip(trip);
  }
}

main();
