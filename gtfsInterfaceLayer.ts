import { GTFS } from "qdf-gtfs";
import { TRAX_CONFIG } from "./config.js";

let currentGtfs: GTFS | null = null;

export async function createGtfs() {
    let gtfs = new GTFS({ ansi: false, logger: TRAX_CONFIG.logFunction });
    await gtfs.loadFromUrl(TRAX_CONFIG.url);
    await gtfs.updateRealtimeFromUrl(TRAX_CONFIG.realtimeAlerts, TRAX_CONFIG.realtimeTripUpdates, TRAX_CONFIG.realtimeVehiclePositions);
    currentGtfs = gtfs;
}

export function hasGtfs() {
    return currentGtfs != null;
}

export function getGtfs(): GTFS { // dangerous!
    if (currentGtfs == null) throw new Error("Tried to access GTFS object before it's loaded!!!");
    return currentGtfs;
}