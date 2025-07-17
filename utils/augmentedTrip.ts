import type * as gtfs from "gtfs";
import { getServiceDatesByTrip } from "./calendar.js";
import { AugmentedStoptime, augmentStoptimes } from "./augmentedStoptime.js";
import { ExpressInfo, findExpress } from "./express.js";
import * as cache from "../cache.js";

export type AugmentedTrip = {
  _trip: gtfs.Trip;
  serviceDates: number[];
  tracks: { [serviceDate: number]: string };
  stopTimes: AugmentedStoptime[];
  expressInfo: ExpressInfo[];
};

export function augmentTrip(trip: gtfs.Trip): AugmentedTrip {
  const serviceDates = getServiceDatesByTrip(trip.trip_id);

  // Lazily load stoptimes for this trip via GTFS
  let rawStopTimes = cache
    .getRawStoptimes(trip.trip_id)
    .sort((a, b) => a.stop_sequence - b.stop_sequence);

  let parentStops = rawStopTimes.map((st) => cache.getRawStops(st.stop_id)[0].parent_station);

  let stopTimes = augmentStoptimes(rawStopTimes);
  let expressInfo = findExpress(parentStops);

  let tracks: { [serviceDate: number]: string } = {};
  for(const serviceDate of serviceDates) {
    tracks[serviceDate] = "Not implemented";
  }

  return {
    _trip: trip,
    serviceDates,
    stopTimes,
    expressInfo,
    tracks,
  };
}
