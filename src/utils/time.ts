import { TraxConfig } from "../config.js";

const serviceDayStartCache = new Map<string, number>();

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
	if (Number.isNaN(date.getTime())) return 0;
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
	if (!serviceDate || serviceDate.length < 8) return 0;
	const cacheKey = `${serviceDate}|${timezone}`;
	const cached = serviceDayStartCache.get(cacheKey);
	if (cached !== undefined) return cached;
	const y = parseInt(serviceDate.slice(0, 4), 10);
	const m = parseInt(serviceDate.slice(4, 6), 10) - 1;
	const d = parseInt(serviceDate.slice(6, 8), 10);
	if (Number.isNaN(y) || Number.isNaN(m) || Number.isNaN(d)) return 0;

	const utcMidnight = Date.UTC(y, m, d);
	if (Number.isNaN(utcMidnight)) return 0;

	const offsetAtUtcMidnight = getTimezoneOffsetSeconds(timezone, new Date(utcMidnight));
	const result = (utcMidnight - offsetAtUtcMidnight * 1000) / 1000;

	const offsetAtResult = getTimezoneOffsetSeconds(timezone, new Date(result * 1000));
	if (offsetAtResult !== offsetAtUtcMidnight) {
		const adjusted = (utcMidnight - offsetAtResult * 1000) / 1000;
		serviceDayStartCache.set(cacheKey, adjusted);
		return adjusted;
	}

	serviceDayStartCache.set(cacheKey, result);
	return result;
}

function epochDaysToServiceDate(epochDays: number): string {
	let y = Math.floor((10000 * epochDays + 1478010) / 3652425);
	let ddt = epochDays - (365 * y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400));
	if (ddt < 0) {
		y = y - 1;
		ddt = epochDays - (365 * y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400));
	}
	const mi = Math.floor((100 * ddt + 52) / 3060);
	const mm = Math.floor(((mi + 2) % 12) + 1);
	y = Math.floor(y + (mi + 2) / 12);
	const dd = Math.floor(ddt - Math.floor((mi * 306 + 5) / 10) + 1);

	const yearStr = y.toString().padStart(4, "0");
	const monthStr = mm.toString().padStart(2, "0");
	const dayStr = dd.toString().padStart(2, "0");

	return `${yearStr}${monthStr}${dayStr}`;
}

export function getEpochDayFromServiceDate(serviceDate: string): number {
	if (!serviceDate || serviceDate.length < 8) return Number.NaN;
	const y = parseInt(serviceDate.slice(0, 4), 10);
	const m = parseInt(serviceDate.slice(4, 6), 10);
	const d = parseInt(serviceDate.slice(6, 8), 10);
	if (Number.isNaN(y) || Number.isNaN(m) || Number.isNaN(d)) return Number.NaN;

	let month = (m + 9) % 12;
	let year = y - Math.floor(month / 10);
	return (
		365 * year +
		Math.floor(year / 4) -
		Math.floor(year / 100) +
		Math.floor(year / 400) +
		Math.floor((month * 306 + 5) / 10) +
		(d - 1)
	);
}

export function addDaysToServiceDate(serviceDate: string, daysToAdd: number): string {
	if (!daysToAdd) return serviceDate;
	const epochDay = getEpochDayFromServiceDate(serviceDate);
	if (!Number.isFinite(epochDay)) return serviceDate;
	return epochDaysToServiceDate(epochDay + daysToAdd);
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

export function getToday(config: TraxConfig): string {
	const offsetMs = getTimezoneOffsetSeconds(config.timezone) * 1000;
	return new Date(Date.now() + offsetMs).toISOString().slice(0, 10).replace(/-/g, "");
}

export default {
	timeDiff,
	secTimeDiff,
	getTimezoneOffsetSeconds,
	getServiceDayStart,
	getEpochDayFromServiceDate,
	addDaysToServiceDate,
	getServiceDate,
	getLocalISOString,
	parseTimeWithConfig,
	parseBrisbaneTime,
};
