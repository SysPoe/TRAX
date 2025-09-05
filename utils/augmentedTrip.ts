import * as gtfs from "gtfs";
import { getServiceDatesByTrip } from "./calendar.js";
import {
  AugmentedStopTime,
  augmentStopTimes,
  SerializableAugmentedStopTime
} from "./augmentedStopTime.js";
import { ExpressInfo, findExpress } from "./express.js";
import * as cache from "../cache.js";
import { formatTimestamp } from "../index.js";

export type AugmentedTrip = {
  _trip: gtfs.Trip;
  scheduledStartServiceDates: number[]; // Days on which the trip is scheduled to start
  scheduledTripDates: number[]; // Days on which the trip is scheduled to have stops
  actualTripDates: number[]; // Days on which the trip actually has stops (with real-time updates)
  _runSeries: { [serviceDate: number]: string | null };
  runSeries: { [serviceDate: number]: string };
  stopTimes: AugmentedStopTime[];
  expressInfo: ExpressInfo[];
  run: string;
  toSerializable: () => SerializableAugmentedTrip;
};

export type RunSeries = {
  trips: {
    trip_start_time: number;
    trip_id: string;
    run: string;
  }[];
  vehicle_sightings: string[]; // TODO fill this in
  series: string;
  date: number;
};

export type SerializableAugmentedTrip = Omit<
  AugmentedTrip,
  "stopTimes" | "toSerializable" | "_runSeries"
> & {
  stopTimes: SerializableAugmentedStopTime[];
};

export function toSerializableAugmentedTrip(
  trip: AugmentedTrip | Omit<AugmentedTrip, "toSerializable" | "toSerializable" | "_runSeries">
): SerializableAugmentedTrip {
  return {
    _trip: trip._trip,
    scheduledStartServiceDates: trip.scheduledStartServiceDates,
    scheduledTripDates: trip.scheduledTripDates,
    actualTripDates: trip.actualTripDates,
    runSeries: trip.runSeries,
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

  // Pre-calculate stop times during trip creation instead of on-demand
  let cachedStopTimes: AugmentedStopTime[] | null = null;

  let _runSeries: { [serviceDate: number]: string | null } = {};
  for (const serviceDate of serviceDates) {
    _runSeries[serviceDate] = null;
  }

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
    _runSeries,
    get runSeries() {
      calculateRunSeries(this);
      for (const key of Object.keys(this._runSeries)) {
        console.assert(this._runSeries[Number.parseInt(key)] !== null);
      }
      return this._runSeries as { [serviceDate: number]: string };
    },
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
        runSeries: this.runSeries,
        run: trip.trip_id.slice(-4),
      });
    },
  };
}

const RS_TOLLERATE_SECS = 30 * 60;

/**
 * @returns Run series
 */
