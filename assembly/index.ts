// assembly/index.ts

/**
 * Topology Graph and SRT Interpolation in WebAssembly
 */

const adjacency = new Map<string, string[]>();
const srtMatrix = new Map<string, f64>(); // Key: "from|to"

/**
 * Reset all stored graph data.
 */
export function resetGraph(): void {
	let keys = adjacency.keys();
	for (let i = 0; i < keys.length; i++) {
		adjacency.delete(keys[i]);
	}

	let srtKeys = srtMatrix.keys();
	for (let i = 0; i < srtKeys.length; i++) {
		srtMatrix.delete(srtKeys[i]);
	}
}

/**
 * Add a directed edge to the adjacency graph.
 */
export function addAdjacency(from: string, to: string): void {
	if (!adjacency.has(from)) {
		adjacency.set(from, [to]);
	} else {
		let neighbors = adjacency.get(from);
		if (neighbors.indexOf(to) == -1) {
			neighbors.push(to);
		}
	}
}

/**
 * Add a segment run time (SRT) for a specific edge.
 */
export function addSRT(from: string, to: string, value: f64): void {
	srtMatrix.set(from + "|" + to, value);
}

/**
 * Retrieve the SRT between two stops (bi-directional check).
 * Returns -1.0 if not found.
 */
export function getSRT(from: string, to: string): f64 {
	let key = from + "|" + to;
	if (srtMatrix.has(key)) return srtMatrix.get(key);
	let revKey = to + "|" + from;
	if (srtMatrix.has(revKey)) return srtMatrix.get(revKey);
	return -1.0;
}

/**
 * Find the shortest path between two stops using BFS.
 * Returns an array of stop IDs or null if no path exists.
 */
export function findPath(start: string, end: string): string[] | null {
	if (start == end) return [start];
	if (!adjacency.has(start)) return null;

	let queue = new Array<string[]>();
	queue.push([start]);

	// Use a map to track visited nodes since AS doesn't have a built-in Set in all versions
	let visited = new Map<string, boolean>();
	visited.set(start, true);

	while (queue.length > 0) {
		let currentPath = queue.shift();
		let currentStop = currentPath[currentPath.length - 1];

		if (adjacency.has(currentStop)) {
			let neighbors = adjacency.get(currentStop);
			for (let i = 0, len = neighbors.length; i < len; i++) {
				let neighbor = neighbors[i];
				if (!visited.has(neighbor)) {
					if (neighbor == end) {
						let newPath = currentPath.slice();
						newPath.push(neighbor);
						return newPath;
					}
					visited.set(neighbor, true);
					let newPath = currentPath.slice();
					newPath.push(neighbor);
					queue.push(newPath);
				}
			}
		}
	}

	return null;
}

/**
 * Interpolate times for stops between start and end based on EMU/SRT values.
 * Returns an array of UNIX timestamps (seconds).
 */
export function interpolateTimes(startDepartureTime: i32, endArrivalTime: i32, emus: f64[]): i32[] {
	let totalTimeDiff = endArrivalTime - startDepartureTime;
	let totalEmu: f64 = 0;
	for (let i = 0; i < emus.length; i++) {
		totalEmu += emus[i];
	}

	let resultCount = emus.length - 1;
	if (resultCount < 0) return [];

	let result = new Array<i32>(resultCount);
	let accumulatedEmu: f64 = 0;

	for (let i = 0; i < resultCount; i++) {
		accumulatedEmu += emus[i];
		let offset = totalEmu > 0 ? (accumulatedEmu / totalEmu) * (totalTimeDiff as f64) : 0;
		result[i] = startDepartureTime + (Math.floor(offset) as i32);
	}

	return result;
}

/**
 * Filter and sort departure indices based on timestamps.
 * Returns an array of original indices.
 */
