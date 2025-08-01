import TRAX from ".";
import type { SRTStop } from "./utils/SectionalRunningTimes/metroSRTTravelTrain.js";

async function main() {
  const trains = await TRAX.qrTravel.getCurrentQRTravelTrains();
  if (!trains || trains.length === 0) {
    console.log("No QR Travel trains found.");
    return;
  }
  const first = trains.find((v) => v.serviceId === "976T");
  if (!first) {
    console.log("No train with serviceId '976T' found.");
    return;
  }

  for (const stop of first.stopsWithPassing ?? []) {
    if (!stop.isStop) {
      // Passing stop: show estimated passing time if available
      const passTime =
        stop.estimatedPassingTime ||
        stop.actualDeparture ||
        stop.plannedDeparture ||
        "--";
      console.log(
        `PASS: ${stop.placeName}  time: ${passTime} arrDelay: ${
          stop.arrivalDelaySeconds ?? "--"
        } depDelay: ${stop.departureDelaySeconds ?? "--"}`
      );
    } else {
      // Stopping stop: show actual/planned times (do not use estimatedPassingTime)
      const arr = stop.actualArrival || stop.plannedArrival || "--";
      const dep = stop.actualDeparture || stop.plannedDeparture || "--";
      console.log(
        `STOP: ${stop.placeName}  arr: ${arr} dep: ${dep} arrDelay: ${
          stop.arrivalDelaySeconds ?? "--"
        } depDelay: ${stop.departureDelaySeconds ?? "--"}`
      );
    }
  }

  console.log(" ------ ");

  for (const stop of first.stops) {
    // Stopping stop: show actual/planned times (do not use estimatedPassingTime)
    const arr = stop.actualArrival || stop.plannedArrival || "--";
    const dep = stop.actualDeparture || stop.plannedDeparture || "--";
    console.log(
      `STOP: ${stop.placeName}  arr: ${arr} dep: ${dep} arrDelay: ${
        stop.arrivalDelaySeconds ?? "--"
      } depDelay: ${stop.departureDelaySeconds ?? "--"}`
    );
  }
}
main();
