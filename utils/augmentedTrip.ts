import type * as gtfs from "gtfs";
import { getServiceDatesByTrip } from "./calendar.js";
import {
  AugmentedStopTime,
  augmentStopTimes,
  SerializableAugmentedStopTime,
  toSerializableAugmentedStopTime,
} from "./augmentedStopTime.js";
import { ExpressInfo, findExpress } from "./express.js";
import * as cache from "../cache.js";

export type AugmentedTrip = {
  _trip: gtfs.Trip;
  serviceDates: number[];
  tracks: { [serviceDate: number]: string };
  stopTimes: AugmentedStopTime[];
  expressInfo: ExpressInfo[];
  run: string;
  toSerializable: () => SerializableAugmentedTrip;
};

export type SerializableAugmentedTrip = Omit<
  AugmentedTrip,
  "stopTimes" | "toSerializable"
> & {
  stopTimes: SerializableAugmentedStopTime[];
};

export function toSerializableAugmentedTrip(
  trip: AugmentedTrip | Omit<AugmentedTrip, "toSerializable">
): SerializableAugmentedTrip {
  return {
    _trip: trip._trip,
    serviceDates: trip.serviceDates,
    tracks: trip.tracks,
    stopTimes: Array.isArray(trip.stopTimes)
      ? trip.stopTimes.map((st) => toSerializableAugmentedStopTime(st as AugmentedStopTime))
      : [],
    expressInfo: trip.expressInfo,
    run: trip.run,
  };
}

export function augmentTrip(trip: gtfs.Trip): AugmentedTrip {
  const serviceDates = getServiceDatesByTrip(trip.trip_id);

  let rawStopTimes = cache
    .getRawStopTimes(trip.trip_id)
    .sort((a, b) => a.stop_sequence - b.stop_sequence);

  let parentStops = rawStopTimes.map(
    (st) => cache.getRawStops(st.stop_id)[0]?.parent_station ?? ""
  );
  let expressInfo = findExpress(parentStops.filter((id): id is string => !!id));

  let tracks: { [serviceDate: number]: string } = {};
  for (const serviceDate of serviceDates) {
    tracks[serviceDate] = "Not implemented";
  }

  return {
    _trip: trip,
    serviceDates,
    get stopTimes() {
      let stopTimes = cache.getAugmentedStopTimes(trip.trip_id);
      if (stopTimes.length === 0) stopTimes = augmentStopTimes(rawStopTimes);
      return stopTimes;
    },
    expressInfo,
    tracks,
    run: trip.trip_id.slice(-4),
    toSerializable: () => {
      let stopTimes = cache.getAugmentedStopTimes(trip.trip_id);
      if (stopTimes.length === 0) stopTimes = augmentStopTimes(rawStopTimes);
      return toSerializableAugmentedTrip({
        _trip: trip,
        serviceDates,
        stopTimes,
        expressInfo,
        tracks,
        run: trip.trip_id.slice(-4),
      });
    },
  };
}
