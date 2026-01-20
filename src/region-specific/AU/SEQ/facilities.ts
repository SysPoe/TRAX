import { TraxConfig } from "../../../config.js";
import logger from "../../../utils/logger.js";
import { RailwayStationFacility } from "./facilities-types.js";
import { loadDataFile, hasDataFile } from "../../../utils/fs.js";

export async function getRailwayStationFacilities(config: TraxConfig): Promise<RailwayStationFacility[]> {
	const relativePath = "region-specific/seq/railway-station-facilities.json";
	try {
		if (hasDataFile(relativePath)) {
			const data = loadDataFile(relativePath);
			return JSON.parse(data);
		} else {
			logger.warn(`Railway station facilities file not found at ${relativePath}`, { module: "SEQ-facilities" });
			return [];
		}
	} catch (error: any) {
		logger.error(`Failed to load railway station facilities: ${error.message}`, { module: "SEQ-facilities" });
		return [];
	}
}
