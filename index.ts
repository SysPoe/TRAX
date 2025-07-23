import * as gtfs from "gtfs";
import fs from "fs";
import * as cache from "./cache.js";
import * as calendar from "./utils/calendar.js";
import * as stations from "./stations.js";

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
  sqlitePath: "./db.sqlite",
  verbose: DEBUG,
  db: undefined,
};

let realtimeInterval: NodeJS.Timeout | null = null;
let staticInterval: NodeJS.Timeout | null = null;

export async function loadGTFS(refresh: boolean = false, forceReload: boolean = false): Promise<void> {
  const dbExists = fs.existsSync(config.sqlitePath);
  if (!dbExists || forceReload) {
    await gtfs.importGtfs(config);
  }

  await gtfs.updateGtfsRealtime(config);
  cache.refreshStaticCache();
  cache.refreshRealtimeCache();

  if(gtfs.getStops().length === 0) {
    await gtfs.importGtfs(config);
  }

  if (!refresh) return;

  realtimeInterval = setInterval(updateRealtime, 60 * 1000);
  staticInterval = setInterval(() => {
    gtfs.importGtfs(config);
    cache.refreshStaticCache();
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
  cache.refreshRealtimeCache();
}

export default {
  config,
  loadGTFS,
  updateRealtime,
  clearIntervals,
  formatTimestamp,
  ...cache,
  calendar,
  ...stations,
};
