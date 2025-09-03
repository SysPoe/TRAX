import TRAX from ".";
import * as gtfs from "gtfs";
import fs from "fs";

async function main() {
  // await TRAX.loadGTFS(false, false);
  await gtfs.updateGtfsRealtime(TRAX.config);
  console.log(gtfs.getStoptimes({ trip_id: "34072711-QR 25_26-40374-D109" }).sort((a, b) => a.stop_sequence - b.stop_sequence));
}
main();
