import { createHmac } from "node:crypto";

export type ChronosRoute = {
	route_id: number;
	route_type: number | null;
	route_gtfs_id: string | null;
	route_name: string | null;
	route_number?: string | null;
};

export type ChronosRun = {
	run_id: number | null;
	run_ref: string;
	route_id: number | null;
	route_type: number | null;
	final_stop_id: number | null;
	destination_name: string | null;
	status: string | null;
	direction_id: number | null;
	run_sequence?: number | null;
	express_stop_count?: number | null;
	vehicle_position?: unknown | null;
	vehicle_descriptor?: unknown | null;
};

export type ChronosStop = {
	stop_id: number;
	stop_name: string;
	route_type: number | null;
	stop_latitude?: number | null;
	stop_longitude?: number | null;
	stop_suburb?: string | null;
	routes?: ChronosRoute[] | null;
};

export type ChronosDirection = {
	direction_id: number;
	direction_name: string | null;
	route_id: number | null;
	route_type?: number | null;
};

export type ChronosDeparture = {
	stop_id: number;
	route_id: number;
	run_id: number | null;
	run_ref: string;
	direction_id: number | null;
	platform_number: string | null;
	at_platform: boolean;
	scheduled_departure_utc: string;
	estimated_departure_utc: string | null;
	departure_sequence: number | null;
	flags?: string | null;
	skipped_stops?: ChronosStop[] | null;
};

export type ChronosDeparturesResponse = {
	departures: ChronosDeparture[];
	stops: Record<string, ChronosStop>;
	routes: Record<string, ChronosRoute>;
	runs: Record<string, ChronosRun>;
	directions: Record<string, ChronosDirection>;
};

export type ChronosPatternResponse = ChronosDeparturesResponse;

export type ChronosSearchResponse = {
	stops: ChronosStop[];
	routes: ChronosRoute[];
};

export type ChronosDirectionsResponse = {
	directions: ChronosDirection[];
};

export type ChronosPatternOptions = {
	dateUtc: string;
	stopId: number;
	expand?: readonly string[];
};

export type ChronosBulkRouteDirection = {
	direction_name: string;
	route_id: string | number;
	direction_id: number;
};

export type ChronosBulkDepartureRequest = {
	requests: Array<{
		route_directions: ChronosBulkRouteDirection[];
		route_type: 3;
		stop_id: number;
		max_results: number;
		gtfs: false;
	}>;
	date_utc: string;
	look_backwards: boolean;
	include_cancelled: boolean;
	include_geopath: boolean;
	expand: string[];
};

export type ChronosBulkDeparturesResponse = {
	responses?: ChronosDeparturesResponse[];
	departures?: ChronosDeparture[];
	stops?: Record<string, ChronosStop>;
	routes?: Record<string, ChronosRoute>;
	runs?: Record<string, ChronosRun>;
	directions?: Record<string, ChronosDirection>;
};

export function chronosHourlyToken(apiKey: string, date = new Date()): string {
	const hour = date.toISOString().slice(0, 13).replace(/[-T:]/g, "");
	return createHmac("sha1", apiKey).update(hour).digest("hex");
}

async function chronosRequest<T>(
	baseUrl: string,
	apiKey: string,
	path: string,
	init: RequestInit = {},
	timeoutMs = 15_000,
): Promise<T> {
	const url = new URL(path, baseUrl);
	url.searchParams.set("token", chronosHourlyToken(apiKey));
	const response = await fetch(url, {
		...init,
		signal: AbortSignal.timeout(timeoutMs),
		headers: {
			accept: "application/json",
			...init.headers,
		},
	});
	if (!response.ok) throw new Error(`PTV Chronos HTTP ${response.status}`);
	return await response.json() as T;
}

function departureQuery(maxResults: number): URLSearchParams {
	return new URLSearchParams({
		include_cancelled: "true",
		expand: "All",
		max_results: String(maxResults),
	});
}

/** Fetch the app's capped, current departure window for a stop. */
export async function getChronosDepartures(
	baseUrl: string,
	apiKey: string,
	stopId: number,
	maxResults = 30,
	timeoutMs = 15_000,
): Promise<ChronosDeparturesResponse> {
	const query = departureQuery(maxResults);
	return chronosRequest(baseUrl, apiKey, `departures/route_type/3/stop/${stopId}?${query}`, {}, timeoutMs);
}

/** Fetch a bounded directional window beginning at an absolute UTC instant. */
export async function getChronosDirectionalDepartures(
	baseUrl: string,
	apiKey: string,
	stopId: number,
	directionId: number,
	dateUtc: string,
	maxResults = 30,
	timeoutMs = 15_000,
): Promise<ChronosDeparturesResponse> {
	const query = departureQuery(maxResults);
	query.set("direction_id", String(directionId));
	query.set("date_utc", dateUtc);
	return chronosRequest(baseUrl, apiKey, `departures/route_type/3/stop/${stopId}/?${query}`, {}, timeoutMs);
}

export async function getChronosBulkDepartures(
	baseUrl: string,
	apiKey: string,
	request: ChronosBulkDepartureRequest,
	timeoutMs = 15_000,
): Promise<ChronosBulkDeparturesResponse> {
	return chronosRequest(baseUrl, apiKey, "departures", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(request),
	}, timeoutMs);
}

export async function searchChronosStops(
	baseUrl: string,
	apiKey: string,
	searchTerm: string,
	timeoutMs = 15_000,
): Promise<ChronosSearchResponse> {
	const query = new URLSearchParams({
		match_stop_by_gtfs_stop_id: "true",
		include_addresses: "false",
		include_outlets: "false",
	});
	return chronosRequest(baseUrl, apiKey, `search/${encodeURIComponent(searchTerm)}?${query}`, {}, timeoutMs);
}

export async function getChronosDirections(
	baseUrl: string,
	apiKey: string,
	routeId: number,
	timeoutMs = 15_000,
): Promise<ChronosDirectionsResponse> {
	return chronosRequest(baseUrl, apiKey, `directions/route/${routeId}`, {}, timeoutMs);
}

/** Fetch a run pattern with the same service-bound parameters as the official app. */
export async function getChronosRunPattern(
	baseUrl: string,
	apiKey: string,
	runRef: string | number,
	options: ChronosPatternOptions,
	timeoutMs = 15_000,
): Promise<ChronosPatternResponse> {
	const query = new URLSearchParams({
		date_utc: options.dateUtc,
		stop_id: String(options.stopId),
		include_skipped_stops: "true",
		include_geopath: "true",
		include_advertised_interchange: "true",
	});
	for (const expand of options.expand ?? ["all"]) query.append("expand", expand);
	return chronosRequest(
		baseUrl,
		apiKey,
		`pattern/run/${encodeURIComponent(String(runRef))}/route_type/3?${query}`,
		{},
		timeoutMs,
	);
}