function trackBackwards(trip: AugmentedTrip, serviceDate: number): string {
  let run = trip.run;
  let prevTrips = [trip];
  for (let _break = 0; _break < 100; _break++) {
    let st = trip.stopTimes[0];
    if ((st.scheduled_departure_timestamp || st.scheduled_arrival_timestamp) === null)
      break;

    if ((st.scheduled_departure_timestamp || st.scheduled_arrival_timestamp || 0) < RS_TOLLERATE_SECS) break;

    // Get departures for previous 30 mins
    let deps_ids = gtfs.getStoptimes({
      stop_id: st.scheduled_stop?.stop_id,
      date: serviceDate,
      start_time: formatTimestamp((st.scheduled_departure_timestamp || st.scheduled_arrival_timestamp || 0) - RS_TOLLERATE_SECS) + ":00",
      end_time: formatTimestamp((st.scheduled_departure_timestamp || st.scheduled_arrival_timestamp || 0)) + ":00"
    })
    let deps = deps_ids.map(v => cache.getAugmentedTrips(v.trip_id)[0].stopTimes.find(v => v.scheduled_stop?.stop_id == st.scheduled_stop?.stop_id)).filter((v): v is AugmentedStopTime => !!v);

    // Get next previous arrival before the current trip departs
    deps = deps.filter(v => v._stopTime?.trip_id.slice(-4)[0] == run[0] && v._stopTime?.trip_id.slice(-4) != run);

    deps = deps.sort((a, b) => (a.scheduled_departure_timestamp || a.scheduled_arrival_timestamp || Infinity) - (b.scheduled_departure_timestamp || b.scheduled_arrival_timestamp || Infinity));

    if (deps.length === 0) break;
    let newTrip = cache.getAugmentedTrips((deps.at(-1)?.trip_id)!)[0];
    if (!newTrip) break;
    if (deps.at(-1)?._stopTime?.stop_sequence != newTrip.stopTimes.at(-1)?._stopTime?.stop_sequence) break;

    prevTrips.push(newTrip);
    run = newTrip.run;
    trip = newTrip;
  }
  let rs = cache.getRunSeries(serviceDate, run, false);
  for (const prevTrip of prevTrips) {
    prevTrip._runSeries[serviceDate] = run;
    rs?.trips.push({
      trip_id: prevTrip._trip.trip_id,
      trip_start_time: prevTrip.stopTimes[0].scheduled_departure_timestamp || prevTrip.stopTimes[0].scheduled_arrival_timestamp || 0,
      run: prevTrip.run
    })
  }
  rs.trips = rs.trips.sort((a, b) => a.trip_start_time - b.trip_start_time);
  cache.setRunSeries(serviceDate, run, rs);
  return run;
}

function trackForwards(trip: AugmentedTrip, serviceDate: number, runSeries: string): void {
  let run = trip.run;
  let rs = cache.getRunSeries(serviceDate, runSeries, false);
  // Track forwards, setting the runSeries
  for (let _break = 0; _break < 100; _break++) {
    let st = trip.stopTimes.at(-1) as AugmentedStopTime;
    if ((st.scheduled_departure_timestamp || st.scheduled_arrival_timestamp) === null)
      break;

    // Get departures for next 30 mins
    let deps_ids = gtfs.getStoptimes({
      stop_id: st.scheduled_stop?.stop_id,
      date: serviceDate,
      start_time: formatTimestamp((st.scheduled_departure_timestamp || st.scheduled_arrival_timestamp || 0)) + ":00",
      end_time: formatTimestamp((st.scheduled_departure_timestamp || st.scheduled_arrival_timestamp || 0) + RS_TOLLERATE_SECS) + ":00"
    })
    let deps = deps_ids.map(v => cache.getAugmentedTrips(v.trip_id)[0].stopTimes.find(v => v.scheduled_stop?.stop_id == st.scheduled_stop?.stop_id)).filter((v): v is AugmentedStopTime => !!v);

    deps = deps.filter(v => v._stopTime?.trip_id.slice(-4)[0] == run[0] && v._stopTime?.trip_id.slice(-4) != run);

    deps = deps.sort((a, b) => (a.scheduled_departure_timestamp || a.scheduled_arrival_timestamp || Infinity) - (b.scheduled_departure_timestamp || b.scheduled_arrival_timestamp || Infinity));

    if (deps.length === 0) break;
    let newTrip = cache.getAugmentedTrips(deps[0].trip_id)[0];
    if (!newTrip) break;
    if (deps[0]?._stopTime?.stop_sequence != 1) break;
    newTrip._runSeries[serviceDate] = runSeries;
    run = newTrip.run;
    rs.trips.push({
      trip_id: newTrip._trip.trip_id,
      trip_start_time: newTrip.stopTimes[0].scheduled_departure_timestamp || newTrip.stopTimes[0].scheduled_arrival_timestamp || 0,
      run,
    });
    trip = newTrip;
  }
  rs.trips = rs.trips.sort((a, b) => a.trip_start_time - b.trip_start_time);
  cache.setRunSeries(serviceDate, runSeries, rs);
}

export function calculateRunSeries(trip: AugmentedTrip): void {
  for (const serviceDate of trip.scheduledStartServiceDates) {
    if (trip._runSeries[serviceDate] != null) continue;
    let runSeries = trackBackwards(trip, serviceDate);
    trackForwards(trip, serviceDate, runSeries);
  }
}