import TRAXClass, { logger, LogLevel } from "../dist/index.js";

async function main() {
	console.log("Loading gtfs data...");

	const TRAX = new TRAXClass();
	logger.setLevel(LogLevel.DEBUG);

	let start_static = Date.now();
	const doRealtime = false;
	if(!doRealtime) console.warn("[WARNING] Realtime updates are disabled for this test. Set doRealtime to true to include them.");
	await TRAX.loadGTFS(doRealtime, false);
	let end_static = Date.now();

	console.log("GTFS data loaded successfully.\n");

	// let start_realtime = Date.now();
	// await TRAX.updateRealtime();
	// let end_realtime = Date.now();

	const stop = TRAX.getAugmentedStops("place_romsta")[0];
	const date = TRAX.utils.time.addDaysToServiceDate(TRAX.today(), 1);
	console.log(TRAX.getAvailableServiceDates().slice(0, 50));
	const gtfs = TRAX.utils.getGtfs();
	console.log("Feed info:", gtfs.getFeedInfo());
	console.log("Calendars sample:", gtfs.getCalendars().slice(0, 5));
	const clampedDate = clampDateToFeedRange(date, gtfs);
	console.log("Requested date:", date, "Clamped date:", clampedDate);
	if (!TRAX.getAvailableServiceDates().includes(clampedDate)) console.log("Date not found!! " + clampedDate);
	const deps = TRAX.utils.departures.getDeparturesForStop(stop, clampedDate, "08:00:00", "23:59:59");

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

function clampDateToFeedRange(requestedDate, gtfs) {
	const feedInfo = gtfs.getFeedInfo();
	let feedStartDate = null;
	let feedEndDate = null;
	for (const info of feedInfo) {
		if (!feedStartDate && info.feed_start_date) feedStartDate = info.feed_start_date;
		if (!feedEndDate && info.feed_end_date) feedEndDate = info.feed_end_date;
	}
	console.log("Feed start:", feedStartDate, "Feed end:", feedEndDate);

	const calendars = gtfs.getCalendars();
	if (calendars.length === 0) return requestedDate;

	let minDate = calendars[0].start_date;
	let maxDate = calendars[0].end_date;
	for (const cal of calendars) {
		if (cal.start_date < minDate) minDate = cal.start_date;
		if (cal.end_date > maxDate) maxDate = cal.end_date;
	}
	console.log("Calendar min:", minDate, "Calendar max:", maxDate);

	if (feedStartDate && requestedDate < feedStartDate) return feedStartDate;
	if (feedEndDate && requestedDate > feedEndDate) return feedEndDate;

	if (requestedDate < minDate) return minDate;
	if (requestedDate > maxDate) return maxDate;
	return requestedDate;
}

main().catch(console.error);
