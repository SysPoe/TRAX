import { CacheContext, getAugmentedTripInstance } from "../../../cache/index.js";
import { loadDataFile } from "../../../utils/fs.js";
import logger from "../../../utils/logger.js";
import { entityKey } from "../../../identity.js";
import { getPluginState } from "../../../plugins/types.js";

// --- Configuration & Constants ---

const TOKEN_URL = "https://api.reservia.viarail.ca/auth/token";
const BOOKING_URL = "https://api.reservia.viarail.ca/booking";
const LAYOUT_URL = "https://api.reservia.viarail.ca/inventory/carriage-layout";
const Referer = "https://reservia.viarail.ca/";

const MINUTES = 60 * 1000;
const TOKEN_SAFETY_MS = 1 * MINUTES;
const BOOKING_CACHE_MS = 10 * MINUTES;
const LAYOUT_CACHE_MS = 5 * MINUTES;
const CONSIST_CACHE_MS = 24 * 60 * MINUTES;
const REQUEST_TIMEOUT_MS = 15_000;

// --- Types & Interfaces ---

interface TokenRes {
	access_token: string;
	expires_in: number;
	token_type: string;
}

type ViaBookingFare = {
	leg: {
		service_schedule_date: string;
		service_name: string;
		service_identifier: string;
	};
	tariffCode: string;
};

/** Pick an actually offered fare instead of assuming that Escape inventory is available. */
export function selectViaBookingFare(orientation: any): ViaBookingFare | null {
	const routes = orientation?.data?.offer?.travels?.[0]?.routes;
	if (!Array.isArray(routes)) return null;
	for (const route of routes) {
		const leg = route?.legs?.[0];
		if (!leg?.service_schedule_date || !leg?.service_name || !leg?.service_identifier) continue;
		const items = Array.isArray(route?.bundles)
			? route.bundles.flatMap((bundle: any) => (Array.isArray(bundle?.items) ? bundle.items : []))
			: [];
		const selectable = items.find((item: any) => item?.seat_selection_status === "SEAT_SELECTION_AVAILABLE") ?? items[0];
		const fare = selectable?.passenger_fares?.find((candidate: any) => candidate?.passenger_id === "passenger_1")
			?? selectable?.passenger_fares?.[0];
		if (typeof fare?.tariff_code === "string" && fare.tariff_code) {
			return { leg, tariffCode: fare.tariff_code };
		}
	}
	return null;
}

export interface CarriageLayoutRes {
	carriageLayout: CarriageLayout;
	seatAllocations: Record<string, any>;
	scheduleAgent: any | null;
	products: CarriageProducts;
}

export interface CarriageLayout {
	reversed: boolean;
	carriages: Carriage[];
	seat_properties: SeatProperty[];
	stations_information: any[];
}

export interface Carriage {
	seats: CarriageSeat[];
	carriage_name: string;
	carriage_type: string;
	carriage_number: string;
	sequence_number: number;
	template: string;
	reversed: boolean;
	blocked: boolean;
	seat_width: number;
	seat_height: number;
	accept_manual_allocation: boolean;
	accept_auto_allocation: boolean;
	floorplan_dimensions: {
		width: number;
		height: number;
	};
	hide_on_floorplan: boolean;
	carriage_code: string;
}

export interface CarriageSeat {
	seat_number: string;
	sequence_number: number;
	x_pos: number;
	y_pos: number;
	row_number: number;
	row_position: number;
	available: boolean;
	allocated: boolean;
	blocked: boolean;
	inventory_class: string;
	blocked_passengers: any[];
	reversed: boolean;
	property_codes: string[];
}

export interface SeatProperty {
	code: string;
	description: string;
	available_seats: number;
	seat_selection_addon_required: boolean;
	selectable: boolean;
	compartment_exclusivity: boolean;
}

export interface CarriageProducts {
	passengers: any[];
	currency: string;
	items: any[];
	product_families: any[];
	fares: any[];
	segments: CarriageSegment[];
	products: any[];
	tariffs: any[];
}

