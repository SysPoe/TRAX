import TRAXClass, { AU_SEQ_NETWORK, logger, LogLevel } from "../dist/index.js";

async function main() {
	console.log("Loading gtfs data with timers ENABLED to get detailed timing...");

	const TRAX = new TRAXClass(AU_SEQ_NETWORK, { disableTimers: false });
	logger.setLevel(LogLevel.TIMING);

	let start = Date.now();
	await TRAX.loadGTFS(false, false);
	let end = Date.now();

	const totalTime = (end - start) / 1000;
	console.log(`\n\nTotal time: ${totalTime.toFixed(2)}s`);

	TRAX.logTimings("SEQ Performance Analysis", false);
}

main().catch(console.error);
