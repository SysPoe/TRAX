export function timeDiff(t1: string, t2: string): string {
	const [h1, m1] = t1.split(":").map(Number);
	const [h2, m2] = t2.split(":").map(Number);
	let total1 = h1 * 60 + m1;
	let total2 = h2 * 60 + m2;
	let diff = total1 - total2;
	if (diff < 0) diff += 24 * 60;
	const hours = Math.floor(diff / 60);
	const mins = diff % 60;
	return `${hours}h ${mins}m`;
}

export function secTimeDiff(t1: string, t2: string): number {
	const [h1, m1] = t1.split(":").map(Number);
	const [h2, m2] = t2.split(":").map(Number);
	let total1 = h1 * 3600 + m1 * 60;
	let total2 = h2 * 3600 + m2 * 60;
	let diff = total1 - total2;
	if (diff < 0) diff += 24 * 3600;
	return diff;
}

export function getServiceDate(date: Date, timezone: string): string {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone: timezone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).formatToParts(date);
	const year = parts.find((p) => p.type === "year")!.value;
	const month = parts.find((p) => p.type === "month")!.value;
	const day = parts.find((p) => p.type === "day")!.value;
	return `${year}${month}${day}`;
}

export function getLocalISOString(date: Date, timezone: string): string {
	const format = (type: Intl.DateTimeFormatPartTypes, parts: Intl.DateTimeFormatPart[]) =>
		parts.find((p) => p.type === type)!.value;

	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone: timezone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
	}).formatToParts(date);

	const year = format("year", parts);
	const month = format("month", parts);
	const day = format("day", parts);
	const hour = format("hour", parts);
	const minute = format("minute", parts);
	const second = format("second", parts);

	return `${year}-${month}-${day}T${hour}:${minute}:${second}`;
}

export function getTimezoneOffsetSeconds(timezone: string, date: Date = new Date()): number {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: timezone,
		timeZoneName: "shortOffset",
	}).formatToParts(date);
	const offsetPart = parts.find((p) => p.type === "timeZoneName");
	if (!offsetPart) return 0;

	const match = offsetPart.value.match(/GMT([+-]\d+)(?::(\d+))?$/);
	if (!match) return 0;
	const hours = parseInt(match[1], 10);
	const minutes = match[2] ? parseInt(match[2], 10) : 0;
	return hours * 3600 + (hours >= 0 ? minutes : -minutes) * 60;
}

export function getServiceDayStart(serviceDate: string, timezone: string): number {
	const y = parseInt(serviceDate.slice(0, 4), 10);
	const m = parseInt(serviceDate.slice(4, 6), 10) - 1;
	const d = parseInt(serviceDate.slice(6, 8), 10);
	const utcMidnight = Date.UTC(y, m, d);

	const offsetAtUtcMidnight = getTimezoneOffsetSeconds(timezone, new Date(utcMidnight));
	const result = (utcMidnight - offsetAtUtcMidnight * 1000) / 1000;

	const offsetAtResult = getTimezoneOffsetSeconds(timezone, new Date(result * 1000));
	if (offsetAtResult !== offsetAtUtcMidnight) {
		return (utcMidnight - offsetAtResult * 1000) / 1000;
	}

	return result;
}

export function parseTimeWithConfig(dateStr: string, timezone: string): number {
	if (!dateStr) return 0;
	// Check if it has timezone (Z or +HH:MM or -HH:MM)
	if (dateStr.match(/(Z|[+-]\d{2}:?\d{2})$/)) {
		return new Date(dateStr).getTime();
	}
	// Add offset from config
	const now = new Date();
	const offsetMs = getTimezoneOffsetSeconds(timezone, now) * 1000;
	const dummyDate = new Date(dateStr + "Z"); // Treat as UTC first
	// Shift back by offset to get actual UTC time
	return dummyDate.getTime() - offsetMs;
}

export function parseBrisbaneTime(dateStr: string, assume: string = "+10:00"): number {
	if (!dateStr) return 0;
	// Check if it has timezone (Z or +HH:MM or -HH:MM)
	if (dateStr.match(/(Z|[+-]\d{2}:?\d{2})$/)) {
		return new Date(dateStr).getTime();
	}
	return new Date(dateStr + assume).getTime();
}

export default {
	timeDiff,
	secTimeDiff,
	getTimezoneOffsetSeconds,
	getServiceDayStart,
	getServiceDate,
	getLocalISOString,
	parseTimeWithConfig,
	parseBrisbaneTime,
};
