import TRAXClass from "./dist/index.js";

async function main() {
	console.log("Loading gtfs data...");

	const TRAX = new TRAXClass();

	let start_static = Date.now();
	await TRAX.loadGTFS(false);
	let end_static = Date.now();

	console.log("GTFS data loaded successfully.\n");

	let start_realtime = Date.now();
	await TRAX.updateRealtime();
	let end_realtime = Date.now();

	const stop = TRAX.getAugmentedStops("place_censta")[0];
	const date = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10).replaceAll("-", "");
	const deps = TRAX.utils.departures.getDeparturesForStop(
		stop,
		date,
		"08:00:00",
		"23:59:59",
	);

	console.log(deps.length + " testdeps");

	// Check service_capacity
	if (deps.length > 0) {
		const firstDep = deps[0];
		console.log("First departure service_capacity:", firstDep.service_capacity);
		console.log(
			"First stopTime service_capacity:",
			TRAX.getAugmentedTripInstance(firstDep.instance_id).stopTimes[1].service_capacity,
		);
	}

	// Test getVehicleTripInstance
	const vps = TRAX.getVehiclePositions().filter(v => v.trip.trip_id?.includes("QR "));
	if (vps.length > 0) {
		const inst = TRAX.getVehicleTripInstance(vps[0]);
		console.log(`Vehicle ${vps[0].vehicle.id} (Trip: ${vps[0].trip.trip_id}) matched trip instance: ${inst?.instance_id}`);
	} else {
		console.log('No rail vehicle positions ("QR ") to test getVehicleTripInstance.');
	}

	console.log(`GTFS loading took ${(end_static - start_static) / 1000} seconds.`);
	console.log(`Realtime updates took ${(end_realtime - start_realtime) / 1000} seconds.`);
	console.log("Done!");
	process.exit(0);
}

main().catch(console.error);