export function filterAndSortDepartures(
	timestamps: f64[],
	originalIndices: i32[],
	windowStart: f64,
	windowEnd: f64,
): i32[] {
	let filteredIndices = new Array<i32>();
	let filteredTimestamps = new Array<f64>();

	for (let i = 0, len = timestamps.length; i < len; i++) {
		let ts = timestamps[i];
		if (ts >= windowStart && ts <= windowEnd) {
			filteredIndices.push(originalIndices[i]);
			filteredTimestamps.push(ts);
		}
	}

	// Sort the filtered results based on timestamps
	if (filteredIndices.length > 1) {
		quickSort(filteredIndices, filteredTimestamps, 0, filteredIndices.length - 1);
	}

	return filteredIndices;
}

function quickSort(indices: i32[], timestamps: f64[], left: i32, right: i32): void {
	if (left < right) {
		let pivotIndex = partition(indices, timestamps, left, right);
		quickSort(indices, timestamps, left, pivotIndex - 1);
		quickSort(indices, timestamps, pivotIndex + 1, right);
	}
}

function partition(indices: i32[], timestamps: f64[], left: i32, right: i32): i32 {
	let pivot = timestamps[right];
	let i = left - 1;
	for (let j = left; j < right; j++) {
		if (timestamps[j] < pivot) {
			i++;
			swap(indices, i, j);
			swapF64(timestamps, i, j);
		}
	}
	swap(indices, i + 1, right);
	swapF64(timestamps, i + 1, right);
	return i + 1;
}

function swap(arr: i32[], i: i32, j: i32): void {
	let temp = arr[i];
	arr[i] = arr[j];
	arr[j] = temp;
}

function swapF64(arr: f64[], i: i32, j: i32): void {
	let temp = arr[i];
	arr[i] = arr[j];
	arr[j] = temp;
}

// --- Delay Logic ---

class DelayInfo {
	str: string = "";
	cls: string = "";
}

export function calculateDelayClassWasm(delaySecs: i32): DelayInfo {
	if (Math.abs(delaySecs as f64) <= 60) return { str: "on time", cls: "on-time" };
	if (delaySecs > 0 && delaySecs <= 300)
		return { str: (Math.round((delaySecs as f64) / 60) as i64).toString() + "m late", cls: "late" };
	if (delaySecs > 300) return { str: (Math.round((delaySecs as f64) / 60) as i64).toString() + "m late", cls: "very-late" };
	return { str: (Math.round(Math.abs(delaySecs as f64) / 60) as i64).toString() + "m early", cls: "early" };
}

// --- Static Data Store for Augmentation ---

class WasmStop {
	id: string = "";
	parentId: string = "";
	platformCode: string = "";
}

class WasmCalendar {
	monday: bool = false;
	tuesday: bool = false;
	wednesday: bool = false;
	thursday: bool = false;
	friday: bool = false;
	saturday: bool = false;
	sunday: bool = false;
	startDate: string = "";
	endDate: string = "";
}

class WasmCalendarDate {
	serviceId: string = "";
	date: string = "";
	exceptionType: i32 = 0;
}

const stops = new Map<string, WasmStop>();
const calendars = new Map<string, WasmCalendar>();
const calendarDates = new Array<WasmCalendarDate>();
const tripServiceIds = new Map<string, string>();

export function clearStaticData(): void {
	stops.clear();
	calendars.clear();
	calendarDates.length = 0;
	tripServiceIds.clear();
}

export function addWasmStop(id: string, parentId: string, platformCode: string): void {
	stops.set(id, { id, parentId, platformCode });
}

export function addWasmCalendar(
	serviceId: string,
	m: bool,
	t: bool,
	w: bool,
	th: bool,
	f: bool,
	s: bool,
	su: bool,
	start: string,
	end: string,
): void {
	calendars.set(serviceId, {
		monday: m,
		tuesday: t,
		wednesday: w,
		thursday: th,
		friday: f,
		saturday: s,
		sunday: su,
		startDate: start,
		endDate: end,
	});
}

export function addWasmCalendarDate(serviceId: string, date: string, type: i32): void {
	calendarDates.push({ serviceId, date, exceptionType: type });
}

export function addWasmTripRecord(tripId: string, serviceId: string): void {
	tripServiceIds.set(tripId, serviceId);
}

// --- Date Utilities ---

