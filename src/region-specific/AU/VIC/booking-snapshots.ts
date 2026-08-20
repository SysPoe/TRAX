import { cacheFileExists, loadCacheFile, writeCacheFileAtomic } from "../../../utils/fs.js";
import type { VLineBookingAvailability } from "./types.js";

const BOOKING_SNAPSHOT_FILE = "vline-booking-snapshots-v1.json";
export const VLINE_BOOKING_PREFETCH_WINDOW_MS = 15 * 60_000;

export type VLineBookingSnapshot = {
	availability: VLineBookingAvailability;
	expiresAt: number;
};

type BookingSnapshotFile = {
	version: 1;
	entries: Array<{ key: string; snapshot: VLineBookingSnapshot }>;
};

function isNonNegativeCount(value: unknown): value is number | null {
	return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

function isBookingAvailability(value: unknown): value is VLineBookingAvailability {
	if (!value || typeof value !== "object") return false;
	const availability = value as Record<string, unknown>;
	return (
		typeof availability.tdn === "string" &&
		Array.isArray(availability.reservedCarriages) &&
		availability.reservedCarriages.every((carriage) => typeof carriage === "string") &&
		isNonNegativeCount(availability.reservedSeatsAvailable) &&
		isNonNegativeCount(availability.unreservedTicketsAvailable) &&
		typeof availability.reservationAvailable === "boolean" &&
		typeof availability.reservationRequired === "boolean" &&
		typeof availability.seatMapAvailable === "boolean" &&
		typeof availability.journeyUrl === "string" &&
		typeof availability.observedAt === "string"
	);
}

function isBookingSnapshot(value: unknown): value is VLineBookingSnapshot {
	if (!value || typeof value !== "object") return false;
	const snapshot = value as Record<string, unknown>;
	return (
		typeof snapshot.expiresAt === "number" &&
		Number.isFinite(snapshot.expiresAt) &&
		isBookingAvailability(snapshot.availability)
	);
}

export function vlineBookingSnapshotKey(
	serviceDate: string,
	tdn: string,
	scheduledDepartureTime: string,
	origin: string,
	destination: string,
): string {
	return JSON.stringify([serviceDate, tdn, scheduledDepartureTime, origin, destination]);
}

export function loadVLineBookingSnapshots(cacheDir: string, now = Date.now()): Map<string, VLineBookingSnapshot> {
	const snapshots = new Map<string, VLineBookingSnapshot>();
	try {
		if (!cacheFileExists(BOOKING_SNAPSHOT_FILE, cacheDir)) return snapshots;
		const parsed: unknown = JSON.parse(loadCacheFile(BOOKING_SNAPSHOT_FILE, cacheDir));
		if (!parsed || typeof parsed !== "object") return snapshots;
		const file = parsed as Partial<BookingSnapshotFile>;
		if (file.version !== 1 || !Array.isArray(file.entries)) return snapshots;
		for (const entry of file.entries) {
			if (!entry || typeof entry.key !== "string" || !isBookingSnapshot(entry.snapshot)) continue;
			if (entry.snapshot.expiresAt <= now) continue;
			snapshots.set(entry.key, entry.snapshot);
		}
	} catch {
		// A corrupt optional cache must not prevent the network from starting.
	}
	return snapshots;
}

export function saveVLineBookingSnapshots(
	cacheDir: string,
	snapshots: ReadonlyMap<string, VLineBookingSnapshot>,
	now = Date.now(),
): void {
	const entries = [...snapshots]
		.filter(([, snapshot]) => snapshot.expiresAt > now)
		.map(([key, snapshot]) => ({ key, snapshot }));
	const file: BookingSnapshotFile = { version: 1, entries };
	writeCacheFileAtomic(BOOKING_SNAPSHOT_FILE, JSON.stringify(file), cacheDir);
}

export function shouldPrefetchVLineBooking(
	departureMs: number,
	now = Date.now(),
	windowMs = VLINE_BOOKING_PREFETCH_WINDOW_MS,
): boolean {
	const untilDeparture = departureMs - now;
	return untilDeparture > 0 && untilDeparture <= windowMs;
}
