import TRAXClass, { logger, LogLevel, PRESETS } from "./dist/index.js";
import { config } from "dotenv";
import { existsSync } from "node:fs";

if (existsSync(".env")) {
	config();
}

async function main() {
	console.log("Loading gtfs data...");

	const TRAX = new TRAXClass(PRESETS.GTHA(process.env.METROLINX_KEY));
	logger.setLevel(LogLevel.DEBUG);

	let start_static = Date.now();
	await TRAX.loadGTFS(false);
	let end_static = Date.now();

	console.log("GTFS data loaded successfully.\n");

	let start_realtime = Date.now();
	await TRAX.updateRealtime();
	let end_realtime = Date.now();

	const stop = TRAX.getAugmentedStops("UN")[0];
	const tomorrow = new Date();
	tomorrow.setDate(tomorrow.getDate() + 1);
	const date =
		tomorrow.getFullYear().toString() +
		(tomorrow.getMonth() + 1).toString().padStart(2, "0") +
		tomorrow.getDate().toString().padStart(2, "0");
	const deps = TRAX.utils.departures.getDeparturesForStop(stop, date, "08:00:00", "23:59:59");

	console.log(deps.length + " testdeps");

	console.log(`GTFS loading took ${(end_static - start_static) / 1000} seconds.`);
	console.log(`Realtime updates took ${(end_realtime - start_realtime) / 1000} seconds.`);
	console.log("Done!");
	process.exit(0);
}

main();
