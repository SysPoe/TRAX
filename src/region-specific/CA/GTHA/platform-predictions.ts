import { getFeedTimeZone } from "../../../config.js";
import type { CacheContext } from "../../../cache/types.js";
import { getPluginState } from "../../../plugins/types.js";
import { getCacheFilePath } from "../../../utils/fs.js";
import { getServiceDayStart } from "../../../utils/time.js";
import {
	PlatformPredictionShadow,
	type PlatformPredictionDiagnostics,
	type PlatformPredictionEvent,
} from "../../../utils/platformPredictionShadow.js";
import { entityKey } from "../../../identity.js";
import { TripScheduleRelationship } from "qdf-gtfs";

const CACHE_FILE = "region-specific/ca-gtha/platform-prediction-shadow-v1.sqlite";

/**
 * Feeds whose reported platforms feed the shadow predictor. VIA reports
 * track/platform assignments through its CIS station boards (see
 * `region-specific/CA/VIA/station-board.ts`), which land on the same
 * `actual_*_boarding_locations` fields as GO/UP, so it uses the same event
 * shape despite living behind a different plugin.
 */
export const PLATFORM_PREDICTION_FEED_IDS: ReadonlySet<string> = new Set(["go", "up", "via"]);

function serviceDayOfWeek(serviceDate: string): number {
	const year = Number(serviceDate.slice(0, 4));
	const month = Number(serviceDate.slice(4, 6));
	const day = Number(serviceDate.slice(6, 8));
	return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function state(ctx: CacheContext): PlatformPredictionShadow {
	return getPluginState(
		ctx,
		"ca-gtha:platform-prediction-shadow",
		() => new PlatformPredictionShadow(getCacheFilePath(CACHE_FILE, ctx.config.cacheDir)),
	);
}

/** Build shadow predictions and evaluate them later without applying them to stop times.
 *
 * Runs inside the GTHA plugin's `afterRealtime`, concurrently with the VIA
 * plugin's CIS application (shared `ca-supplemental` group). Both touch
 * augmented state synchronously, so the read here sees either the previous
 * or the current cycle's CIS locations — never a torn write — and every
 * shadow write is an idempotent event-key upsert. Worst case for VIA is one
 * refresh cycle of staleness before an observation lands.
 */
export function updateGthaPlatformPredictionShadow(ctx: CacheContext, now = Date.now()): void {
	if (!ctx.gtfs) return;
	const routes = new Map(
		ctx.gtfs
			.getRoutes()
			.map((route) => [entityKey({ feedId: route.feed_id, localId: route.route_id }), route] as const),
	);
	const events: PlatformPredictionEvent[] = [];

	for (const instance of ctx.augmented.instancesRec.values()) {
		if (!PLATFORM_PREDICTION_FEED_IDS.has(instance.feed_id) || instance.nonRevenue) continue;
		if (instance.schedule_relationship === TripScheduleRelationship.CANCELED) continue;
		const route = routes.get(entityKey({ feedId: instance.feed_id, localId: instance.route_id }));
		const routeLabel = route?.route_short_name?.trim() || route?.route_long_name?.trim() || instance.route_id;
		const timezone = getFeedTimeZone(ctx.config, instance.feed_id);
		const serviceDayStart = getServiceDayStart(instance.serviceDate, timezone) * 1000;
		const serviceId = instance.trip_number?.trim() || instance.trip_id;

		for (let index = 0; index < instance.stopTimes.length; index++) {
			const stopTime = instance.stopTimes[index];
			if (stopTime.passing || stopTime.scheduled_departure_time == null) continue;
			const stopId = stopTime.scheduled_parent_station_id ?? stopTime.scheduled_stop_id;
			if (!stopId) continue;
			const reportedLocation = stopTime.actual_departure_boarding_locations.find(
				(location) =>
					(location.kind === "track" || location.kind === "platform") && location.confidence !== "inferred",
			);
			const hasAnyLocation = stopTime.actual_departure_boarding_locations.some(
				(location) => location.kind === "track" || location.kind === "platform",
			);
			const observedAt = reportedLocation ? Date.parse(reportedLocation.observed_at) : Number.NaN;
			events.push({
				eventKey: `${instance.instance_id}\0${index}\0departure`,
				feedId: instance.feed_id,
				routeId: instance.route_id,
				routeLabel,
				directionId: instance.direction_id ?? null,
				serviceId,
				stopId,
				dayOfWeek: serviceDayOfWeek(instance.serviceDate),
				scheduledAt: serviceDayStart + stopTime.scheduled_departure_time * 1000,
				availablePlatform:
					hasAnyLocation || stopTime.rt_platform_code_updated || stopTime.scheduled_platform_code != null,
				reportedPlatform: reportedLocation?.value ?? null,
				observedAt: Number.isFinite(observedAt) ? observedAt : null,
			});
		}
	}

	state(ctx).update(events, now);
}

export function getGthaPlatformPredictionDiagnostics(ctx: CacheContext): PlatformPredictionDiagnostics {
	return state(ctx).diagnostics();
}
