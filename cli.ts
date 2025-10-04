import inquirer from "inquirer";
import chalk from "chalk";
import { getCurrentQRTravelTrains } from "./qr-travel/qr-travel-tracker.js";
import TRAX, { AugmentedStopTime, LogLevel, TravelTrip } from "./index.js";
import * as gtfs from "gtfs";

async function qrTravelFlow() {
	TRAX.logger.setLevel(LogLevel.WARN);
	console.log(chalk.bold.magenta("🚄 QR Travel Interactive CLI"));
	console.log(chalk.gray("Queensland Rail real-time tracking\n"));

	// Step 1: Select Service
	console.log(chalk.yellow("📡 Fetching services..."));
	const services = await getCurrentQRTravelTrains();
	const serviceChoice = services.map((train) => ({
		name: chalk.cyan(train.serviceId + " - " + train.direction + " " + train.line),
		value: train,
	}));

	const { selectedService }: { selectedService: TravelTrip } = await inquirer.prompt([
		{
			type: "list",
			name: "selectedService",
			message: chalk.bold("🛤 Select a service:"),
			choices: serviceChoice,
		},
	]);

	for (const stop of selectedService.stopsWithPassing ?? []) {
		// Determine status
		const isPassing =
			stop.estimatedPassingTime !== undefined &&
			stop.estimatedPassingTime !== "0001-01-01T00:00:00Z" &&
			(stop.actualArrival ?? stop.actualDeparture) === undefined;

		// Time info
		const arr = stop.actualArrival || stop.plannedArrival || "";
		const dep = stop.actualDeparture || stop.plannedDeparture || "";
		const pass = stop.estimatedPassingTime || "";
		let timeStr = "";
		if (isPassing) {
			timeStr = chalk.gray(pass ? `Pass: ${pass}` : "");
		} else {
			if (arr && dep && arr !== dep) {
				timeStr = `${chalk.green("Arr:")} ${chalk.white(arr)}  ${chalk.yellow("Dep:")} ${chalk.white(dep)}`;
			} else if (arr) {
				timeStr = `${chalk.green("Arr:")} ${chalk.white(arr)}`;
			} else if (dep) {
				timeStr = `${chalk.yellow("Dep:")} ${chalk.white(dep)}`;
			} else {
				timeStr = chalk.gray("No time info");
			}
		}

		// Status
		let status = "";
		if (isPassing) {
			status = chalk.gray("(Passing)");
		} else if (stop.actualArrival || stop.actualDeparture) {
			status = chalk.green("(Actual)");
		} else {
			status = chalk.gray("(Scheduled)");
		}

		// Delay info (use delay class/string)
		let delayStr = "";
		if (!isPassing) {
			let delayClass = stop.departureDelayClass || stop.arrivalDelayClass;
			let delayString = stop.departureDelayString || stop.arrivalDelayString;
			if (delayClass && delayString) {
				switch (delayClass) {
					case "on-time":
						delayStr = chalk.green(delayString);
						break;
					case "scheduled":
						delayStr = chalk.gray(delayString);
						break;
					case "late":
						delayStr = chalk.yellow(delayString);
						break;
					case "very-late":
						delayStr = chalk.red(delayString);
						break;
					case "early":
						delayStr = chalk.cyan(delayString);
						break;
					default:
						delayStr = chalk.gray(delayString);
				}
			}
		}

		// Build fancy line
		const line = ["    ", timeStr, status, delayStr].filter(Boolean).join("  ");
		console.log(chalk.bold.cyan(stop.placeName), chalk.gray(selectedService.stops.find(v => v.placeName.trim().toLowerCase() == stop.placeName.trim().toLowerCase())?.placeCode ?? ""));
		console.log(line);
	}
}

async function gtfsFlow() {
	console.log(chalk.bold.green("🚊 GTFS Interactive CLI"));

	// Load GTFS data
	console.log(chalk.yellow("📊 Loading GTFS data..."));
	TRAX.config.verbose = false;
	await TRAX.loadGTFS(false, false);
	console.log(chalk.green("✅ GTFS data loaded successfully"));

	const { action } = await inquirer.prompt([
		{
			type: "list",
			name: "action",
			message: chalk.bold("What would you like to do?"),
			choices: [
				{
					name: chalk.green("🚏 View departures from a station"),
					value: "departures",
				},
				{
					name: chalk.blue("🚆 View trip details"),
					value: "trip",
				},
				{
					name: chalk.yellow("📍 View all stations"),
					value: "stations",
				},
			],
		},
	]);

	if (action === "departures") {
		await viewDepartures();
	} else if (action === "trip") {
		await viewTrip();
	} else if (action === "stations") {
		await viewStations();
	}
}

