import TRAX from ".";
import * as readline from "readline";

async function main() {
	console.log("Loading GTFS data...");
	await TRAX.loadGTFS();
	console.log("GTFS data loaded successfully.\n");

	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	});

	const askQuestion = (query: string): Promise<string> => {
		return new Promise((resolve) => rl.question(query, resolve));
	};

	while (true) {
		try {
			const tripId = await askQuestion("Enter a trip ID (or 'quit' to exit): ");

			if (tripId.toLowerCase() === "quit") {
				console.log("Goodbye!");
				rl.close();
				return;
			}

			if (!tripId) {
				console.log("Please enter a valid trip ID.\n");
				continue;
			}

			const trips = TRAX.getAugmentedTrips(tripId);
			if (!trips || trips.length === 0) {
				console.log(`No trip found with ID: ${tripId}\n`);
				continue;
			}

			const trip = trips[0];
			console.log(
				TRAX.getRunSeries(
					Number.parseInt(Object.keys(trip.runSeries)[0]),
					trip.runSeries[Object.keys(trip.runSeries)[0]],
				),
			);
			continue;
			console.log(`\nTrip ID: ${trip._trip.trip_id}`);
			console.log(`Route: ${trip._trip.route_id}`);
			console.log(`Headsign: ${trip._trip.trip_headsign}`);

			// Calculate run series for this trip if not already calculated
			console.log("\nChecking/Calculating RunSeries data...");

			// Display run series information
			console.log("\n=== RunSeries Information ===");
			for (const [serviceDate, runSeries] of Object.entries(trip.runSeries)) {
				console.log(`\nService Date: ${serviceDate}`);
				console.log(`Run Series ID: ${runSeries || "Not calculated"}`);

				if (runSeries) {
					const rsData = TRAX.getRunSeries(Number(serviceDate), runSeries);
					if (rsData && rsData.trips.length > 0) {
						console.log("Trips in this RunSeries:");
						rsData.trips
							.sort((a, b) => a.trip_start_time - b.trip_start_time)
							.forEach((t, index) => {
								const time = TRAX.formatTimestamp(t.trip_start_time);
								console.log(`  ${index + 1}. ${time} - ${t.trip_id} (Run: ${t.run})`);
							});
					}
				}
			}
		} catch (error) {
			console.error("An error occurred:", error);
			console.log("\n" + "=".repeat(50) + "\n");
		}
	}
}

main().catch(console.error);
