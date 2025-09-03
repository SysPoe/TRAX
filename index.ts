import * as gtfs from "gtfs";
import fs from "fs";
import * as cache from "./cache.js";
import * as calendar from "./utils/calendar.js";
import * as stations from "./stations.js";
import * as express from "./utils/express.js";
import * as qrTravel from "./qr-travel/qr-travel-tracker.js";

export const DEBUG = true;

let config = {
  agencies: [
    {
      url: "https://gtfsrt.api.translink.com.au/GTFS/SEQ_GTFS.zip",
      realtimeAlerts: {
        url: "https://gtfsrt.api.translink.com.au/api/realtime/SEQ/alerts",
      },
      realtimeTripUpdates: {
        url: "https://gtfsrt.api.translink.com.au/api/realtime/SEQ/TripUpdates",
      },
      realtimeVehiclePositions: {
        url: "https://gtfsrt.api.translink.com.au/api/realtime/SEQ/VehiclePositions",
      },
    },
  ],
  sqlitePath: "./.TRAXCACHE.sqlite",
  verbose: DEBUG,
  db: undefined,
};

let realtimeInterval: NodeJS.Timeout | null = null;
let staticInterval: NodeJS.Timeout | null = null;

export async function loadGTFS(
  refresh: boolean = false,
  forceReload: boolean = false
): Promise<void> {
  const dbExists = fs.existsSync(config.sqlitePath);
  if (!dbExists || forceReload) {
    await gtfs.importGtfs(config);
  }

  await gtfs.updateGtfsRealtime(config);
  await cache.refreshStaticCache();
  await cache.refreshRealtimeCache();

  if (gtfs.getStops().length === 0) {
    await gtfs.importGtfs(config);
  }

  if (!refresh) return;

  realtimeInterval = setInterval(
    () =>
      updateRealtime().catch((err) =>
        console.error("Error refreshing realtime GTFS data:", err)
      ),
    60 * 1000
  );
  staticInterval = setInterval(async () => {
    try {
      await gtfs.importGtfs(config);
      await cache.refreshStaticCache();
    } catch (error) {
      console.error("Error refreshing static GTFS data:", error);
    }
  }, 24 * 60 * 60 * 1000);
}

export function clearIntervals(): void {
  if (realtimeInterval) {
    clearInterval(realtimeInterval);
    realtimeInterval = null;
  }
  if (staticInterval) {
    clearInterval(staticInterval);
    staticInterval = null;
  }
}

export function formatTimestamp(ts?: number | null): string {
  if (!ts) return "--:--";
  const d = new Date(ts * 1000);
  return d.toISOString().slice(11, 16);
}

export async function updateRealtime(): Promise<void> {
  await gtfs.updateGtfsRealtime(config);
  await cache.refreshRealtimeCache();
}

export function today(): number {
  return Number.parseInt(new Date(Date.now() + 3600 * 10 * 1000).toISOString().slice(0, 10).replace(/-/g, ""));
}

export default {
  config,
  loadGTFS,
  updateRealtime,
  clearIntervals,
  formatTimestamp,
  today,
  ...cache,
  express,
  calendar,
  ...stations,
  qrTravel,
};

export type {
  AugmentedTrip,
  SerializableAugmentedTrip,
} from "./utils/augmentedTrip.js";

export type {
  AugmentedStopTime,
  SerializableAugmentedStopTime,

} from "./utils/augmentedStopTime.js";

export type {
  AugmentedStop,
  SerializableAugmentedStop,
} from "./utils/augmentedStop.js";

export type {
  TrainMovementDTO,
  ServiceDisruption,
  GetServiceResponse,
  QRTPlace,
  Service,
  Direction,
  ServiceLine,
  AllServicesResponse,
  QRTService,
  ServiceUpdate,
  TravelStopTime,
  TravelTrip,
} from "./qr-travel/types.js";

export type {
  ExpressInfo
} from "./utils/express.js";

export type { SRTStop } from "./utils/SectionalRunningTimes/metroSRTTravelTrain.js";
