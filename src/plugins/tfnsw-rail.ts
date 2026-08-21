import type { TransitPlugin } from "./types.js";

const SYDNEY_TRAINS_FEED_ID = "nsw-sydney-trains";
const NSW_TRAINLINK_FEED_ID = "nsw-trainlink";

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
	isNonRevenueRoute: (route) =>
		route.feed_id === SYDNEY_TRAINS_FEED_ID && route.route_id.startsWith("RTTA_"),
};
