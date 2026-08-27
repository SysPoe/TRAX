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
	const rawTrip = ctx.raw.tripsByKey.get(entityKey(trip));
	const dates = rawTrip
		? ctx.gtfs.getServiceDates({ feedId: rawTrip.feed_id, localId: rawTrip.service_id })
		: ctx.gtfs.getServiceDatesByTrip(trip);
	const result = dates.filter((date) => {
		const epochDay = getEpochDayFromServiceDate(date);
		return Number.isFinite(epochDay) && (minEpochDay < 0 || epochDay >= minEpochDay) && (maxEpochDay < 0 || epochDay <= maxEpochDay);
	});
	ctx.runtimeState.serviceDates.set(cacheKey, result);
	return result;
}

/** Return one feed-qualified service calendar without repeating it per trip. */
export function getServiceDatesByService(
	service: QualifiedEntityId,
	ctx: CacheContext,
	fallbackTrip?: QualifiedEntityId,
): string[] {
	if (!ctx.gtfs) return [];
	const cacheKey = `service|${entityKey(service)}`;
	const cached = ctx.runtimeState.serviceDates.get(cacheKey);
	if (cached) return cached;
	const result =
		typeof ctx.gtfs.getServiceDates === "function"
			? ctx.gtfs.getServiceDates(service)
			: fallbackTrip
				? ctx.gtfs.getServiceDatesByTrip(fallbackTrip)
				: [];
	ctx.runtimeState.serviceDates.set(cacheKey, result);
	return result;
}

/** QDF owns the feed-qualified calendar snapshot; only runtime memoization is reset here. */
export function syncCalendarsToWasm(ctx: CacheContext): void {
	ctx.runtimeState.serviceDates.clear();
}
