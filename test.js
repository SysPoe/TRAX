import TRAX from "./dist/index.js";

async function main() {
	TRAX.logger.info("Loading gtfs data...");

	let start_static = Date.now();
	await TRAX.loadGTFS(false);
	let end_static = Date.now();

	TRAX.logger.info("GTFS data loaded successfully.\n");

	let start_realtime = Date.now();
	await TRAX.updateRealtime();
	let end_realtime = Date.now();

	TRAX.logger.info(`GTFS loading took ${(end_static - start_static) / 1000} seconds.`);
	TRAX.logger.info(`Realtime updates took ${(end_realtime - start_realtime) / 1000} seconds.`);
	TRAX.logger.info("Done!");
}

main().catch(console.error);
