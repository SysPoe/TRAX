import { loadDataFile } from "./fs.js";

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

export const platformData: PlatformData = JSON.parse(loadDataFile("platforms.json"));


/*
	TODO:
	- Beenleigh / Gold Coast
*/

export default platformData;
