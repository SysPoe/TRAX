export function timeDiff(t1: string, t2: string): string {
	// t1 and t2 are in 'HH:mm' format
	const [h1, m1] = t1.split(":").map(Number);
	const [h2, m2] = t2.split(":").map(Number);
	let total1 = h1 * 60 + m1;
	let total2 = h2 * 60 + m2;
	let diff = total1 - total2;
	if (diff < 0) diff += 24 * 60; // handle overnight
	const hours = Math.floor(diff / 60);
	const mins = diff % 60;
	return `${hours}h ${mins}m`;
}

export function secTimeDiff(t1: string, t2: string): number {
	// t1 and t2 are in 'HH:mm' format
	const [h1, m1] = t1.split(":").map(Number);
	const [h2, m2] = t2.split(":").map(Number);
	let total1 = h1 * 3600 + m1 * 60;
	let total2 = h2 * 3600 + m2 * 60;
	let diff = total1 - total2;
	if (diff < 0) diff += 24 * 3600; // handle overnight
	return diff;
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
	const offsetSecs = getTimezoneOffsetSeconds(timezone, new Date(dateStr + "Z"));
	const offsetHours = Math.floor(Math.abs(offsetSecs) / 3600);
	const offsetMins = (Math.abs(offsetSecs) % 3600) / 60;
	const offsetStr = (offsetSecs >= 0 ? "+" : "-") + 
		offsetHours.toString().padStart(2, "0") + ":" + 
		offsetMins.toString().padStart(2, "0");
	
	return new Date(dateStr + offsetStr).getTime();
}

/** @deprecated use parseTimeWithConfig */
export function parseBrisbaneTime(dateStr: string, assume: string = "+10:00"): number {
	if (!dateStr) return 0;
	// Check if it has timezone (Z or +HH:MM or -HH:MM)
	if (dateStr.match(/(Z|[+-]\d{2}:?\d{2})$/)) {
		return new Date(dateStr).getTime();
	}
	return new Date(dateStr + assume).getTime();
}

export default { timeDiff, secTimeDiff, getTimezoneOffsetSeconds, getServiceDayStart, parseTimeWithConfig, parseBrisbaneTime };
