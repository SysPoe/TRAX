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
  scheduledStartServiceDates: number[]; // Days on which the trip is scheduled to start
  scheduledTripDates: number[]; // Days on which the trip is scheduled to have stops
  actualTripDates: number[]; // Days on which the trip actually has stops (with real-time updates)
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
    scheduledStartServiceDates: trip.scheduledStartServiceDates,
    scheduledTripDates: trip.scheduledTripDates,
    actualTripDates: trip.actualTripDates,
    tracks: trip.tracks,
    stopTimes: Array.isArray(trip.stopTimes)
      ? trip.stopTimes.map((st) => st.toSerializable())
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

  // Pre-calculate stop times during trip creation instead of on-demand
  let cachedStopTimes: AugmentedStopTime[] | null = null;

  return {
    _trip: trip,
    scheduledStartServiceDates: serviceDates,
    get scheduledTripDates() {
      // Use cached version if available
      let stopTimes = cache.getAugmentedStopTimes(trip.trip_id);
      let stopTimesToUse: AugmentedStopTime[];
      if (stopTimes.length > 0) {
        stopTimesToUse = stopTimes;
      } else {
        // Calculate once and cache
        if (!cachedStopTimes) {
          cachedStopTimes = augmentStopTimes(rawStopTimes, serviceDates);
        }
        stopTimesToUse = cachedStopTimes;
      }

      let dates = [
        ...new Set(
          stopTimesToUse
            .map((st) => [
              ...(st.scheduled_arrival_dates || []),
              ...(st.scheduled_departure_dates || []),
            ])
            .flat()
        ),
      ];
      return dates.sort((a, b) => a - b);
    },
    get actualTripDates() {
      let stopTimes = cache.getAugmentedStopTimes(trip.trip_id);
      let stopTimesToUse: AugmentedStopTime[];
      if (stopTimes.length > 0) {
        stopTimesToUse = stopTimes;
      } else {
        // Calculate once and cache
        if (!cachedStopTimes) {
          cachedStopTimes = augmentStopTimes(rawStopTimes, serviceDates);
        }
        stopTimesToUse = cachedStopTimes;
      }

      let dates = [
        ...new Set(
          stopTimesToUse
            .map((st) => [
              ...(st.actual_arrival_dates || []),
              ...(st.actual_departure_dates || []),
            ])
            .flat()
        ),
      ];
      return dates.sort((a, b) => a - b);

    },
    get stopTimes() {
      // Use cached version if available
      let stopTimes = cache.getAugmentedStopTimes(trip.trip_id);
      if (stopTimes.length > 0) return stopTimes;

      // Calculate once and cache
      if (!cachedStopTimes) {
        cachedStopTimes = augmentStopTimes(rawStopTimes, serviceDates);
      }
      return cachedStopTimes;
    },
    expressInfo,
    tracks,
    run: trip.trip_id.slice(-4),
    toSerializable: function () {
      // Use cached version if available
      let stopTimes = cache.getAugmentedStopTimes(trip.trip_id);
      if (stopTimes.length === 0) {
        if (!cachedStopTimes) {
          cachedStopTimes = augmentStopTimes(rawStopTimes, serviceDates);
        }
        stopTimes = cachedStopTimes;
      }
      return toSerializableAugmentedTrip({
        _trip: trip,
        scheduledStartServiceDates: serviceDates,
        scheduledTripDates: this.scheduledTripDates,
        actualTripDates: this.actualTripDates,
        stopTimes,
        expressInfo,
        tracks,
        run: trip.trip_id.slice(-4),
      });
    },
  };
}
