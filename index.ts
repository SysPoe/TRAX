import * as gtfs from "gtfs";
import fs from "fs";
import * as cache from "./cache.js";
import * as calendar from "./utils/calendar.js";
import * as stations from "./stations.js";
import * as express from "./utils/express.js";
import * as qrTravel from "./qr-travel/qr-travel-tracker.js";
import * as augmentedStopTime from "./utils/augmentedStopTime.js";
import logger, { LogLevel } from "./utils/logger.js";

export const DEBUG = true;

// Configure logger based on DEBUG flag
if (DEBUG) {
  logger.setLevel(LogLevel.DEBUG);
} else {
  logger.setLevel(LogLevel.INFO);
}

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
  logFunction: (message: string) => logger.debug(message, { module: "gtfs" }),
};

let realtimeInterval: NodeJS.Timeout | null = null;
let staticInterval: NodeJS.Timeout | null = null;

export async function loadGTFS(
  autoRefresh: boolean = false,
  forceReload: boolean = false,
  realtimeIntervalMs: number = 60 * 1000, // 1 minute
  staticIntervalMs: number = 24 * 60 * 60 * 1000 // 24 hours
): Promise<void> {
  const dbExists = fs.existsSync(config.sqlitePath);
  if (!dbExists || forceReload) await gtfs.importGtfs(config);

  await gtfs.updateGtfsRealtime(config);
  await cache.refreshStaticCache(true);
  await cache.refreshRealtimeCache();

  if (gtfs.getStops().length === 0) await gtfs.importGtfs(config);

  if (!autoRefresh) return;

  realtimeInterval = setInterval(
    () =>
      updateRealtime().catch((err: any) =>
        logger.error("Error refreshing realtime GTFS data", { module: "index", function: "loadGTFS", error: err.message || err })
      ),
    realtimeIntervalMs
  );
  staticInterval = setInterval(async () => {
    try {
      await gtfs.importGtfs(config);
      await cache.refreshStaticCache(true);
      await cache.refreshRealtimeCache();
    } catch (error: any) {
      logger.error("Error refreshing static GTFS data", { module: "index", function: "loadGTFS", error: error.message || error });
    }
  }, staticIntervalMs);
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
  if (ts === null || ts === undefined) return "--:--";
  let h = Math.floor(ts / 3600);
  let m = Math.floor((ts % 3600) / 60);
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
}

export async function updateRealtime(): Promise<void> {
  try {
    await gtfs.updateGtfsRealtime(config);
    await cache.refreshRealtimeCache();
  } catch (error: any) {
    logger.error("Error updating realtime GTFS data", { module: "index", function: "updateRealtime", error: error.message || error });
    throw error;
  }
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
  ScheduleRelationship: augmentedStopTime.ScheduleRelationship,
  logger, // Export the logger
};

export type {
  AugmentedTrip,
  SerializableAugmentedTrip,
  RunSeries
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

export { Logger, LogLevel } from "./utils/logger.js"; // Export logger types
