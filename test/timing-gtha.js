import TRAXClass, { logger, LogLevel, PRESETS } from "../dist/index.js";
import { config } from "dotenv";
import { existsSync } from "node:fs";

if (existsSync(".env")) {
	config();
}

async function main() {
	console.log("Loading GTHA gtfs data with detailed timing...");

	const TRAX = new TRAXClass({
		...PRESETS["CA/GTHA"](process.env.METROLINX_KEY),
		disableTimers: false,
	});
	logger.setLevel(LogLevel.TIMING);

	let start = Date.now();
	await TRAX.loadGTFS(true, false);
	let end = Date.now();

	const totalTime = (end - start) / 1000;
	console.log(`\n\nTotal time: ${totalTime.toFixed(2)}s`);

	TRAX.logTimings("GTHA Performance Analysis", false);

	if (totalTime > 30) {
		console.log(`\n⚠️  Target NOT achieved: ${totalTime.toFixed(2)}s > 30s`);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
