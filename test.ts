import TRAX from ".";
import * as gtfs from "gtfs";
import fs from "fs";

async function main() {
  await TRAX.loadGTFS(false, false);
  console.log(TRAX.getAugmentedTrips("33995889-QR 25_26-40277-TY93"));
  console.log(gtfs.getTripUpdates({trip_id: "33995889-QR 25_26-40277-TY93"}));
  // fs.writeFileSync("tripUpdates.json", JSON.stringify(gtfs.getTripUpdates().filter(v =>v.trip_id?.includes("QR")), null, 4));
  // fs.writeFileSync("stopTimeUpdates.json", JSON.stringify(gtfs.getStopTimeUpdates().filter(v =>v.trip_id?.includes("QR")), null, 4));
}
main();
