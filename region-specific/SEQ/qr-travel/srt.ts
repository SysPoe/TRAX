export type SRTEntry = { from: string; to: string; travelTrain: number };
export let SRT_DATA: SRTEntry[] = JSON.parse(loadDataFile("region-specific/SEQ/SRT_qrt.json"));

SRT_DATA = SRT_DATA.concat(
	SRT_DATA.map((v) => ({
		from: v.to,
		to: v.from,
		travelTrain: v.travelTrain,
	})),
);

import type { QRTTrainMovementDTO } from "./types.js";
import { loadDataFile } from "../../../utils/fs.js";
import { parseBrisbaneTime } from "../../../utils/time.js";

// Output type for each stop (stopping or passing)
export interface QRTSRTStop {
	placeName: string;
	placeCode: string;
	gtfsStopId: string | null;
	isStop: boolean; // true if train stops, false if passing
	plannedArrival: string;
	plannedDeparture: string;
	actualArrival?: string;
	actualDeparture?: string;
	srtMinutes?: number; // SRT minutes for this segment (if available)
	estimatedPassingTime?: string; // ISO string if available
	arrivalDelaySeconds?: number | null;
	arrivalDelayClass?: "on-time" | "scheduled" | "late" | "very-late" | "early";
	arrivalDelayString?: "on time" | string;
	departureDelaySeconds?: number | null;
	departureDelayClass?: "on-time" | "scheduled" | "late" | "very-late" | "early";
	departureDelayString?: "on time" | string;
}

function getDelay(delaySecs: number | null = null, departureTime: string | null) {
	if (delaySecs === null || departureTime === null) return { delayString: "scheduled", delayClass: "scheduled" };

	let departsInSecs = Math.round(parseBrisbaneTime(departureTime) - Date.now()) / 1000;
	departsInSecs = Math.round(departsInSecs / 60) * 60;
	const roundedDelay = delaySecs ? Math.round(delaySecs / 60) * 60 : null;
	const delayString =
		delaySecs != null && roundedDelay != null
			? delaySecs == 0
				? "on time"
				: `${Math.floor(roundedDelay / 3600)}h ${Math.floor(
					(Math.abs(roundedDelay) % 3600) / 60,
				)}m ${delaySecs > 0 ? "late" : "early"}`
					.replace(/^0h/, "")
					.trim()
			: "scheduled";
	const delayClass: "very-late" | "late" | "early" | "on-time" | "scheduled" =
		delaySecs != null && roundedDelay != null
			? roundedDelay > 0
				? roundedDelay > 5 * 60
					? "very-late"
					: "late"
				: roundedDelay < 0
					? "early"
					: "on-time"
			: "scheduled";
	return { delayString, delayClass };
}

function pushSRT(
	arr: QRTSRTStop[],
	stop: Exclude<QRTSRTStop, "departureDelayClass" | "departureDelayString" | "arrivalDelayClass" | "arrivalDelayString">,
) {
	let arrivalDelayInfo = getDelay(stop.arrivalDelaySeconds ?? null, stop.actualArrival ?? null);
	let departureDelayInfo = getDelay(stop.departureDelaySeconds ?? null, stop.actualDeparture ?? null);
	type delayClass = "on-time" | "scheduled" | "late" | "very-late" | "early";
	arr.push({
		...stop,
		arrivalDelayClass:
			stop.actualArrival === "0001-01-01T00:00:00" && stop.plannedArrival === "0001-01-01T00:00:00"
				? undefined
				: (arrivalDelayInfo.delayClass as delayClass),
		arrivalDelayString:
			stop.actualArrival === "0001-01-01T00:00:00" && stop.plannedArrival === "0001-01-01T00:00:00"
				? undefined
				: arrivalDelayInfo.delayString,
		departureDelayClass:
			stop.actualDeparture === "0001-01-01T00:00:00" && stop.plannedDeparture === "0001-01-01T00:00:00"
				? undefined
				: (departureDelayInfo.delayClass as delayClass),
		departureDelayString:
			stop.actualDeparture === "0001-01-01T00:00:00" && stop.plannedDeparture === "0001-01-01T00:00:00"
				? undefined
				: departureDelayInfo.delayString,
	});
}

