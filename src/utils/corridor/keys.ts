/** Version of the physical-route resolver cache format. */
export const CORRIDOR_RESOLVER_VERSION = 1;

/** Build a collision-safe key for an entity in a feed namespace. */
export function qualifiedKey(feedId: string, localId: string): string {
	return `${feedId.length}:${feedId}${localId}`;
}

/** Build a qualified route and direction index key. */
export function qualifiedRouteDirectionKey(
	feedId: string,
	routeId: string | null,
	direction: string | number | null,
): string {
	return qualifiedKey(feedId, `${routeId ?? "*"}\0${direction ?? "*"}`);
}

/** Build a stable key for one journey's physical-route decision. */
export function corridorJourneyKey(input: {
	sourceId: string;
	feedId: string;
	tripId: string;
	routeId: string | null;
	direction: string | number | null;
	shapeId: string | null;
	serviceDate: string | null;
	anchors: readonly {
		id: string;
		stationId: string | null;
		name?: string;
		lat?: number | null;
		lon?: number | null;
		sequence: number;
		shapeDistTraveled?: number | null;
		scheduled: boolean;
	}[];
	geometryFeedIds: readonly string[];
	configVersion: string;
}): string {
	return JSON.stringify([
		CORRIDOR_RESOLVER_VERSION,
		qualifiedKey(input.feedId, input.sourceId),
		qualifiedKey(input.feedId, input.tripId),
		qualifiedKey(input.feedId, input.shapeId ?? "*"),
		qualifiedRouteDirectionKey(input.feedId, input.routeId, input.direction),
		input.serviceDate,
		[...input.geometryFeedIds],
		input.configVersion,
		input.anchors.map((anchor) => [
			anchor.id,
			anchor.stationId,
			anchor.name ?? null,
			anchor.lat ?? null,
			anchor.lon ?? null,
			anchor.sequence,
			anchor.shapeDistTraveled ?? null,
			anchor.scheduled,
		]),
	]);
}