async function viewDepartures(stationId?: string, timeOffset: number = 0) {
	let selectedStation = stationId;
	let showPassing = false;

	if (!selectedStation) {
		const stations = TRAX.getStations().sort((a, b) => (a.stop_name || "").localeCompare(b.stop_name || ""));
		const stationChoices = stations.map((station) => {
			return {
				name: station.stop_name || station.stop_id,
				value: station.stop_id,
			};
		});

		const result = await inquirer.prompt([
			{
				type: "list",
				name: "selectedStation",
				message: "Select a station:",
				choices: stationChoices,
			},
		]);
		selectedStation = result.selectedStation;
	}

	while (true) {
		const stops = TRAX.getAugmentedStops(selectedStation);
		const stop = stops.length > 0 ? stops[0] : null;

		if (!stop) {
			console.log(chalk.red("No stop found for that station."));
			return;
		}

		// Calculate time window based on offset (in hours)
		const baseTime = new Date();

		const startTime = `${(baseTime.getHours() + timeOffset).toString().padStart(2, "0")}:${baseTime
			.getMinutes()
			.toString()
			.padStart(2, "0")}:00`;

		const laterTime = `${(baseTime.getHours() + timeOffset + 4).toString().padStart(2, "0")}:${baseTime
			.getMinutes()
			.toString()
			.padStart(2, "0")}:00`;

		// Handle day changes
		let targetDate = new Date(Date.now() + 3600 * 10 * 1000); // Add +10 hours so the UTC time is in the current timezone
		targetDate.setHours(targetDate.getHours() + timeOffset);
		const today = TRAX.today();

		let departures = stop.getDepartures(today, startTime, laterTime);
		if (!showPassing) {
			departures = departures.filter((dep: any) => !dep.passing);
		}

		// Helper function to format departure with colors
		function formatDeparture(
			dep: AugmentedStopTime & {
				express_string: string;
			},
		): string {
			const time = TRAX.formatTimestamp(dep.actual_departure_timestamp);
			const tripId = dep.trip_id.slice(-4);
			// Color-coded delay status
			let rtString = "";
			let timeColor = chalk.white;
			if (dep.realtime_info) {
				const delayClass = dep.realtime_info.delay_class;
				const delayStr = dep.realtime_info.delay_string;
				switch (delayClass) {
					case "on-time":
						rtString = chalk.green(` ${delayStr}`);
						timeColor = chalk.green;
						break;
					case "scheduled":
						rtString = chalk.blue(` ${delayStr}`);
						timeColor = chalk.blue;
						break;
					case "late":
						rtString = chalk.yellow(` ${delayStr}`);
						timeColor = chalk.yellow;
						break;
					case "very-late":
						rtString = chalk.red(` ${delayStr}`);
						timeColor = chalk.red;
						break;
					case "early":
						rtString = chalk.cyan(` ${delayStr}`);
						timeColor = chalk.cyan;
						break;
					default:
						rtString = chalk.gray(` ${delayStr}`);
				}
			} else {
				rtString = chalk.gray(" (scheduled)");
				timeColor = chalk.gray;
			}
			const platform = dep.actual_platform_code
				? chalk.magenta("p" + dep.actual_platform_code.padEnd(2, " "))
				: dep.scheduled_platform_code
					? chalk.dim("p" + dep.scheduled_platform_code.padEnd(2, " "))
					: chalk.gray("   ");
			const realtimeIndicator = dep.realtime ? chalk.green("RT") : chalk.gray("  ");
			const headsign = TRAX.getAugmentedTrips(dep.trip_id)[0]?._trip.trip_headsign || "Unknown";
			const route =
				gtfs.getRoutes({
					route_id: TRAX.getAugmentedTrips(dep.trip_id)[0]?._trip.route_id,
				})[0].route_short_name || "";

			let pickup = "";
			switch (dep._stopTime?.pickup_type) {
				case 1:
					pickup = chalk.red(" (no pick-up)");
					break;

				case 2:
				case 3:
					pickup = chalk.red(" (arrange pick-up)");
					break;

				case 0:
				default:
					break;
			}

			let dropoff = "";
			switch (dep._stopTime?.drop_off_type) {
				case 1:
					dropoff = chalk.red(" (no drop-off)");
					break;

				case 2:
				case 3:
					dropoff = chalk.red(" (arrange drop-off)");
					break;

				case 0:
				default:
					break;
			}

			let displayName = `${timeColor(time)} ${platform} ${realtimeIndicator} ${chalk.cyan(route)} ${chalk.bold(
				tripId,
			)} ${chalk.white(headsign)}${rtString}${pickup}${dropoff}`;
			if (dep.passing) {
				displayName = chalk.gray(
					`${time} ${platform} ${realtimeIndicator} ${route} ${tripId} ${headsign} [PASSING]${pickup}${dropoff}`,
				);
			}
			return displayName;
		}

		if (departures.length === 0) {
			console.log(chalk.yellow("No departures found for this time period."));

			// Still show navigation options even when no departures
			const { action } = await inquirer.prompt([
				{
					type: "list",
					name: "action",
					message: `No departures found from ${startTime} to ${laterTime}`,
					choices: [
						{
							name: "⬆ Earlier departures (previous 4 hours)",
							value: "earlier",
						},
						{
							name: "⬇ Later departures (next 4 hours)",
							value: "later",
						},
						{ name: "🔄 Current time", value: "reset" },
						{
							name: showPassing ? "🙈 Hide passing departures" : "👁 Show passing departures",
							value: "togglePassing",
						},
						{ name: "← Back to station selection", value: "back" },
					],
				},
			]);

			if (action === "earlier") {
				timeOffset -= 4;
				continue;
			} else if (action === "later") {
				timeOffset += 4;
				continue;
			} else if (action === "reset") {
				timeOffset = 0;
				continue;
			} else if (action === "togglePassing") {
				showPassing = !showPassing;
				continue;
			} else if (action === "back") {
				await viewDepartures();
				return;
			}
			return;
		}

		// Create choices for departures
		const departureChoices = departures.map((dep) => {
			return {
				name: formatDeparture(dep),
				value: dep,
			};
		});

		// Time period indicator
		const timeIndicator =
			timeOffset === 0
				? chalk.green("📍 Current Time")
				: timeOffset > 0
					? chalk.blue(`⏭ +${timeOffset}h from now`)
					: chalk.yellow(`⏪ ${timeOffset}h from now`);

		const { selectedDeparture } = await inquirer.prompt([
			{
				type: "list",
				name: "selectedDeparture",
				message: `${chalk.bold(stop.stop_name)} • ${timeIndicator} • ${startTime} to ${laterTime} ${
					showPassing ? chalk.gray("[showing passing]") : ""
				}`,
				choices: [
					{
						name: "⬆ Earlier departures (previous 4 hours)",
						value: "earlier",
					},
					{
						name: "⬇ Later departures (next 4 hours)",
						value: "later",
					},
					{ name: "🔄 Current time", value: "reset" },
					{
						name: showPassing ? "🙈 Hide passing departures" : "👁 Show passing departures",
						value: "togglePassing",
					},
					new inquirer.Separator(),
					...departureChoices,
					new inquirer.Separator(),
					{ name: "← Back to station selection", value: "back" },
				],
				pageSize: 20,
			},
		]);

		if (selectedDeparture === "back") {
			await viewDepartures();
			return;
		} else if (selectedDeparture === "earlier") {
			timeOffset -= 4;
			continue;
		} else if (selectedDeparture === "later") {
			timeOffset += 4;
			continue;
		} else if (selectedDeparture === "reset") {
			timeOffset = 0;
			continue;
		} else if (selectedDeparture === "togglePassing") {
			showPassing = !showPassing;
			continue;
		}

		// View the selected trip
		await viewTripFromDeparture(selectedDeparture);
		// After viewing, return to departures
		continue;
	}
}

