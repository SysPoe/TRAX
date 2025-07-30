import TRAX from ".";
import type { SRTStop } from "./utils/SectionalRunningTimes/metroSRTTravelTrain.js";

async function main() {
  await TRAX.loadGTFS();
  // Get the first QR Travel train
  const trains = TRAX.getQRTTrains();
  if (!trains || trains.length === 0) {
    console.log("No QR Travel trains found.");
    return;
  }
  const first = trains[0];
  // Use the canonical SRT expansion from metroSRTTravelTrain
  const expanded: SRTStop[] = first.stopsWithPassing ?? [];
  for (const stop of expanded) {
    const s: SRTStop = stop;
    if (!stop.isStop) {
      // Passing stop: show estimated passing time if available
      const passTime = stop.actualDeparture || stop.plannedDeparture || "--";
      console.log(
        `PASS: ${stop.placeName}  time: ${passTime} arrDelay: ${stop.arrivalDelaySeconds ?? '--'} depDelay: ${stop.departureDelaySeconds ?? '--'}`
      );
    } else {
      // Stopping stop: show actual/planned times (do not use estimatedPassingTime)
      const arr = stop.actualArrival || stop.plannedArrival || "--";
      const dep = stop.actualDeparture || stop.plannedDeparture || "--";
      console.log(
        `STOP: ${stop.placeName}  arr: ${arr} dep: ${dep} arrDelay: ${stop.arrivalDelaySeconds ?? '--'} depDelay: ${stop.departureDelaySeconds ?? '--'}`
      );
    }
  }
}
main();