export interface CarriageSegment {
	origin: string;
	departure_date: string;
	destination: string;
	id: string;
	direction: string;
}

// --- State & Caching ---

type ViaConsistState = {
	cachedToken: { token: string; expiry: number } | null;
	cachedBooking: { booking: any; timestamp: number } | null;
	layoutCache: Map<string, { data: CarriageLayoutRes; timestamp: number }>;
	consistCache: Map<string, { data: CarriageLayoutRes; timestamp: number }>;
	consistInFlight: Map<string, Promise<CarriageLayoutRes | null>>;
	tripsData: Record<string, { from: string; to: string; stations: { station: string; code: string }[] }> | null;
};

function getState(ctx: CacheContext): ViaConsistState {
	return getPluginState(ctx, "ca-via:consist", () => ({
		cachedToken: null, cachedBooking: null, layoutCache: new Map(), consistCache: new Map(), consistInFlight: new Map(), tripsData: null,
	}));
}

function getTripsData(state: ViaConsistState) {
	if (!state.tripsData) {
		state.tripsData = JSON.parse(loadDataFile("viatrips.json"));
	}
	return state.tripsData!;
}

// --- API Functions ---

async function getToken(state: ViaConsistState): Promise<string> {
	if (state.cachedToken && state.cachedToken.expiry > Date.now() + TOKEN_SAFETY_MS) {
		return state.cachedToken.token;
	}

	logger.debug("Fetching new VIA Reservia token...", { module: "VIA", function: "getToken" });
	const res = await fetch(TOKEN_URL, {
		headers: {
			accept: "application/json, text/plain, */*",
			"content-type": "application/json",
			Referer,
		},
		body: '{"grant_type":"https://com.sqills.s3.oauth.public","code":"B2C_WEB_BOOKING"}',
		method: "POST",
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});

	if (!res.ok) throw new Error(`Failed to get VIA token: HTTP ${res.status}`);
	const data: TokenRes = await res.json();
	state.cachedToken = {
		token: data.access_token,
		expiry: Date.now() + data.expires_in * 1000,
	};
	return data.access_token;
}