async function viewTripFromDeparture(departure: any) {
	const trips = TRAX.getAugmentedTrips(departure.trip_id);
	if (trips.length === 0) {
		console.log(chalk.red("No trip found with that ID."));
		return;
	}

	const trip = trips[0];
	let showPassing = false;

	while (true) {
		// Display enhanced trip header
		console.log(chalk.bold.cyan(`\n🚆 Trip: ${trip._trip.trip_id}`));
		console.log(
			chalk.white(
				`📍 Route: ${chalk.yellow(gtfs.getRoutes({ route_id: trip._trip.route_id })[0].route_short_name)}`,
			),
		);
		console.log(chalk.white(`🎯 Headsign: ${chalk.green(trip._trip.trip_headsign)}`));
		console.log(chalk.white(`📅 Service Dates: ${chalk.blue(trip.scheduledStartServiceDates.join(", "))}`));

		// Trip statistics
		const totalStops = trip.stopTimes.length;
		const passingStops = trip.stopTimes.filter((st) => st.passing).length;
		const realtimeStops = trip.stopTimes.filter((st) => st.realtime_info).length;
		console.log(
			chalk.gray(`📊 ${totalStops} stops (${passingStops} passing) • ${realtimeStops} with realtime data`),
		);

		// Create choices for each stop with enhanced formatting
		let stopTimes = trip.stopTimes;
		if (!showPassing) {
			stopTimes = stopTimes.filter((st) => !st.passing);
		}
		const stopChoices = stopTimes.map((st, index) => {
			const name =
				st.actual_stop?.stop_name ||
				st.scheduled_stop?.stop_name ||
				st.actual_stop?.stop_id ||
				st.scheduled_stop?.stop_id;
			// Format times with colors
			const arrTime = TRAX.formatTimestamp(st.actual_arrival_timestamp || st.scheduled_arrival_timestamp);
			const depTime = TRAX.formatTimestamp(st.actual_departure_timestamp || st.scheduled_departure_timestamp);
			// Platform information
			const platform = st.actual_platform_code
				? chalk.magenta(`p${st.actual_platform_code}`)
				: st.scheduled_platform_code
					? chalk.dim(`p${st.scheduled_platform_code}`)
					: "";
			// Status and delay information
			let statusColor = chalk.white;
			let rtInfo = "";
			if (st.realtime_info) {
				const delayClass = st.realtime_info.delay_class;
				const delayStr = st.realtime_info.delay_string;
				const prop = st.realtime_info.propagated ? " PROP" : "";
				switch (delayClass) {
					case "on-time":
						statusColor = chalk.green;
						rtInfo = chalk.green(` ${delayStr}${prop}`);
						break;
					case "scheduled":
						statusColor = chalk.blue;
						rtInfo = chalk.blue(` ${delayStr}${prop}`);
						break;
					case "late":
						statusColor = chalk.yellow;
						rtInfo = chalk.yellow(` ${delayStr}${prop}`);
						break;
					case "very-late":
						statusColor = chalk.red;
						rtInfo = chalk.red(` ${delayStr}${prop}`);
						break;
					case "early":
						statusColor = chalk.cyan;
						rtInfo = chalk.cyan(` ${delayStr}${prop}`);
						break;
					default:
						rtInfo = chalk.gray(` ${delayStr}${prop}`);
				}
			}
			// Stop type indicators
			const firstStop = index === 0 ? chalk.green(" [ORIGIN]") : "";
			const lastStop = index === stopTimes.length - 1 ? chalk.red(" [TERMINUS]") : "";
			// Time display - show both arrival and departure if different
			let timeDisplay;
			if (arrTime === depTime) {
				timeDisplay = statusColor(arrTime);
			} else {
				timeDisplay = `${statusColor(arrTime)}→${statusColor(depTime)}`;
			}
			const stopNumber = chalk.dim(`${(index + 1).toString().padStart(2, "0")}.`);
			let displayName = `${stopNumber} ${timeDisplay} ${platform} ${chalk.bold(
				name,
			)}${rtInfo}${firstStop}${lastStop} ${st.actual_exit_side}`;
			if (st.passing) {
				displayName = chalk.gray(
					`${stopNumber} ${
						arrTime === depTime ? arrTime : arrTime + "→" + depTime
					} ${platform} ${name} [PASSING]${firstStop}${lastStop}`,
				);
			}
			return {
				name: displayName,
				value: { stopTime: st, index },
			};
		});

		const { selectedStop } = await inquirer.prompt([
			{
				type: "list",
				name: "selectedStop",
				message: chalk.bold(
					`🚏 Stop Times (select a station to view its departures): ${
						showPassing ? chalk.gray("[showing passing]") : ""
					}`,
				),
				choices: [
					{
						name: showPassing ? "🙈 Hide passing stops" : "👁 Show passing stops",
						value: "togglePassing",
					},
					new inquirer.Separator(),
					...stopChoices,
					new inquirer.Separator(),
					{ name: chalk.gray("← Back to departures"), value: "back" },
				],
				pageSize: 25,
			},
		]);

		if (selectedStop === "back") {
			return;
		} else if (selectedStop === "togglePassing") {
			showPassing = !showPassing;
			continue;
		}

		// Get the station ID and view departures from that station
		const stationId =
			selectedStop.stopTime.actual_stop?.parent_station ||
			selectedStop.stopTime.actual_stop?.stop_id ||
			selectedStop.stopTime.scheduled_stop?.parent_station ||
			selectedStop.stopTime.scheduled_stop?.stop_id;

		if (stationId) {
			await viewDepartures(stationId);
		}
		// After viewing, return to trip viewer
		continue;
	}
}

