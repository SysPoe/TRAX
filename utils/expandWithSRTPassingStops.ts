// Hard-coded SRT data from metro-srt-travel-train.csv
const SRT: Array<{ from: string; to: string; minutes: number }> = [
  { from: "Roma Street", to: "Normanby", minutes: 2 },
  { from: "Brisbane - Roma Street", to: "Normanby", minutes: 2 },
  { from: "Normanby", to: "Exhibition", minutes: 1 },
  { from: "Exhibition", to: "Campbell Street", minutes: 1 },
  { from: "Campbell Street", to: "Mayne Junction", minutes: 1 },
  { from: "Mayne Junction", to: "Mayne", minutes: 1 },
  { from: "Bowen Hills", to: "Campbell Street", minutes: 1 },
  { from: "Roma Street", to: "Central", minutes: 2 },
  { from: "Brisbane - Roma Street", to: "Central", minutes: 2 },
  { from: "Central", to: "Brunswick Street", minutes: 2 },
  { from: "Brunswick Street", to: "Bowen Hills", minutes: 2 },
  { from: "Bowen Hills", to: "Mayne", minutes: 1 },
  { from: "Mayne", to: "Albion", minutes: 2 },
  { from: "Albion", to: "Wooloowin", minutes: 1 },
  { from: "Wooloowin", to: "Eagle Junction", minutes: 1 },
  { from: "Eagle Junction", to: "Airport Junction", minutes: 1 },
  { from: "Airport Junction", to: "Toombul", minutes: 1 },
  { from: "Toombul", to: "Nundah", minutes: 1 },
  { from: "Nundah", to: "Northgate", minutes: 1 },
  { from: "Northgate", to: "Virginia", minutes: 2 },
  { from: "Virginia", to: "Sunshine", minutes: 1 },
  { from: "Sunshine", to: "Geebung", minutes: 1 },
  { from: "Geebung", to: "Zillmere", minutes: 2 },
  { from: "Zillmere", to: "Carseldine", minutes: 2 },
  { from: "Carseldine", to: "Bald Hills", minutes: 3 },
  { from: "Bald Hills", to: "Strathpine", minutes: 2 },
  { from: "Strathpine", to: "Bray Park", minutes: 1 },
  { from: "Bray Park", to: "Lawnton", minutes: 2 },
  { from: "Lawnton", to: "Petrie", minutes: 2 },
  { from: "Petrie", to: "Dakabin", minutes: 4 },
  { from: "Dakabin", to: "Narangba", minutes: 4 },
  { from: "Narangba", to: "Burpengary", minutes: 4 },
  { from: "Burpengary", to: "Morayfield", minutes: 5 },
  { from: "Morayfield", to: "Caboolture", minutes: 4 },
  { from: "Caboolture", to: "Elimbah", minutes: 7 },
  { from: "Elimbah", to: "Beerburrum", minutes: 5 },
  { from: "Beerburrum", to: "Glasshouse Mountains", minutes: 8 },
  { from: "Glasshouse Mountains", to: "Beerwah", minutes: 5 },
  { from: "Beerwah", to: "Landsborough", minutes: 5 },
  { from: "Landsborough", to: "Mooloolah", minutes: 6 },
  { from: "Mooloolah", to: "Eudlo", minutes: 7 },
  { from: "Eudlo", to: "Palmwoods", minutes: 4 },
  { from: "Palmwoods", to: "Woombye", minutes: 4 },
  { from: "Woombye", to: "Nambour", minutes: 2 },
  { from: "Nambour", to: "Yandina", minutes: 9 },
  { from: "Yandina", to: "North Arm", minutes: 6 },
  { from: "North Arm", to: "Eumundi", minutes: 4 },
  { from: "Eumundi", to: "Sunrise", minutes: 2 },
  { from: "Sunrise", to: "Cooroy", minutes: 6 },
  { from: "Cooroy", to: "Pomona", minutes: 9 },
  { from: "Pomona", to: "Cooran", minutes: 7 },
  { from: "Cooran", to: "Traveston", minutes: 6 },
  { from: "Traveston", to: "Woondum", minutes: 7 },
  { from: "Woondum", to: "Glanmire", minutes: 8 },
  { from: "Glanmire", to: "Gympie North", minutes: 4 },
  { from: "Yandina", to: "Eumundi", minutes: 10 },
  { from: "Eumundi", to: "Cooroy", minutes: 8 },
  { from: "Cooroy", to: "Pomona", minutes: 9 },
  { from: "Pomona", to: "Cooran", minutes: 7 },
  { from: "Cooran", to: "Traveston", minutes: 6 },
  { from: "Traveston", to: "Gympie North", minutes: 19 },
];

import type { TrainMovementDTO } from "../qr-travel/types.js";

// Helper: get SRT minutes between two stops (case-insensitive, try both directions)
function getSRTMinutes(from: string, to: string): number | null {
  const match = SRT.find(
    (row) =>
      row.from.toLowerCase() === from.toLowerCase() &&
      row.to.toLowerCase() === to.toLowerCase()
  );
  return match ? match.minutes : null;
}