async function getDummySegment(token: string): Promise<any> {
	const date = new Date();
	date.setDate(date.getDate() + 1);
	const res = await fetch("https://api.reservia.viarail.ca/orientation/journey", {
		headers: {
			accept: "application/json, text/plain, */*",
			"accept-language": "en-CA",
			authorization: "Bearer " + token,
			"cache-control": "no-cache",
			"content-type": "application/json",
			pragma: "no-cache",
			"sec-ch-ua": '"Not(A:Brand";v="8", "Chromium";v="144", "Microsoft Edge";v="144"',
			"sec-ch-ua-mobile": "?0",
			"sec-ch-ua-platform": '"Windows"',
			"sec-fetch-dest": "empty",
			"sec-fetch-mode": "cors",
			"sec-fetch-site": "same-site",
			"sec-gpc": "1",
		},
		referrer: "https://reservia.viarail.ca/",
		body: JSON.stringify({
			currency: "CAD",
			passengers: [{ id: "passenger_1", type: "ADT" }],
			travels: [
				{
					origin: "TRTO",
					destination: "OTTW",
					departure: date.toISOString().slice(0, 10),
					direction: "outbound",
					product_types: ["ST"],
				},
			],
		}),
		method: "POST",
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	if (!res.ok) throw new Error(`Failed to find a VIA booking segment: HTTP ${res.status}`);
	const json = await res.json();
	const selected = selectViaBookingFare(json);
	if (!selected) throw new Error("VIA orientation returned no bookable fare");
	const { leg, tariffCode } = selected;
	return {
		origin: "TRTO",
		destination: "OTTW",
		direction: "outbound",
		start_validity_date: leg.service_schedule_date.slice(0, 10),
		service_name: leg.service_name,
		service_identifier: leg.service_identifier,
		items: [{ tariff_code: tariffCode, passenger_id: "passenger_1" }],
	};
}

async function getBooking(token: string, state: ViaConsistState): Promise<any> {
	if (state.cachedBooking && state.cachedBooking.timestamp > Date.now() - BOOKING_CACHE_MS) {
		return state.cachedBooking.booking;
	}

	logger.debug("Creating dummy VIA booking for layout requests...", { module: "VIA", function: "getBooking" });

	// Minimal booking needed for the layout API.
	const res = await fetch(BOOKING_URL, {
		headers: {
			accept: "application/json, text/plain, */*",
			authorization: "Bearer " + token,
			"content-type": "application/json",
			Referer,
		},
		body: JSON.stringify({
			segments: [await getDummySegment(token)],
			passengers: [
				{ id: "passenger_1", type: "ADT", travel_passes: [], discount_cards: [], disability_type: "ND" },
			],
		}),
		method: "POST",
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});

	if (!res.ok) {
		const errText = await res.text();
		logger.error(`Failed to create VIA booking: ${res.status} ${errText}`, {
			module: "VIA",
			function: "getBooking",
		});
		throw new Error(`Failed to create VIA booking: HTTP ${res.status}`);
	}

	const data = await res.json();
	const booking = {
		booking_number: data.data.booking.booking_number,
		currency: "CAD",
		passengers: data.data.booking.passengers.map((p: any) => ({
			...p,
			country_of_residence: "CA",
			protect_privacy: true,
			isAdded: true,
			canChangeName: true,
			canHavePet: true,
		})),
	};

	state.cachedBooking = { booking, timestamp: Date.now() };
	return booking;
}

/**
 * Fetches the carriage layout for a specific VIA trip.
 * @param tripNumber The VIA trip number (e.g. 50)
 * @param date ISO Date (YYYY-MM-DD or YYYYMMDD)
 * @param fromStation VIA station code (e.g. TRTO)
 * @param toStation VIA station code (e.g. MTRL)
 */
export async function getCarriageLayout(
	ctx: CacheContext,
	tripNumber: string | number,
	date: string,
	fromStation?: string,
	toStation?: string,
): Promise<CarriageLayoutRes> {
	const state = getState(ctx);
	const tripNumStr = tripNumber.toString();
	if (/^\d{8}$/.test(date)) {
		date = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
	}

	// Try to find stations if not provided
	if (!fromStation || !toStation) {
		const data = getTripsData(state);
		const tripEntry = data[tripNumStr];
		if (!tripEntry) throw new Error(`Station codes for trip ${tripNumStr} not found and not provided.`);
		fromStation = fromStation || tripEntry.stations[0].code;
		toStation = toStation || tripEntry.stations.at(-1)?.code;
	}

	const cacheKey = `${tripNumStr}|${date}|${fromStation}|${toStation}`;
	const cached = state.layoutCache.get(cacheKey);
	if (cached && cached.timestamp > Date.now() - LAYOUT_CACHE_MS) {
		return cached.data;
	}

	const token = await getToken(state);
	const booking = await getBooking(token, state);

	logger.debug(`Fetching carriage layout for VIA ${tripNumStr} on ${date}...`, {
		module: "VIA",
		function: "getCarriageLayout",
	});
	let res = await fetch(LAYOUT_URL, {
		headers: {
			accept: "application/json, text/plain, */*",
			authorization: "Bearer " + token,
			"content-type": "application/json",
			Referer,
		},
		body: JSON.stringify({
			from_station: fromStation,
			to_station: toStation,
			date,
			service_name: "VIA" + tripNumStr,
			booking,
			segment: {
				id: "segment_1",
				destination_station: toStation,
				origin_station: fromStation,
				service_name: "VIA" + tripNumStr,
				start_validity_date: date,
				start_validity_time: "00:00:00",
			},
			comfort_zones: ["ESC"],
			product_code: "ESC",
		}),
		method: "POST",
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});

	if (!res.ok) {
		const errText = await res.text();
		logger.warn(
			`Failed to fetch carriage layout (initial): ${res.status} ${errText}. Retrying with swapped stations...`,
			{
				module: "VIA",
				function: "getCarriageLayout",
			},
		);

		// Retry with swapped stations (sometimes the API is picky about direction)
		res = await fetch(LAYOUT_URL, {
			headers: {
				accept: "application/json, text/plain, */*",
				authorization: "Bearer " + token,
				"content-type": "application/json",
				Referer,
			},
			body: JSON.stringify({
				from_station: toStation,
				to_station: fromStation,
				date,
				service_name: "VIA" + tripNumStr,
				booking,
				segment: {
					id: "segment_1",
					destination_station: fromStation,
					origin_station: toStation,
					service_name: "VIA" + tripNumStr,
					start_validity_date: date,
					start_validity_time: "00:00:00",
				},
				comfort_zones: ["ESC"],
				product_code: "ESC",
			}),
			method: "POST",
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});

		if (!res.ok) {
			const errText = await res.text();
			throw new Error(`Failed to fetch carriage layout after retry: ${res.status} ${errText}`);
		}
	}

	const data: CarriageLayoutRes = await res.json();
	state.layoutCache.set(cacheKey, { data, timestamp: Date.now() });
	return data;
}

/**
 * Gets the VIA consist (car sequence) for a given instance_id.
 * Matches trip trip_number to tripNumber.
 */
export async function getViaConsist(instance_id: string, ctx: CacheContext): Promise<CarriageLayoutRes | null> {
	const state = getState(ctx);
	const cached = state.consistCache.get(instance_id);
	if (cached && cached.timestamp > Date.now() - CONSIST_CACHE_MS) return cached.data;
	const inFlight = state.consistInFlight.get(instance_id);
	if (inFlight) return inFlight;

	const request = loadViaConsist(instance_id, ctx, state);
	state.consistInFlight.set(instance_id, request);
	try {
		return await request;
	} finally {
		state.consistInFlight.delete(instance_id);
	}
}

async function loadViaConsist(
	instance_id: string,
	ctx: CacheContext,
	state: ViaConsistState,
): Promise<CarriageLayoutRes | null> {
	try {
		const instance = getAugmentedTripInstance(ctx, instance_id);
		if (!instance) {
			logger.warn(`Instance ${instance_id} not found.`, { module: "VIA", function: "getViaConsist" });
			return null;
		}

		if (instance.feed_id !== "via") {
			logger.warn(`Instance ${instance_id} is not from VIA (feed_id: ${instance.feed_id}).`, {
				module: "VIA",
				function: "getViaConsist",
			});
			return null;
		}

		const tripNumber = instance.trip_number;
		const serviceDate = instance.serviceDate;

		if (!tripNumber) {
			logger.warn(`Trip number not found for instance ${instance_id}.`, {
				module: "VIA",
				function: "getViaConsist",
			});
			return null;
		}

		// Determine VIA station codes from the first and last stops
		const firstStop = instance.stopTimes[0];
		const lastStop = instance.stopTimes.at(-1);

		if (!firstStop || !lastStop) return null;

		const getViaCode = (stopId: string): string | null => {
			const stop = ctx.augmented.stopsRec.get(entityKey({ feedId: instance.feed_id, localId: stopId }));
			if (!stop) return null;
			return stop.stop_code || null;
		};

		const fromStation = getViaCode(firstStop.scheduled_stop_id || "");
		const toStation = getViaCode(lastStop.scheduled_stop_id || "");

		const layout = await getCarriageLayout(
			ctx,
			tripNumber,
			serviceDate,
			fromStation || undefined,
			toStation || undefined,
		);

		if (!layout || !layout.carriageLayout || !layout.carriageLayout.carriages) {
			return null;
		}

		state.consistCache.set(instance_id, { data: layout, timestamp: Date.now() });
		return layout;
	} catch (e) {
		logger.error(`Error in getViaConsist for ${instance_id}: ${(e as any).message ?? e}`, {
			module: "VIA",
			function: "getViaConsist",
		});
		return null;
	}
}
