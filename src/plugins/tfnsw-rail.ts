import type { RealtimeTripUpdate, StopTime } from "qdf-gtfs";
import type { CacheContext } from "../cache/types.js";
import { entityKey } from "../identity.js";
import { getServiceDayStart } from "../utils/time.js";
import type { TransitPlugin } from "./types.js";

const SYDNEY_TRAINS_FEED_ID = "nsw-sydney-trains";
const NSW_TRAINLINK_FEED_ID = "nsw-trainlink";

export function tfnswPlatformCode(stopName: string | null | undefined): string | null {
	const match = stopName?.match(/\bplatform\s+([0-9]+(?:\s*[A-Za-z])?)\b/i);
	return match?.[1]?.replace(/\s+/g, " ") ?? null;
}

export function inferTfnswRealtimeServiceDate(input: {
	candidateServiceDates: readonly string[];
	firstServiceTime: number;
	lastServiceTime: number;
	nowEpochSeconds: number;
	timeZone: string;
}): string | null {
	if (input.candidateServiceDates.length === 0) return null;
	const distance = (start: number, end: number) =>
		input.nowEpochSeconds < start
			? start - input.nowEpochSeconds
			: input.nowEpochSeconds > end
				? input.nowEpochSeconds - end
				: 0;
	return [...input.candidateServiceDates].sort((a, b) => {
		const aStart = getServiceDayStart(a, input.timeZone) + input.firstServiceTime;
		const aEnd = getServiceDayStart(a, input.timeZone) + input.lastServiceTime;
		const bStart = getServiceDayStart(b, input.timeZone) + input.firstServiceTime;
		const bEnd = getServiceDayStart(b, input.timeZone) + input.lastServiceTime;
		return distance(aStart, aEnd) - distance(bStart, bEnd);
	})[0];
}

function stopTimeBounds(stopTimes: readonly Pick<StopTime, "arrival_time" | "departure_time">[]) {
	const times = stopTimes.flatMap((stopTime) =>
		[stopTime.arrival_time, stopTime.departure_time].filter((time): time is number => time != null),
	);
	return times.length > 0 ? { first: Math.min(...times), last: Math.max(...times) } : null;
}

function enrichTfnswRealtimeTripUpdate(update: RealtimeTripUpdate, ctx: CacheContext): RealtimeTripUpdate {
	if (update.trip.start_date || update.feed_id !== SYDNEY_TRAINS_FEED_ID || !ctx.gtfs) return update;
	const tripKey = entityKey({ feedId: update.feed_id, localId: update.trip.trip_id });
	const stopTimes =
		ctx.augmented.rawStopTimesCache.get(tripKey) ??
		ctx.gtfs.getStopTimes({ feed_id: update.feed_id, trip_id: update.trip.trip_id });
	const bounds = stopTimeBounds(stopTimes);
	if (!bounds) return update;
	const serviceDate = inferTfnswRealtimeServiceDate({
		candidateServiceDates: ctx.gtfs.getServiceDatesByTrip({ feedId: update.feed_id, localId: update.trip.trip_id }),
		firstServiceTime: bounds.first,
		lastServiceTime: bounds.last,
		nowEpochSeconds: update.timestamp ?? Date.now() / 1000,
		timeZone: ctx.config.feedTimeZones.get(update.feed_id) ?? "Australia/Sydney",
	});
	return serviceDate ? { ...update, trip: { ...update.trip, start_date: serviceDate } } : update;
}

/**
 * The TfNSW rail archives overlap. Keep each operator in one feed so the
 * combined runtime does not emit duplicate intercity or regional trips.
 */
export const tfnswRailPlugin: TransitPlugin = {
	id: "au-nsw-tfnsw-rail",
	feedIds: [SYDNEY_TRAINS_FEED_ID, NSW_TRAINLINK_FEED_ID],
	capabilities: ["vehicles"],
	considerRoute(route) {
		if (route.feed_id === SYDNEY_TRAINS_FEED_ID) {
			return route.agency_id === "SydneyTrains";
		}
		if (route.feed_id === NSW_TRAINLINK_FEED_ID) {
			return route.agency_id === "X000" || route.agency_id === "711";
		}
		return undefined;
	},
	enrichStop(stop) {
		if (stop.platform_code) return;
		const platformCode = tfnswPlatformCode(stop.stop_name);
		if (platformCode) stop.platform_code = platformCode;
	},
	enrichRealtimeTripUpdate: enrichTfnswRealtimeTripUpdate,
	isNonRevenueRoute: (route) =>
		route.feed_id === SYDNEY_TRAINS_FEED_ID && route.route_id.startsWith("RTTA_"),
};
