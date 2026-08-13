import type { AugmentedTripInstance } from "../../../utils/augmentedTrip.js";
import type { ChronosDeparture, ChronosDeparturesResponse } from "./chronos.js";

export type ChronosDepartureCandidate = ChronosDeparture;

export type ChronosMatchContext = {
	chronosStopId: number;
	scheduledFirstDepartureUtc: string;
	routeGtfsId: string;
	destination: string | null;
	directionId?: number | null;
};

export function normalizeChronosName(value: string | null | undefined): string {
	return value?.normalize("NFKD").toLowerCase()
		.replace(/^melbourne\s*,\s*/, "")
		.replace(/\b(railway|train|station)\b/g, "")
		.replace(/[^a-z0-9]/g, "") ?? "";
}

export function vlineChronosRouteGtfsId(trip: Pick<AugmentedTripInstance, "trip_id" | "route_id">): string | null {
	if (/^1-[A-Za-z0-9]+$/.test(trip.route_id)) return trip.route_id;
	const tripPrefix = /^0?(1-[A-Za-z0-9]+)--/.exec(trip.trip_id)?.[1];
	return tripPrefix ?? null;
}

export function isChronosRegionalRailRoute(routeGtfsId: string | null | undefined): boolean {
	return /^1-/i.test(routeGtfsId?.trim() ?? "");
}

/**
 * Match only a unique official rail run after checking stop, instant, route,
 * destination and (when known) Chronos direction identity.
 */
export function matchChronosRun(
	trip: Pick<AugmentedTripInstance, "trip_headsign">,
	response: ChronosDeparturesResponse,
	context: ChronosMatchContext,
): string | null {
	const expected = Date.parse(context.scheduledFirstDepartureUtc);
	if (!Number.isFinite(expected) || !isChronosRegionalRailRoute(context.routeGtfsId)) return null;
	const expectedDestination = normalizeChronosName(context.destination ?? trip.trip_headsign);
	const refs = new Set<string>();
	for (const departure of response.departures) {
		if (departure.stop_id !== context.chronosStopId) continue;
		const actual = Date.parse(departure.scheduled_departure_utc);
		if (!Number.isFinite(actual) || Math.abs(actual - expected) > 1_000) continue;
		const route = response.routes[String(departure.route_id)];
		if (!route || !isChronosRegionalRailRoute(route.route_gtfs_id)) continue;
		if (route.route_gtfs_id?.toUpperCase() !== context.routeGtfsId.toUpperCase()) continue;
		if (context.directionId != null && departure.direction_id !== context.directionId) continue;
		const run = response.runs[departure.run_ref] ?? response.runs[String(departure.run_id)];
		if (!run || run.route_id !== departure.route_id || run.run_ref !== departure.run_ref) continue;
		if (expectedDestination && normalizeChronosName(run.destination_name) !== expectedDestination) continue;
		refs.add(departure.run_ref);
	}
	return refs.size === 1 ? refs.values().next().value! : null;
}
