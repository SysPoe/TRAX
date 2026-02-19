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

function isLeapYear(year: i32): bool {
	return (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
}

function daysInMonthForYM(year: i32, month: i32): i32 {
	if (month == 2) return isLeapYear(year) ? 29 : 28;
	if (month == 4 || month == 6 || month == 9 || month == 11) return 30;
	return 31;
}

function formatDateYMD(y: i32, m: i32, d: i32): string {
	let ms = m.toString();
	let ds = d.toString();
	if (ms.length < 2) ms = "0" + ms;
	if (ds.length < 2) ds = "0" + ds;
	return y.toString() + ms + ds;
}

// Tomohiko Sakamoto's algorithm: returns 0=Sun, 1=Mon, ..., 6=Sat
function dowFromYMD(y: i32, m: i32, d: i32): i32 {
	let t: i32 = 0;
	if (m == 1) t = 0;
	else if (m == 2) t = 3;
	else if (m == 3) t = 2;
	else if (m == 4) t = 5;
	else if (m == 5) t = 0;
	else if (m == 6) t = 3;
	else if (m == 7) t = 5;
	else if (m == 8) t = 1;
	else if (m == 9) t = 4;
	else if (m == 10) t = 6;
	else if (m == 11) t = 2;
	else t = 4; // month == 12
	if (m < 3) y = y - 1;
	return (y + y / 4 - y / 100 + y / 400 + t + d) % 7;
}

export function getServiceDatesForServiceIdWasm(serviceId: string): string[] {
	if (!calendars.has(serviceId)) return [];
	let cal = calendars.get(serviceId);
	let dates = new Array<string>();

	// Step 1: Add exception_type=1 (added) dates first
	for (let i = 0; i < calendarDates.length; i++) {
		let entry = calendarDates[i];
		if (entry.serviceId != serviceId) continue;
		if (entry.exceptionType == 1 && entry.date.length > 0) {
			if (dates.indexOf(entry.date) == -1) dates.push(entry.date);
		}
	}

	// Step 2: Iterate calendar range and add dates matching day-of-week schedule
	let sy = I32.parseInt(cal.startDate.slice(0, 4));
	let sm = I32.parseInt(cal.startDate.slice(4, 6));
	let sd = I32.parseInt(cal.startDate.slice(6, 8));
	let ey = I32.parseInt(cal.endDate.slice(0, 4));
	let em = I32.parseInt(cal.endDate.slice(4, 6));
	let eday = I32.parseInt(cal.endDate.slice(6, 8));

	let cy = sy, cm = sm, cday = sd;
	while (cy < ey || (cy == ey && (cm < em || (cm == em && cday <= eday)))) {
		let dow = dowFromYMD(cy, cm, cday);
		let runs = false;
		if (dow == 0 && cal.sunday) runs = true;
		else if (dow == 1 && cal.monday) runs = true;
		else if (dow == 2 && cal.tuesday) runs = true;
		else if (dow == 3 && cal.wednesday) runs = true;
		else if (dow == 4 && cal.thursday) runs = true;
		else if (dow == 5 && cal.friday) runs = true;
		else if (dow == 6 && cal.saturday) runs = true;

		if (runs) {
			let dateStr = formatDateYMD(cy, cm, cday);
			if (dates.indexOf(dateStr) == -1) dates.push(dateStr);
		}

		cday++;
		if (cday > daysInMonthForYM(cy, cm)) {
			cday = 1;
			cm++;
			if (cm > 12) { cm = 1; cy++; }
		}
	}

	// Step 3: Remove exception_type=2 (removed) dates
	for (let i = 0; i < calendarDates.length; i++) {
		let entry = calendarDates[i];
		if (entry.serviceId != serviceId) continue;
		if (entry.exceptionType == 2 && entry.date.length > 0) {
			let idx = dates.indexOf(entry.date);
			if (idx > -1) dates.splice(idx, 1);
		}
	}

	return dates.sort();
}

// --- Date String Arithmetic ---

export function addDaysToDateString(dateStr: string, daysToAdd: i32): string {
	if (daysToAdd == 0) return dateStr;
	let y = I32.parseInt(dateStr.slice(0, 4));
	let m = I32.parseInt(dateStr.slice(4, 6));
	let d = I32.parseInt(dateStr.slice(6, 8));

	d += daysToAdd;

	// Handle forward overflow
	while (d > daysInMonthForYM(y, m)) {
		d -= daysInMonthForYM(y, m);
		m++;
		if (m > 12) { m = 1; y++; }
	}

	// Handle backward overflow
	while (d < 1) {
		m--;
		if (m < 1) { m = 12; y--; }
		d += daysInMonthForYM(y, m);
	}

	return formatDateYMD(y, m, d);
}

// --- Delay Classification ---

class DelayInfo {
	str: string = "";
	cls: string = "";
}

export function calculateDelayClassWasm(delaySecs: i32): DelayInfo {
	if (Math.abs(delaySecs as f64) <= 60) return { str: "on time", cls: "on-time" };
	if (delaySecs > 0 && delaySecs <= 300)
		return { str: Math.round((delaySecs as f64) / 60).toString() + "m late", cls: "late" };
	if (delaySecs > 300)
		return { str: Math.round((delaySecs as f64) / 60).toString() + "m late", cls: "very-late" };
	return { str: Math.round(Math.abs(delaySecs as f64) / 60).toString() + "m early", cls: "early" };
}
