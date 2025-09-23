import type * as gtfs from "gtfs";
import * as cache from "../cache.js";
import { AugmentedStopTime } from "./augmentedStopTime.js";
import { getAugmentedTrips } from "../cache.js";
import { findExpressString } from "./express.js";

export type AugmentedStop = gtfs.Stop & {
  qrt_Place: boolean;
  qrt_PlaceCode?: string;
  parent: AugmentedStop | null;
  children: AugmentedStop[];
  getDepartures: (
    date: number,
    start_time: string,
    end_time: string
  ) => (AugmentedStopTime & { express_string: string })[];
  _getSDDepartures: (
    serviceDate: number,
    start_time_secs: number,
    end_time_secs: number
  ) => (AugmentedStopTime & { express_string: string })[];
  toSerializable: () => SerializableAugmentedStop;
};

export type SerializableAugmentedStop = gtfs.Stop & {
  qrt_Place: boolean;
  qrt_PlaceCode?: string;
  parent: string | null;
  children: string[];
};

export function toSerializableAugmentedStop(
  stop: Omit<AugmentedStop, "toSerializable" | "getDepartures" | "_getSDDepartures">
): SerializableAugmentedStop {
  return {
    ...stop,
    parent: stop.parent_station ?? null,
    children: stop.children.map((child) => child.stop_id),
  };
}

export function augmentStop(stop: gtfs.Stop): AugmentedStop {  
  // Cache children lookup to avoid repeated expensive operations
  let cachedChildren: AugmentedStop[] | null = null;

  const getChildren = (): AugmentedStop[] => {
    if (cachedChildren) return cachedChildren;
    
    const childStops = cache
      .getRawStops()
      .filter((s) => s.parent_station === stop.stop_id);
    cachedChildren = childStops.map(
      (s) => cache.getAugmentedStops(s.stop_id)[0] || augmentStop(s)
    );    
    return cachedChildren;
  };

  let qrt_Places = cache.getQRTPlaces();
  let trimmedStopName = stop.stop_name?.toLowerCase().replace("station", "").trim();
  let myPlace = qrt_Places.find((v) => v.Title?.toLowerCase().trim() === trimmedStopName || (trimmedStopName === "roma street" && v.Title?.toLowerCase().trim().includes("roma street")));

  const getParent = (): AugmentedStop | null => {
    if (!stop.parent_station) return null;
    return cache.getAugmentedStops(stop.parent_station)[0];
  };
  
  return {
    ...stop,
    qrt_Place: !!myPlace,
    qrt_PlaceCode: myPlace?.qrt_PlaceCode,
    get parent(): AugmentedStop | null {
      return getParent();
    },
    get children(): AugmentedStop[] {
      return getChildren();
    },
    toSerializable() {
      return toSerializableAugmentedStop({
        ...stop,
        qrt_Place: !!myPlace,
        qrt_PlaceCode: myPlace?.qrt_PlaceCode,
        get parent(): AugmentedStop | null {
          return getParent();
        },
        get children(): AugmentedStop[] {
          return getChildren();
        },
      });
    },
    getDepartures: (date: number, start_time: string, end_time: string) => {      
      const startSec = timeSeconds(start_time);
      const endSec = timeSeconds(end_time);
      const parentId = getParent()?.stop_id;
      const childIds = getChildren().map((c) => c.stop_id);
      const validStops = new Set<string>(
        [stop.stop_id, parentId, ...childIds].filter(Boolean) as string[]
      );
      const tripCache = new Map<
        string,
        ReturnType<typeof getAugmentedTrips>[0]
      >();
      const results: { st: AugmentedStopTime; trip: any }[] = [];      
      for (const st of cache.getAugmentedStopTimes()) {
        if (!st.actual_stop || !validStops.has(st.actual_stop.stop_id))
          continue;
        let trip = tripCache.get(st.trip_id);
        if (!trip) {
          trip = getAugmentedTrips(st.trip_id)[0];
          tripCache.set(st.trip_id, trip);
        }
        if (!trip?.actualTripDates?.includes(date)) continue;
        const ts = st.actual_departure_timestamp;
        if (ts == null || ts < startSec || ts > endSec) continue;
        results.push({ st, trip });
      }
      return results
        .sort(
          (a, b) =>
            (a.st.actual_departure_timestamp ?? 0) -
            (b.st.actual_departure_timestamp ?? 0)
        )
        .map(({ st, trip }) => {
          const expressString = findExpressString(
            trip.expressInfo,
            st.actual_parent_station?.stop_id ||
              st.actual_stop?.parent_station ||
              st.actual_stop?.stop_id ||
              ""
          );
          return {
            ...st,
            express_string: expressString,
          };
        });
    },
    _getSDDepartures: (serviceDate: number, start_time_secs: number, end_time_secs: number) => {
      const parentId = getParent()?.stop_id;
      const childIds = getChildren().map((c) => c.stop_id);
      const validStops = new Set<string>(
        [stop.stop_id, parentId, ...childIds].filter(Boolean) as string[]
      );
      const tripCache = new Map<
        string,
        ReturnType<typeof getAugmentedTrips>[0]
      >();
      const results: { st: AugmentedStopTime; trip: any }[] = [];      
      for (const st of cache.getAugmentedStopTimes()) {
        if (!st.actual_stop || !validStops.has(st.actual_stop.stop_id))
          continue;
        let trip = tripCache.get(st.trip_id);
        if (!trip) {
          trip = getAugmentedTrips(st.trip_id)[0];
          tripCache.set(st.trip_id, trip);
        }
        if (!trip?.scheduledStartServiceDates?.includes(serviceDate)) continue;
        const ts = st.actual_departure_timestamp;
        if (ts == null || ts < start_time_secs || ts > end_time_secs) continue;
        results.push({ st, trip });
      }      
      return results
        .sort(
          (a, b) =>
            (a.st.actual_departure_timestamp ?? 0) -
            (b.st.actual_departure_timestamp ?? 0)
        )
        .map(({ st, trip }) => {
          const expressString = findExpressString(
            trip.expressInfo,
            st.actual_parent_station?.stop_id ||
              st.actual_stop?.parent_station ||
              st.actual_stop?.stop_id ||
              ""
          );
          return {
            ...st,
            express_string: expressString,
          };
        });
    },
  };
}

function timeSeconds(time: string): number {
  const [hours, minutes, seconds] = time.split(":").map(Number);
  return hours * 3600 + minutes * 60 + seconds;
}
