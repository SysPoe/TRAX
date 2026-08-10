import type { QualifiedEntityId } from "qdf-gtfs";
import type { CacheContext } from "../cache/index.js";
import { getEpochDayFromServiceDate } from "./time.js";
import { entityKey } from "../identity.js";

export function getServiceDatesByTrip(
	trip: QualifiedEntityId,
	ctx: CacheContext,
	minEpochDay = -1,
	maxEpochDay = -1,
): string[] {
	if (!ctx.gtfs) return [];
	const cacheKey = `${entityKey(trip)}|${minEpochDay}|${maxEpochDay}`;
	const cached = ctx.runtimeState.serviceDates.get(cacheKey);
	if (cached) return cached;
	const dates = ctx.gtfs.getServiceDatesByTrip(trip);
	const result = dates.filter((date) => {
		const epochDay = getEpochDayFromServiceDate(date);
		return Number.isFinite(epochDay) && (minEpochDay < 0 || epochDay >= minEpochDay) && (maxEpochDay < 0 || epochDay <= maxEpochDay);
	});
	ctx.runtimeState.serviceDates.set(cacheKey, result);
	return result;
}

/** QDF owns the feed-qualified calendar snapshot; only runtime memoization is reset here. */
export function syncCalendarsToWasm(ctx: CacheContext): void {
	ctx.runtimeState.serviceDates.clear();
}
