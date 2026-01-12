import TRAXClass, { logger, LogLevel, PRESETS } from "./dist/index.js";
import { config } from "dotenv";
import { existsSync } from "node:fs";

if (existsSync(".env")) {
	config();
}

async function main() {
	console.log("Loading gtfs data...");

	const TRAX = new TRAXClass(PRESETS.GTHA(process.env.METROLINX_KEY));
	logger.setLevel(LogLevel.TIMING);

	let start_static = Date.now();
	await TRAX.loadGTFS(false);
	let end_static = Date.now();

	console.log(`\nGTFS data loaded successfully in ${(end_static - start_static) / 1000}s.\n`);

	const stop = TRAX.getAugmentedStops("UN")[0];
	if (!stop) {
		console.error("Could not find stop UN");
		process.exit(1);
	}

	const tomorrow = new Date();
	tomorrow.setDate(tomorrow.getDate() + 1);
	const date =
		tomorrow.getFullYear().toString() +
		(tomorrow.getMonth() + 1).toString().padStart(2, "0") +
		tomorrow.getDate().toString().padStart(2, "0");

	console.log(`Getting departures for ${stop.stop_name} on ${date}...`);

	let depstart = Date.now();
	const deps = TRAX.utils.departures.getDeparturesForStop(stop, date, "08:00:00", "23:59:59");
	let depend = Date.now();

	console.log(`\nFound ${deps.length} departures.`);
	console.log(`Departure lookup took ${depend - depstart}ms.`);

	TRAX.logTimings("Departure lookup");

	console.log("Fetching considered stations...");
	let considerstart = Date.now();
	const considered = TRAX.getStations();
	let considerend = Date.now();

	console.log(`\nFound ${considered.length} considered stations.`);
	console.log(`Considered stations lookup took ${considerend - considerstart}ms.`);

	TRAX.logTimings("Get considered stations");

	console.log("\nDone!");
	process.exit(0);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
