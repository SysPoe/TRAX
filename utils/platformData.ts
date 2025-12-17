import { TraxConfig } from "../config.js";
import { hasDataFile, loadDataFile } from "./fs.js";

export function getPlatformData(config: TraxConfig): any {
	const DATA_PATH = `region-specific/${config.region}/platforms.json`;
	return config.region && hasDataFile(DATA_PATH) ? JSON.parse(loadDataFile(DATA_PATH)) : {};
}