// Main function: expands a TrainMovementDTO[] with passing stops and expected passing times
export function expandWithSRTPassingStops(
  stops: TrainMovementDTO[]
): Array<
  TrainMovementDTO & { passing?: boolean; expectedPassingTime?: string }
> {
  if (stops.length === 0) return [];
  // Build a list of all PlaceNames in the SRT route (SEQ only)
  const srtStations: string[] = Array.from(
    new Set(SRT.flatMap((row) => [row.from, row.to]))
  );

  // Find the first and last stop in the input that is in the SRT region
  let firstIdx = stops.findIndex((s) =>
    srtStations.some((name) => name.toLowerCase() === s.PlaceName.toLowerCase())
  );
  let lastIdx = (() => {
    for (let i = stops.length - 1; i >= 0; --i) {
      if (srtStations.some((name) => name.toLowerCase() === stops[i].PlaceName.toLowerCase()))
        return i;
    }
    return -1;
  })();
  if (firstIdx === -1 || lastIdx === -1 || firstIdx === lastIdx) {
    // No SRT region or only one SRT stop
    return stops.map((s) => ({ ...s, passing: false }));
  }

  // Build a map of PlaceName to stop index for quick lookup
  const stopIdxByName = new Map(
    stops.map((s, i) => [s.PlaceName.toLowerCase(), i])
  );

  // Build the expanded list
  let result: Array<TrainMovementDTO & { passing?: boolean; expectedPassingTime?: string }> = [];
  // Start with the first stop
  let prev = stops[firstIdx];
  let prevTime = prev.ActualDeparture !== "0001-01-01T00:00:00" && prev.ActualDeparture !== undefined && prev.ActualDeparture !== null
    ? new Date(prev.ActualDeparture)
    : prev.PlannedDeparture !== "0001-01-01T00:00:00" && prev.PlannedDeparture !== undefined && prev.PlannedDeparture !== null
    ? new Date(prev.PlannedDeparture)
    : null;
  result.push({ ...prev, passing: false });

  for (let i = firstIdx + 1; i <= lastIdx; ++i) {
    const curr = stops[i];
    // Find all SRT stops between prev and curr (exclusive)
    let between: string[] = [];
    let pIdx = srtStations.findIndex(
      (name) => name.toLowerCase() === prev.PlaceName.toLowerCase()
    );
    let cIdx = srtStations.findIndex(
      (name) => name.toLowerCase() === curr.PlaceName.toLowerCase()
    );
    if (pIdx !== -1 && cIdx !== -1 && Math.abs(cIdx - pIdx) > 1) {
      // Determine direction
      let dir = cIdx > pIdx ? 1 : -1;
      for (let j = pIdx + dir; j !== cIdx; j += dir) {
        between.push(srtStations[j]);
      }
    }
    // For each between stop, if not in the input stops, add as passing
    for (const passStop of between) {
      if (!stopIdxByName.has(passStop.toLowerCase())) {
        // Estimate passing time: add SRT minutes from prev to this stop
        let srtMins = getSRTMinutes(prev.PlaceName, passStop);
        if (srtMins == null && prevTime) {
          // Try reverse
          srtMins = getSRTMinutes(passStop, prev.PlaceName);
        }
        if (srtMins == null) srtMins = 0;
        let passTime = prevTime
          ? new Date(prevTime.getTime() + srtMins * 60000)
          : null;
        result.push({
          PlaceCode: passStop,
          PlaceName: passStop,
          KStation: false,
          Status: "Passed",
          TrainPosition: "Passed",
          PlannedArrival: "0001-01-01T00:00:00",
          PlannedDeparture: "0001-01-01T00:00:00",
          ActualArrival: "0001-01-01T00:00:00",
          ActualDeparture: "0001-01-01T00:00:00",
          passing: true,
          expectedPassingTime: passTime ? passTime.toISOString() : undefined,
        });
        // Advance prevTime for next passing stop
        if (passTime) prevTime = passTime;
      }
    }
    // Now add the current stop
    // Estimate arrival time: add SRT minutes from prev to curr
    let srtMins = getSRTMinutes(prev.PlaceName, curr.PlaceName);
    if (srtMins == null && prevTime) {
      srtMins = getSRTMinutes(curr.PlaceName, prev.PlaceName);
    }
    if (srtMins == null) srtMins = 0;
    if (prevTime) prevTime = new Date(prevTime.getTime() + srtMins * 60000);
    result.push({
      ...curr,
      passing: false,
      expectedPassingTime: prevTime ? prevTime.toISOString() : undefined,
    });
    prev = curr;
  }
  // Add any remaining stops after lastIdx as normal
  for (let i = lastIdx + 1; i < stops.length; ++i) {
    result.push({ ...stops[i], passing: false });
  }
  // Add any before firstIdx as normal
  for (let i = 0; i < firstIdx; ++i) {
    result.unshift({ ...stops[i], passing: false });
  }
  return result;
}
