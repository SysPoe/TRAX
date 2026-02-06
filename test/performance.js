import TRAXClass, { logger, LogLevel } from "../dist/index.js";

async function main() {
	console.log("Loading gtfs data with timers disabled...");

	const TRAX = new TRAXClass({ disableTimers: true });
	logger.setLevel(LogLevel.INFO);

	let start_static = Date.now();
	await TRAX.loadGTFS(false, false);
	let end_static = Date.now();

	const staticTime = (end_static - start_static) / 1000;
	console.log(`\nGTFS static data loaded in ${staticTime.toFixed(2)}s (with disableTimers: true)`);

	console.log("\nNow testing with timers enabled (default)...");
	const TRAX2 = new TRAXClass({ disableTimers: false });

	let start_static2 = Date.now();
	await TRAX2.loadGTFS(false, false);
	let end_static2 = Date.now();

	const staticTime2 = (end_static2 - start_static2) / 1000;
	console.log(`\nGTFS static data loaded in ${staticTime2.toFixed(2)}s (with disableTimers: false)`);

	const improvement = (((staticTime2 - staticTime) / staticTime2) * 100).toFixed(1);
	console.log(`\nImprovement: ${improvement}% faster with timers disabled`);
}

main().catch(console.error);
