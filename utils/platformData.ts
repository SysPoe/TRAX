import { TRAX_CONFIG } from "../config.js";
import { hasDataFile, loadDataFile } from "./fs.js";

export type Platform = {
	platform_code: number;
	trackName: string;
	trackCode: string;
	from: string[]; // previous stop(s)
	next: string[]; // next stop(s)
	exitSide: "left" | "right"; // If the next or previous stop is not included in from / next, swap left and right
};

export type PlatformData = {
	[gtfs_stop_id: string]: Platform[];
};

const DATA_PATH = `region-specific/${TRAX_CONFIG.region}/platforms.json`;

export const platformData: PlatformData = TRAX_CONFIG.region && hasDataFile(DATA_PATH) ? JSON.parse(loadDataFile(DATA_PATH)) : [];


/*
	TODO:
	- Beenleigh / Gold Coast
*/

export default platformData;
