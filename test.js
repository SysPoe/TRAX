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

	const deps = TRAX.getAugmentedStops("place_censta")[0].getDepartures(
		new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10).replaceAll("-", ""),
		"08:00:00",
		"23:59:59",
	);

	console.log(deps.length + " testdeps");

	// Check service_capacity
	if (deps.length > 0) {
		const firstDep = deps[0];
		console.log("First departure service_capacity:", firstDep.service_capacity);
		console.log("First stopTime service_capacity:", TRAX.getAugmentedTripInstance(firstDep.instance_id).stopTimes[1].service_capacity);
	}

	TRAX.logger.info(`GTFS loading took ${(end_static - start_static) / 1000} seconds.`);
	TRAX.logger.info(`Realtime updates took ${(end_realtime - start_realtime) / 1000} seconds.`);
	TRAX.logger.info("Done!");
	process.exit(0);
}

main().catch(console.error);
