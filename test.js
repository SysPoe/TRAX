import TRAX from "./dist/index.js";

async function main() {
	console.log("Loading GTFS data...");	

	let start_static = Date.now();
	await TRAX.loadGTFS(false);
	let end_static = Date.now();

	console.log("GTFS data loaded successfully.\n");

	let start_realtime = Date.now();
	await TRAX.updateRealtime();
	let end_realtime = Date.now();

	console.log(`GTFS loading took ${(end_static - start_static) / 1000} seconds.`);
	console.log(`Realtime updates took ${(end_realtime - start_realtime) / 1000} seconds.`);
	console.log("Done!");
}

main().catch(console.error);