function dateToEpochDays(y: i32, m: i32, d: i32): i32 {
	m = (m + 9) % 12;
	y = y - m / 10;
	return 365 * y + y / 4 - y / 100 + y / 400 + (m * 306 + 5) / 10 + (d - 1);
}

function epochDaysToDateString(g: i32): string {
	let y = (10000 * g + 1478010) / 3652425;
	let ddt = g - (365 * y + y / 4 - y / 100 + y / 400);
	if (ddt < 0) {
		y = y - 1;
		ddt = g - (365 * y + y / 4 - y / 100 + y / 400);
	}
	let mi = (100 * ddt + 52) / 3060;
	let mm = ((mi + 2) % 12) + 1;
	y = y + (mi + 2) / 12;
	let dd = ddt - (mi * 306 + 5) / 10 + 1;

	let yearStr = y.toString();
	let monthStr = mm.toString();
	if (monthStr.length < 2) monthStr = "0" + monthStr;
	let dayStr = dd.toString();
	if (dayStr.length < 2) dayStr = "0" + dayStr;

	return yearStr + monthStr + dayStr;
}

function getDayOfWeek(epochDays: i32): i32 {
	// 1970-01-01 was a Thursday (index 4)
	// EPOCH_ADJUSTMENT is for 0001-01-01 which was a Monday (index 1)
	return (epochDays + 1) % 7;
}

export function addDaysToDateString(dateStr: string, daysToAdd: i32): string {
	if (daysToAdd == 0) return dateStr;
	let y = I32.parseInt(dateStr.slice(0, 4));
	let m = I32.parseInt(dateStr.slice(4, 6));
	let d = I32.parseInt(dateStr.slice(6, 8));

	let epochDays = dateToEpochDays(y, m, d) + daysToAdd;
	return epochDaysToDateString(epochDays);
}

export function getServiceDatesWasm(serviceId: string): string[] {
	let dates = new Array<string>();
	if (calendars.has(serviceId)) {
		let cal = calendars.get(serviceId);
		let startY = I32.parseInt(cal.startDate.slice(0, 4));
		let startM = I32.parseInt(cal.startDate.slice(4, 6));
		let startD = I32.parseInt(cal.startDate.slice(6, 8));

		let endY = I32.parseInt(cal.endDate.slice(0, 4));
		let endM = I32.parseInt(cal.endDate.slice(4, 6));
		let endD = I32.parseInt(cal.endDate.slice(6, 8));

		let currentEpoch = dateToEpochDays(startY, startM, startD);
		let endEpoch = dateToEpochDays(endY, endM, endD);

		while (currentEpoch <= endEpoch) {
			let dow = getDayOfWeek(currentEpoch); // 0=Sun, 1=Mon, ..., 6=Sat
			let runs = false;
			if (dow == 0 && cal.sunday) runs = true;
			else if (dow == 1 && cal.monday) runs = true;
			else if (dow == 2 && cal.tuesday) runs = true;
			else if (dow == 3 && cal.wednesday) runs = true;
			else if (dow == 4 && cal.thursday) runs = true;
			else if (dow == 5 && cal.friday) runs = true;
			else if (dow == 6 && cal.saturday) runs = true;

			if (runs) {
				dates.push(epochDaysToDateString(currentEpoch));
			}
			currentEpoch++;
		}
	}

	// Apply exceptions
	for (let i = 0; i < calendarDates.length; i++) {
		let cd = calendarDates[i];
		if (cd.serviceId != serviceId) continue;

		if (cd.exceptionType == 1) {
			if (dates.indexOf(cd.date) == -1) {
				dates.push(cd.date);
			}
		} else if (cd.exceptionType == 2) {
			let idx = dates.indexOf(cd.date);
			if (idx > -1) {
				dates.splice(idx, 1);
			}
		}
	}

	return dates.sort();
}

export function getServiceDatesByTripWasm(tripId: string): string[] {
	if (!tripServiceIds.has(tripId)) return [];
	return getServiceDatesWasm(tripServiceIds.get(tripId));
}
