import type * as gtfs from "gtfs";
import * as cache from "../cache.js";
import { AugmentedStoptime } from "./augmentedStoptime.js";

export type AugmentedStop = gtfs.Stop & {
  parent: AugmentedStop | null;
  children: AugmentedStop[];
  getDepartures: (
    date: number,
    start_time: string,
    end_time: string
  ) => AugmentedStoptime[];
};

export function augmentStop(stop: gtfs.Stop): AugmentedStop {
  return {
    ...stop,
    get parent(): AugmentedStop | null {
      if (!stop.parent_station) return null;
      return cache.getAugmentedStops(stop.parent_station)[0];
    },
    get children(): AugmentedStop[] {
      const childStops = cache
        .getRawStops()
        .filter((s) => s.parent_station === stop.stop_id);
      return childStops.map((s) => augmentStop(s));
    },
    getDepartures: () => {
      throw new Error("getDepartures is not implemented for augmented stops");
    },
  };
}
