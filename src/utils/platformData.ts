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

/** True when `platforms.json` rows are loaded (not only e.g. `srtData` from QR Travel). */
export function seqPlatformDefinitionsPresent(pd: PlatformData | undefined): boolean {
	if (!pd) return false;
	for (const k of Object.keys(pd)) {
		if (k === "srtData") continue;
		const v = pd[k as keyof PlatformData];
		if (Array.isArray(v)) return true;
	}
	return false;
}

function platformsJsonPath(pluginId: string): string {
	/* SEQ static data lives under region-specific/seq/, not au/seq/. */
	if (pluginId === "au-seq")
		return "region-specific/seq/platforms.json";
	return `region-specific/${pluginId}/platforms.json`;
}

export function getPlatformData(config: TraxConfig): PlatformData {
	const pluginId = config.network.plugins[0]?.id;
	if (!pluginId) return {};
	const DATA_PATH = platformsJsonPath(pluginId);
	if (!hasDataFile(DATA_PATH)) return {};
	return JSON.parse(loadDataFile(DATA_PATH)) as PlatformData;
}
