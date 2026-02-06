import TRAXClass, { logger, LogLevel } from "../dist/index.js";

async function main() {
	console.log("Loading gtfs data with timers ENABLED to get detailed timing...");

	const TRAX = new TRAXClass({ disableTimers: false });
	logger.setLevel(LogLevel.TIMING);

	let start = Date.now();
	await TRAX.loadGTFS(false, false);
	let end = Date.now();

	const totalTime = (end - start) / 1000;
	console.log(`\n\nTotal time: ${totalTime.toFixed(2)}s`);

	TRAX.logTimings("SEQ Performance Analysis", false);
}

main().catch(console.error);