export function expandWithSRTPassingStops(stoppingMovements: QRTTrainMovementDTO[]): QRTSRTStop[] {
	function calcDelay(actual?: string, planned?: string): number | null {
		if (!actual || !planned || actual === "0001-01-01T00:00:00" || planned === "0001-01-01T00:00:00") return null;
		const a = parseBrisbaneTime(actual, "Z");
		const p = parseBrisbaneTime(planned, "Z");
		if (isNaN(a) || isNaN(p)) return null;
		return Math.round((a - p) / 1000);
	}
	if (stoppingMovements.length < 2)
		return stoppingMovements.map((m) => ({
			placeCode: m.PlaceCode,
			gtfsStopId: m.gtfsStopId ?? null,
			placeName: m.PlaceName,
			isStop: true,
			plannedArrival: m.PlannedArrival,
			plannedDeparture: m.PlannedDeparture,
			actualArrival: m.ActualArrival,
			actualDeparture: m.ActualDeparture,
			arrivalDelaySeconds: calcDelay(m.ActualArrival, m.PlannedArrival),
			departureDelaySeconds: calcDelay(m.ActualDeparture, m.PlannedDeparture),
		}));

	const result: QRTSRTStop[] = [];
	let prevTime: number | null = null;
	for (let i = 0; i < stoppingMovements.length - 1; ++i) {
		const from = stoppingMovements[i];
		const to = stoppingMovements[i + 1];
		// Always add the 'from' stop
		if (i === 0) {
			pushSRT(result, {
				placeCode: from.PlaceCode,
				gtfsStopId: from.gtfsStopId ?? null,
				placeName: from.PlaceName,
				isStop: true,
				plannedArrival: from.PlannedArrival,
				plannedDeparture: from.PlannedDeparture,
				actualArrival: from.ActualArrival,
				actualDeparture: from.ActualDeparture,
				arrivalDelaySeconds: calcDelay(from.ActualArrival, from.PlannedArrival),
				departureDelaySeconds: calcDelay(from.ActualDeparture, from.PlannedDeparture),
			});
			// Set prevTime to actual/planned departure if available
			if (from.ActualDeparture && from.ActualDeparture !== "0001-01-01T00:00:00") {
				prevTime = parseBrisbaneTime(from.ActualDeparture, "Z");
			} else if (from.PlannedDeparture && from.PlannedDeparture !== "0001-01-01T00:00:00") {
				prevTime = parseBrisbaneTime(from.PlannedDeparture, "Z");
			} else {
				prevTime = null;
			}
		}
		// Find all SRT segments between from and to
		let seg = SRT_DATA.find(
			(s) =>
				(s.from === from.PlaceName && s.to === to.PlaceName) ||
				(s.from === to.PlaceName && s.to === from.PlaceName),
		);
		if (seg) {
			// Direct SRT segment, no passing stops
			// Estimate next stop's arrival time
			let estPass: number | undefined =
				prevTime && seg.travelTrain ? prevTime + seg.travelTrain * 60000 : undefined;
			let estPassDate = estPass ? new Date(estPass) : undefined;
			pushSRT(result, {
				placeCode: to.PlaceCode,
				gtfsStopId: to.gtfsStopId ?? null,
				placeName: to.PlaceName,
				isStop: true,
				plannedArrival: to.PlannedArrival,
				plannedDeparture: to.PlannedDeparture,
				actualArrival: to.ActualArrival,
				actualDeparture: to.ActualDeparture,
				srtMinutes: seg.travelTrain,
				estimatedPassingTime: estPassDate ? estPassDate.toISOString().slice(0, 19) : undefined,
				arrivalDelaySeconds: calcDelay(to.ActualArrival, to.PlannedArrival),
				departureDelaySeconds: calcDelay(to.ActualDeparture, to.PlannedDeparture),
			});
			prevTime = estPass ?? null;
			continue;
		}
		// Try to find a chain of SRT segments between from and to (i.e. passing stops)
		// BFS to find shortest SRT path
		let queue: { path: SRTEntry[]; last: string }[] = SRT_DATA.filter(
			(s) => s.from.trim().toLocaleLowerCase() === from.PlaceName.trim().toLowerCase(),
		).map((s) => ({ path: [s], last: s.to }));
		queue =
			queue.length == 0
				? SRT_DATA.filter((s) => s.to.trim().toLocaleLowerCase() === from.PlaceName.trim().toLowerCase()).map(
					(s) => ({ path: [s], last: s.from }),
				)
				: queue;
		let found: SRTEntry[] | null = null;
		let visited = new Set<string>();

		while (queue.length && !found) {
			let { path, last } = queue.shift()!;
			if (last === to.PlaceName) {
				found = path;
				break;
			}
			if (visited.has(last)) continue;
			visited.add(last);

			for (let next of SRT_DATA.filter(
				(s) =>
					s.from.trim().toLowerCase() === last.trim().toLowerCase() ||
					s.to.trim().toLowerCase() === last.trim().toLowerCase(),
			)) {
				// Determine the next stop based on which end matches 'last'
				const nextStop = next.from.trim().toLowerCase() === last.trim().toLowerCase() ? next.to : next.from;
				if (!visited.has(nextStop)) queue.push({ path: [...path, next], last: nextStop });
			}
		}
		if (found) {
			// Build a list of stops in order by traversing the path
			let stops: string[] = [from.PlaceName];
			let current = from.PlaceName;
			for (let seg of found) {
				// Determine which end of the segment we're going to
				if (seg.from.trim().toLowerCase() === current.trim().toLowerCase()) {
					current = seg.to;
				} else {
					current = seg.from;
				}
				stops.push(current);
			}

			// Calculate total SRT time for the entire segment
			let totalSRT = found.reduce((sum, seg) => sum + seg.travelTrain, 0);

			// Calculate actual time between from and to stations
			let fromTime = prevTime;
			let toTime: number | null = null;
			if (to.ActualArrival && to.ActualArrival !== "0001-01-01T00:00:00") {
				toTime = parseBrisbaneTime(to.ActualArrival, "Z");
			} else if (to.PlannedArrival && to.PlannedArrival !== "0001-01-01T00:00:00") {
				toTime = parseBrisbaneTime(to.PlannedArrival, "Z");
			}

			// Calculate scaling factor: actualTime / srtTime
			let scaleFactor = 1.0;
			if (fromTime && toTime && totalSRT > 0) {
				let actualMinutes = (toTime - fromTime) / 60000;
				scaleFactor = actualMinutes / totalSRT;
			}

			// Only add true passing stops (all stops except first and last)
			let cumulativeSRT = 0;
			for (let j = 1; j < stops.length - 1; ++j) {
				const stopName = stops[j];
				const foundSeg = found[j - 1]; // The segment that leads TO this stop
				if (foundSeg) {
					cumulativeSRT += foundSeg.travelTrain;
					const orig = stoppingMovements.find((m) => m.PlaceName === stopName);

					// Calculate scaled time based on actual travel time
					let estPass: number | undefined = undefined;
					if (fromTime) {
						let scaledMinutes = cumulativeSRT * scaleFactor;
						estPass = fromTime + scaledMinutes * 60000;
					}

					let estPassDate = estPass ? new Date(estPass) : undefined;
					let estPassStr = estPassDate ? estPassDate.toISOString().slice(0, 19) : undefined;

					pushSRT(result, {
					placeCode: orig?.PlaceCode ?? "",
					gtfsStopId: orig?.gtfsStopId ?? null,
					placeName: stopName,
					isStop: false,
					plannedArrival: orig?.PlannedArrival ?? "",
					plannedDeparture: orig?.PlannedDeparture ?? "",
						actualArrival: orig?.ActualArrival,
						actualDeparture: orig?.ActualDeparture,
						srtMinutes: foundSeg.travelTrain,
						estimatedPassingTime: estPassStr,
						arrivalDelaySeconds: calcDelay(
							orig?.ActualArrival ?? estPassStr,
							orig?.PlannedArrival ?? estPassStr,
						),
						departureDelaySeconds: calcDelay(
							orig?.ActualDeparture ?? estPassStr,
							orig?.PlannedDeparture ?? estPassStr,
						),
					});
					prevTime = estPass ?? null;
				}
			}
			// Add the final stop (not as a passing stop)
			// Use actual arrival time for the destination, don't estimate it
			pushSRT(result, {
				placeCode: to.PlaceCode,
				gtfsStopId: to.gtfsStopId ?? null,
				placeName: to.PlaceName,
				isStop: true,
				plannedArrival: to.PlannedArrival,
				plannedDeparture: to.PlannedDeparture,
				actualArrival: to.ActualArrival,
				actualDeparture: to.ActualDeparture,
				srtMinutes: totalSRT,
				arrivalDelaySeconds: calcDelay(to.ActualArrival, to.PlannedArrival),
				departureDelaySeconds: calcDelay(to.ActualDeparture, to.PlannedDeparture),
			});
			// Update prevTime to the actual departure of this stop
			if (to.ActualDeparture && to.ActualDeparture !== "0001-01-01T00:00:00") {
				prevTime = parseBrisbaneTime(to.ActualDeparture, "Z");
			} else if (to.PlannedDeparture && to.PlannedDeparture !== "0001-01-01T00:00:00") {
				prevTime = parseBrisbaneTime(to.PlannedDeparture, "Z");
			} else {
				prevTime = toTime;
			}
			continue;
		}
		// else: no SRT path found, include the stop
		pushSRT(result, {
			placeCode: to.PlaceCode ?? "",
			gtfsStopId: to.gtfsStopId ?? null,
			placeName: to.PlaceName,
			isStop: true,
			plannedArrival: to.PlannedArrival ?? "",
			plannedDeparture: to.PlannedDeparture ?? "",
			actualArrival: to.ActualArrival,
			actualDeparture: to.ActualDeparture,
			arrivalDelaySeconds: calcDelay(to.ActualArrival, to.PlannedArrival),
			departureDelaySeconds: calcDelay(to.ActualDeparture, to.PlannedDeparture),
		});
		// Update prevTime for next segments
		if (to.ActualDeparture && to.ActualDeparture !== "0001-01-01T00:00:00") {
			prevTime = parseBrisbaneTime(to.ActualDeparture, "Z");
		} else if (to.PlannedDeparture && to.PlannedDeparture !== "0001-01-01T00:00:00") {
			prevTime = parseBrisbaneTime(to.PlannedDeparture, "Z");
		}
	}
	// End for loop
	return result;
}
