export type ServiceDate = string & { readonly __serviceDate: unique symbol };
export type GtfsTime = number & { readonly __gtfsTime: unique symbol };
export type Instant = string & { readonly __instant: unique symbol };

const MAX_TIMEZONE_FORMATTERS = 64;
const serviceDateFormatters = new Map<string, Intl.DateTimeFormat>();
const localIsoFormatters = new Map<string, Intl.DateTimeFormat>();
const offsetFormatters = new Map<string, Intl.DateTimeFormat>();

/** Reuse Intl setup, but evaluate every instant so DST offsets stay exact. */
function timezoneFormatter(
	cache: Map<string, Intl.DateTimeFormat>,
	timezone: string,
	locale: string,
	options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
	let formatter = cache.get(timezone);
	if (formatter) return formatter;
	formatter = new Intl.DateTimeFormat(locale, { ...options, timeZone: timezone });
	if (cache.size >= MAX_TIMEZONE_FORMATTERS) cache.delete(cache.keys().next().value!);
	cache.set(timezone, formatter);
	return formatter;
}

export function asServiceDate(value: string): ServiceDate {
	if (!/^\d{8}$/.test(value)) throw new Error(`Invalid ServiceDate '${value}'`);
	return value as ServiceDate;
}

export function asGtfsTime(value: number): GtfsTime {
	if (!Number.isInteger(value) || value < 0) throw new Error(`Invalid GtfsTime '${value}'`);
	return value as GtfsTime;
}

export function timeDiff(t1: string, t2: string): string {
	const diff = secTimeDiff(t1, t2);
	const hours = Math.floor(diff / 3600);
	const mins = Math.floor((diff % 3600) / 60);
	const seconds = diff % 60;
	return `${hours}h ${mins}m${seconds ? ` ${seconds}s` : ""}`;
}

export function secTimeDiff(t1: string, t2: string): number {
	const [h1, m1, s1 = 0] = t1.split(":").map(Number);
	const [h2, m2, s2 = 0] = t2.split(":").map(Number);
	let total1 = h1 * 3600 + m1 * 60 + s1;
	let total2 = h2 * 3600 + m2 * 60 + s2;
	let diff = total1 - total2;
	if (diff < 0) diff += 24 * 3600;
	return diff;
}

export function getServiceDate(date: Date, timezone: string): string {
	const parts = timezoneFormatter(serviceDateFormatters, timezone, "en-CA", {
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

	const parts = timezoneFormatter(localIsoFormatters, timezone, "en-CA", {
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
	const parts = timezoneFormatter(offsetFormatters, timezone, "en-US", {
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
	if (!/^\d{8}$/.test(serviceDate)) return 0;
	const localMidnight = `${serviceDate.slice(0, 4)}-${serviceDate.slice(4, 6)}-${serviceDate.slice(6, 8)}T00:00:00`;
	const midnightMs = parseTimeWithConfig(localMidnight, timezone);
	return Number.isFinite(midnightMs) && midnightMs !== 0 ? midnightMs / 1000 : 0;
}

export function serviceTimeToInstant(serviceDate: ServiceDate | string, serviceTime: GtfsTime | number, timezone: string): Instant {
	const epochSeconds = getServiceDayStart(serviceDate, timezone) + serviceTime;
	return new Date(epochSeconds * 1000).toISOString() as Instant;
}

export function getServiceDateFromEpochDay(epochDays: number): string {
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
	return getServiceDateFromEpochDay(epochDay + daysToAdd);
}

export function parseTimeWithConfig(dateStr: string, timezone: string): number {
	if (!dateStr) return 0;
	// Check if it has timezone (Z or +HH:MM or -HH:MM)
	if (dateStr.match(/(Z|[+-]\d{2}:?\d{2})$/)) {
		return new Date(dateStr).getTime();
	}
	const wallClockAsUtc = new Date(`${dateStr}Z`).getTime();
	if (!Number.isFinite(wallClockAsUtc)) return 0;

	// A wall time may have two matching instants during a fall-back transition,
	// or none during a spring-forward gap. Sample offsets on both sides of the
	// date, then use the compatible policy: the earlier instant for an overlap
	// and the first corresponding wall time after a gap.
	const offsets = new Set<number>();
	for (const deltaHours of [-36, -12, 0, 12, 36]) {
		offsets.add(getTimezoneOffsetSeconds(timezone, new Date(wallClockAsUtc + deltaHours * 3_600_000)));
	}
	const candidates = [...offsets]
		.map((offset) => wallClockAsUtc - offset * 1000)
		.map((instant) => ({
			instant,
			localAsUtc: new Date(`${getLocalISOString(new Date(instant), timezone)}Z`).getTime(),
		}))
		.filter((candidate) => Number.isFinite(candidate.localAsUtc));
	const exact = candidates
		.filter((candidate) => candidate.localAsUtc === wallClockAsUtc)
		.sort((left, right) => left.instant - right.instant);
	if (exact.length) return exact[0].instant;
	const afterGap = candidates
		.filter((candidate) => candidate.localAsUtc > wallClockAsUtc)
		.sort((left, right) => left.localAsUtc - right.localAsUtc || left.instant - right.instant);
	return afterGap[0]?.instant ?? 0;
}

export function getToday(timezone: string): string {
	return getServiceDate(new Date(), timezone);
}

export default {
	timeDiff,
	secTimeDiff,
	getTimezoneOffsetSeconds,
	getServiceDayStart,
	getEpochDayFromServiceDate,
	getServiceDateFromEpochDay,
	addDaysToServiceDate,
	getServiceDate,
	getLocalISOString,
	parseTimeWithConfig,
	serviceTimeToInstant,
};
