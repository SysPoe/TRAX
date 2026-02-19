import TRAXClass, { logger, LogLevel } from "../dist/index.js";

async function main() {
	console.log("Loading gtfs data...");

	const TRAX = new TRAXClass();
	logger.setLevel(LogLevel.DEBUG);

	let start_static = Date.now();
	const doRealtime = false;
	await TRAX.loadGTFS(doRealtime, false);
	let end_static = Date.now();

	console.log("GTFS data loaded successfully.\n");

	// let start_realtime = Date.now();
	// await TRAX.updateRealtime();
	// let end_realtime = Date.now();

	const stop = TRAX.getAugmentedStops("place_censta")[0];
	const date = TRAX.utils.time.addDaysToServiceDate(TRAX.today(), 1);
	console.log(TRAX.getAvailableServiceDates().slice(0, 50));
	if (!TRAX.getAvailableServiceDates().includes(date)) console.log("Date not found!! " + date);
	const deps = TRAX.utils.departures.getDeparturesForStop(stop, date, "08:00:00", "23:59:59");

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
	const vps = TRAX.getVehiclePositions().filter((v) => v.trip.trip_id?.includes("QR "));
	if (vps.length > 0) {
		const inst = TRAX.getVehicleTripInstance(vps[0]);
		console.log(
			`Vehicle ${vps[0].vehicle.id} (Trip: ${vps[0].trip.trip_id}) matched trip instance: ${inst?.instance_id}`,
		);
	} else {
		console.log('No rail vehicle positions ("QR ") to test getVehicleTripInstance.');
	}

	// Test getShapes
	const shapes = TRAX.getShapes();
	console.log(`Loaded ${shapes.length} unique shapes from considered trips.`);
	if (shapes.length > 0) {
		console.log("Example shape:", shapes[0]);
	}

	console.log(`GTFS loading took ${(end_static - start_static) / 1000} seconds.`);
	if (typeof start_realtime !== "undefined" && typeof end_realtime !== "undefined")
		console.log(`Realtime updates took ${(end_realtime - start_realtime) / 1000} seconds.`);
	console.log("Done!");
	process.exit(0);
}

main().catch(console.error);
