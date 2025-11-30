import { GTFS } from "qdf-gtfs";
import { TRAX_CONFIG } from "./index.js";
let currentGtfs = null;
export async function createGtfs() {
    let gtfs = new GTFS({ ansi: false, logger: TRAX_CONFIG.logFunction });
    await gtfs.loadFromUrl(TRAX_CONFIG.url);
    // TODO realtime
    currentGtfs = gtfs;
}
export function hasGtfs() {
    return currentGtfs != null;
}
export function getGtfs() {
    if (currentGtfs == null)
        throw new Error("Tried to access GTFS object before it's loaded!!!");
    return currentGtfs;
}
