import type { TraxConfig } from "../config.js";
import { hasDataFile, loadDataFile } from "./fs.js";

export type PlatformSide = "left" | "right" | "both";

export type PlatformDefinition = {
	platform_code: number;
	trackName: string;
	trackCode: string;
	from: string[];
	next: string[];
	exitSide: PlatformSide;
};

export type PlatformData = {
	srtData?: unknown;
	[stopId: string]: PlatformDefinition[] | unknown | undefined;
};

export function getPlatformData(config: TraxConfig): PlatformData {
	const DATA_PATH = `region-specific/${config.region.toLowerCase()}/platforms.json`;
	if (!config.region || !hasDataFile(DATA_PATH)) return {};
	return JSON.parse(loadDataFile(DATA_PATH)) as PlatformData;
}
