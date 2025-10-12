import TRAX, { AugmentedTrip, RunSeries } from "./index.js";
import * as readline from "readline";

async function main() {
	console.log("Loading GTFS data...");
	await TRAX.loadGTFS(false);
	console.log("GTFS data loaded successfully.\n");

	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	});

	const askQuestion = (query: string): Promise<string> => {
		return new Promise((resolve) => rl.question(query, resolve));
	};

	// await askQuestion("Press Enter to continue...");

	while (true) {
		try {
			// const tripId = await askQuestion("Enter a trip ID (or 'quit' to exit): ");
			const tripId = `34329547-QR 25_26-40551-TL17`;

			// if (tripId.toLowerCase() === "quit") {
			// 	console.log("Goodbye!");
			// 	rl.close();
			// 	return;
			// }

			// if (!tripId) {
			// 	console.log("Please enter a valid trip ID.\n");
			// 	continue;
			// }

			const trips: AugmentedTrip[] = TRAX.getAugmentedTrips(tripId);
			if (!trips || trips.length === 0) {
				console.log(`No trip found with ID: ${tripId}\n`);
				return;
			}

			const trip: AugmentedTrip = trips[0];
			const firstKey = Object.keys(trip.runSeries)[0];
			const serviceDate = Number.parseInt(firstKey);
			console.log(TRAX.getRunSeries(serviceDate, trip.runSeries[serviceDate]));
			return;
			console.log(`\nTrip ID: ${trip._trip.trip_id}`);
			console.log(`Route: ${trip._trip.route_id}`);
			console.log(`Headsign: ${trip._trip.trip_headsign}`);

			// Calculate run series for this trip if not already calculated
			console.log("\nChecking/Calculating RunSeries data...");

			// Display run series information
			console.log("\n=== RunSeries Information ===");
			for (const [serviceDateStr, runSeries] of Object.entries(trip.runSeries)) {
				const serviceDate = Number(serviceDateStr);
				console.log(`\nService Date: ${serviceDate}`);
				console.log(`Run Series ID: ${runSeries || "Not calculated"}`);

				if (runSeries) {
					const rsData: RunSeries = TRAX.getRunSeries(serviceDate, runSeries);
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