async function viewTrip() {
	const { tripId } = await inquirer.prompt([
		{
			type: "input",
			name: "tripId",
			message: "Enter trip ID (e.g., 33552736-QR 25_26-39955-T401):",
		},
	]);

	const trips = TRAX.getAugmentedTrips(tripId);
	if (trips.length === 0) {
		console.log(chalk.red("No trip found with that ID."));
		return;
	}

	const trip = trips[0];
	console.log(chalk.bold(`\nTrip: ${trip._trip.trip_id}`));
	console.log(`Route: ${gtfs.getRoutes({ route_id: trip._trip.route_id })[0].route_short_name}`);
	console.log(`Headsign: ${trip._trip.trip_headsign}`);
	console.log(`Service Dates: ${trip.scheduledStartServiceDates.join(", ")}`);
	console.log("Stop Times:");

	for (const st of trip.stopTimes) {
		const name =
			st.actual_stop?.stop_name ||
			st.scheduled_stop?.stop_name ||
			st.actual_stop?.stop_id ||
			st.scheduled_stop?.stop_id;
		const actDep = TRAX.formatTimestamp(
			st.actual_departure_timestamp ||
				st.actual_arrival_timestamp ||
				st.scheduled_departure_timestamp ||
				st.scheduled_arrival_timestamp,
		);
		const rtInfo = st.realtime_info
			? st.realtime_info.propagated
				? st.realtime_info.delay_string + " PROP"
				: st.realtime_info.delay_string
			: "";

		console.log(
			`  ${name}: ${actDep} ${st.passing ? chalk.magenta("(Passing)") : ""} ${
				rtInfo ? chalk.yellow(rtInfo) : ""
			}`,
		);
	}
}

async function viewStations() {
	const stations = TRAX.getStations();
	console.log(chalk.bold(`\nAll Stations (${stations.length}):`));

	for (const station of stations) {
		console.log(`  ${chalk.blue(station.stop_id)}: ${station.stop_name || "Unknown"}`);
	}
}

async function main(introduce: boolean = true) {
	if (introduce) {
		console.log(chalk.bold.cyan("🚆 TRAX Transit CLI"));
		console.log(chalk.gray("Interactive transit data explorer\n"));
	} else console.log("\n\n");

	const { mode } = await inquirer.prompt([
		{
			type: "list",
			name: "mode",
			message: chalk.bold("Select a data source:"),
			choices: [
				{
					name: chalk.green("🚊 GTFS (SEQ)"),
					value: "gtfs",
				},
				{
					name: chalk.magenta("🚄 QR Travel (Regional Services)"),
					value: "qr-travel",
				},
			],
		},
	]);

	if (mode === "gtfs") {
		await gtfsFlow();
	} else if (mode === "qr-travel") {
		await qrTravelFlow();
	}
}

main();
