import type * as gtfs from "gtfs";
import * as cache from "../cache.js";
import {
  AugmentedStopTime,
  SerializableAugmentedStopTime,
} from "./augmentedStopTime.js";
import { getAugmentedTrips } from "../cache.js";
import { findExpressString } from "./express.js";

export type AugmentedStop = gtfs.Stop & {
  parent: AugmentedStop | null;
  children: AugmentedStop[];
  getDepartures: (
    date: number,
    start_time: string,
    end_time: string
  ) => (AugmentedStopTime & { express_string: string })[];
  toSerializable: () => SerializableAugmentedStop;
};

export type SerializableAugmentedStop = gtfs.Stop & {
  parent: string | null;
  children: string[];
};

export function toSerializableAugmentedStop(
  stop:
    | AugmentedStop
    | (gtfs.Stop & {
        parent: AugmentedStop | null;
        children: AugmentedStop[];
      })
): SerializableAugmentedStop {
  return {
    ...stop,
    parent: stop.parent_station ?? null,
    children: stop.children.map((child) => child.stop_id),
  };
}

export function augmentStop(stop: gtfs.Stop): AugmentedStop {
  const getChildren = (): AugmentedStop[] => {
    const childStops = cache
      .getRawStops()
      .filter((s) => s.parent_station === stop.stop_id);
    return childStops.map(
      (s) => cache.getAugmentedStops(s.stop_id)[0] || augmentStop(s)
    );
  };
  const getParent = (): AugmentedStop | null => {
    if (!stop.parent_station) return null;
    return cache.getAugmentedStops(stop.parent_station)[0];
  };
  return {
    ...stop,
    get parent(): AugmentedStop | null {
      return getParent();
    },
    get children(): AugmentedStop[] {
      return getChildren();
    },
    toSerializable() {
      return toSerializableAugmentedStop({
        ...stop,
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
        if (!trip?.serviceDates?.includes(date)) continue;
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
  };
}

function timeSeconds(time: string): number {
  const [hours, minutes, seconds] = time.split(":").map(Number);
  return hours * 3600 + minutes * 60 + seconds;
}
