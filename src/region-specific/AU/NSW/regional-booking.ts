import { randomUUID } from "node:crypto";
import { remainingBookingJourney } from "../../../utils/bookingJourney.js";
import { getLocalISOString, serviceTimeToInstant } from "../../../utils/time.js";
import type { CacheContext } from "../../../cache/types.js";
import type { AugmentedTripInstance } from "../../../utils/augmentedTrip.js";
import logger from "../../../utils/logger.js";
import { getPluginState } from "../../../plugins/types.js";
import {
	createVehicleFormation,
	type VehicleBookingAvailability,
	type VehicleBookingFareClass,
	type VehicleBookingAvailabilityStatus,
	type VehicleFormation,
} from "../../../utils/vehicleModel.js";

const DEFAULT_PAGE_URL = "https://transportnsw.info/regional-travel/trip-selection";
const STATION_CACHE_MS = 6 * 60 * 60 * 1000;
const INVENTORY_CACHE_MS = 5 * 60 * 1000;
const MISSING_INVENTORY_CACHE_MS = 60 * 1000;
const INVENTORY_PRUNE_INTERVAL_MS = 60 * 1000;
const EMPTY_RESULT_WARNING_INTERVAL_MS = 15 * 60 * 1000;
const NSW_TRAINLINK_FEED_ID = "nsw-trainlink";
const DEFAULT_STATION_CODES: Readonly<Record<string, string>> = {
	"nsw-trainlink:200060": "SYD",
	"nsw-trainlink:22180": "MEL",
	"nsw-trainlink:40001": "BNE",
};
export const TFNSW_REGIONAL_BOOKING_PLUGIN_ID = "au-nsw-tfnsw-regional-booking";

export type TfnswRegionalBookingOptions = {
	/** The Next.js action identifier observed on the regional trip-selection page. */
	actionId?: string;
	pageUrl?: string;
	requestTimeoutMs?: number;
	/** Explicit feed-stop to booking-code mappings for names that do not match exactly. */
	stationCodes?: Readonly<Record<string, string>>;
};

type RegionalStation = { id: string; name: string };

type RegionalOffer = {
	travelClass: string;
	travelClassDescription: string;
	minimumAvailability: number;
	price: number | null;
	isAccommodationTypeSleeper: boolean;
};

type RegionalLeg = {
	origin: string;
	destination: string;
	startDate: string;
	endDate: string;
	isUnreservedService: boolean;
	service: { carrier: string; lineNumber: string };
};

type RegionalTrip = {
	origin: { id: string; name: string };
	destination: { id: string; name: string };
	legs: RegionalLeg[];
	offers: Record<string, RegionalOffer[]>;
};

type RegionalBookingState = {
	stationCodes: Map<string, string> | null;
	stationCodesExpiresAt: number;
	action: { id: string; expiresAt: number } | null;
	actionInFlight: Promise<string> | null;
	inventory: Map<string, BookingResult & { expiresAt: number }>;
	inFlight: Map<string, Promise<BookingResult>>;
	lastInventoryPruneAt: number;
};

type BookingResult = { availability: VehicleBookingAvailability | null; status: VehicleBookingAvailabilityStatus };

let lastEmptyResultWarningAt = 0;

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function stringValue(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function nonNegativeNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function booleanValue(value: unknown): boolean {
	return value === true;
}

function parseRscRecords(body: string): unknown[] {
	const records: unknown[] = [];
	for (const line of body.split("\n")) {
		const separator = line.indexOf(":");
		if (separator < 1) continue;
		const encoded = line.slice(separator + 1);
		try {
			records.push(JSON.parse(encoded.replaceAll('"$undefined"', "null")));
		} catch {
			// RSC contains module references and text records alongside JSON records.
		}
	}
	return records;
}

function findValue(value: unknown, predicate: (value: unknown) => boolean): unknown | null {
	if (predicate(value)) return value;
	if (!value || typeof value !== "object") return null;
	for (const child of Object.values(value)) {
		const found = findValue(child, predicate);
		if (found !== null) return found;
	}
	return null;
}

function parseStationList(body: string): RegionalStation[] {
	for (const root of parseRscRecords(body)) {
		const value = findValue(
			root,
			(candidate) =>
				Array.isArray(candidate) &&
				candidate.length > 0 &&
				candidate.every((station) => {
					const item = record(station);
					return !!item && typeof item.id === "string" && typeof item.name === "string";
				}),
		);
		if (Array.isArray(value)) return value as RegionalStation[];
	}
	return [];
}

function parseOffer(value: unknown): RegionalOffer | null {
	const item = record(value);
	if (!item) return null;
	const travelClass = stringValue(item.travelClass);
	const minimumAvailability = nonNegativeNumber(item.minimumAvailability);
	if (!travelClass || minimumAvailability == null) return null;
	return {
		travelClass,
		travelClassDescription: stringValue(item.travelClassDescription) ?? travelClass,
		minimumAvailability,
		price: nonNegativeNumber(item.price),
		isAccommodationTypeSleeper: booleanValue(item.isAccommodationTypeSleeper),
	};
}

function parseLeg(value: unknown): RegionalLeg | null {
	const item = record(value);
	const service = record(item?.service);
	if (!item || !service) return null;
	const origin = stringValue(item.origin),
		destination = stringValue(item.destination);
	const startDate = stringValue(item.startDate),
		endDate = stringValue(item.endDate);
	const carrier = stringValue(service.carrier),
		lineNumber = stringValue(service.lineNumber);
	if (!origin || !destination || !startDate || !endDate || !carrier || !lineNumber) return null;
	return {
		origin,
		destination,
		startDate,
		endDate,
		isUnreservedService: booleanValue(item.isUnreservedService),
		service: { carrier, lineNumber },
	};
}

function parseRegionalTrip(value: unknown): RegionalTrip | null {
	const item = record(value);
	const origin = record(item?.origin),
		destination = record(item?.destination);
	const legs = Array.isArray(item?.legs)
		? item.legs.map(parseLeg).filter((leg): leg is RegionalLeg => leg !== null)
		: [];
	const offers = record(item?.offers);
	if (!item || !origin || !destination || !offers || !legs.length || !Object.keys(offers).length) return null;
	const originId = stringValue(origin.id),
		originName = stringValue(origin.name);
	const destinationId = stringValue(destination.id),
		destinationName = stringValue(destination.name);
	if (!originId || !originName || !destinationId || !destinationName) return null;
	const parsedOffers: Record<string, RegionalOffer[]> = {};
	for (const [classCode, value] of Object.entries(offers)) {
		if (!Array.isArray(value)) return null;
		const parsed = value.map(parseOffer);
		if (parsed.some((offer) => offer === null)) return null;
		parsedOffers[classCode] = parsed as RegionalOffer[];
	}
	return {
		origin: { id: originId, name: originName },
		destination: { id: destinationId, name: destinationName },
		legs,
		offers: parsedOffers,
	};
}

export function parseTfnswRegionalSearchResponse(body: string): RegionalTrip[] {
	for (const root of parseRscRecords(body)) {
		const value = findValue(root, (candidate) => {
			const item = record(candidate);
			return Array.isArray(item?.trips);
		});
		const result = record(value);
		if (!result || !Array.isArray(result.trips)) continue;
		const trips = result.trips.map(parseRegionalTrip);
		if (trips.some((trip) => trip === null)) throw new Error("TfNSW regional search returned an invalid trip");
		return trips as RegionalTrip[];
	}
	throw new Error("TfNSW regional search response did not contain trips");
}

function normalizeStationName(value: string): string {
	return value
		.toLowerCase()
		.replace(/\b(railway|rail)\s+station\b/g, "station")
		.replace(/\bstation\b/g, "")
		.replace(/[^a-z0-9]+/g, " ")
		.trim()
		.replace(/\s+/g, " ");
}

function isoDate(serviceDate: string): string | null {
	const match = /^(\d{4})(\d{2})(\d{2})$/.exec(serviceDate);
	return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

function tripStop(trip: AugmentedTripInstance, reverse = false) {
	const stops = reverse ? [...trip.stopTimes].reverse() : trip.stopTimes;
	return stops.find((stop) => stop.scheduled_parent_station_id || stop.scheduled_stop_id) ?? null;
}

function stationKey(feedId: string, localId: string): string {
	return `${feedId}:${localId}`;
}

async function fetchStations(options: TfnswRegionalBookingOptions, timeoutMs: number): Promise<RegionalStation[]> {
	const pageUrl = bookingLandingUrl(options);
	const response = await fetch(pageUrl, {
		signal: AbortSignal.timeout(timeoutMs),
		headers: {
			accept: "text/x-component",
			rsc: "1",
			"next-url": new URL(pageUrl).pathname,
		},
	});
	if (!response.ok) throw new Error(`TfNSW regional station list HTTP ${response.status}`);
	return parseStationList(await response.text());
}

async function stationMap(
	state: RegionalBookingState,
	options: TfnswRegionalBookingOptions,
	timeoutMs: number,
): Promise<Map<string, string>> {
	const now = Date.now();
	if (state.stationCodes && state.stationCodesExpiresAt > now) return state.stationCodes;
	const result = new Map(Object.entries(DEFAULT_STATION_CODES));
	for (const [key, code] of Object.entries(options.stationCodes ?? {})) result.set(key, code);
	const stations = await fetchStations(options, timeoutMs);
	if (stations.length === 0) throw new Error("TfNSW regional station list was empty");
	for (const station of stations) {
		result.set(`name:${normalizeStationName(station.name)}`, station.id);
	}
	state.stationCodes = result;
	state.stationCodesExpiresAt = now + STATION_CACHE_MS;
	return result;
}

async function resolveStationCode(
	trip: AugmentedTripInstance,
	state: RegionalBookingState,
	options: TfnswRegionalBookingOptions,
	first: boolean,
	timeoutMs: number,
): Promise<string | null> {
	const stop = tripStop(trip, !first);
	if (!stop) return null;
	const localId = stop.scheduled_parent_station_id ?? stop.scheduled_stop_id;
	if (!localId) return null;
	const key = stationKey(trip.feed_id, localId);
	const codes = await stationMap(state, options, timeoutMs);
	return (
		codes.get(key) ??
		codes.get(
			`name:${normalizeStationName(stop.scheduled_parent_station?.stop_name ?? stop.scheduled_stop?.stop_name ?? "")}`,
		) ??
		null
	);
}

function normalizedNumber(value: string): string {
	const compact = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
	return compact.replace(/^0+(?=\d)/, "");
}

function scheduledDepartureIdentity(
	trip: AugmentedTripInstance,
	serviceDate: string,
): { date: string; minute: number } | null {
	const seconds = trip.stopTimes
		.map((stop) => stop.scheduled_departure_time ?? stop.scheduled_arrival_time)
		.find((time): time is number => time != null);
	const date = isoDate(serviceDate);
	if (seconds == null || !date) return null;
	const departure = getLocalISOString(new Date(serviceTimeToInstant(serviceDate, seconds, "Australia/Sydney")), "Australia/Sydney");
	return regionalDepartureIdentity(departure);
}

function regionalDepartureIdentity(value: string): { date: string; minute: number } | null {
	const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(value);
	if (!match) return null;
	return { date: match[1], minute: Number(match[2]) * 60 + Number(match[3]) };
}

function bookingServiceNumber(trip: AugmentedTripInstance, ctx: CacheContext): string | null {
	const route = ctx.gtfs?.getRoutes({ feed_id: trip.feed_id, route_id: trip.route_id })[0]?.route_short_name?.trim();
	// TrainLink's interstate booking codes include a 6 prefix (ST21 becomes 621).
	const interstate = /^ST(\d{2})$/i.exec(route ?? trip.trip_number ?? "");
	return interstate ? `6${interstate[1]}` : route ?? null;
}

function matchesTrip(
	candidate: RegionalTrip,
	trip: AugmentedTripInstance,
	originCode: string,
	destinationCode: string,
	serviceDate: string,
	serviceNumber: string | null,
): RegionalLeg | null {
	if (candidate.origin.id !== originCode || candidate.destination.id !== destinationCode) return null;
	const wantedDeparture = scheduledDepartureIdentity(trip, serviceDate);
	if (!wantedDeparture) return null;
	// Whole-journey offers cannot be attributed to one train in a connecting itinerary.
	if (candidate.legs.length !== 1) return null;
	return (
		candidate.legs.find((leg) => {
			const departure = regionalDepartureIdentity(leg.startDate);
			return (
				leg.service.carrier.toLowerCase() === "nsw trainlink" &&
				(!serviceNumber || normalizedNumber(leg.service.lineNumber) === normalizedNumber(serviceNumber)) &&
				departure?.date === wantedDeparture.date &&
				Math.abs(departure.minute - wantedDeparture.minute) <= (serviceNumber ? 5 : 0)
			);
		}) ?? null
	);
}

function bookingLandingUrl(options: TfnswRegionalBookingOptions): string {
	const url = new URL(options.pageUrl ?? DEFAULT_PAGE_URL);
	url.pathname = url.pathname.replace(/\/trip-selection\/?$/, "");
	url.search = "";
	return url.toString();
}

/** Next server-action IDs change at deployment. Discover the public getTrips reference. */
async function bookingAction(state: RegionalBookingState, options: TfnswRegionalBookingOptions, timeoutMs: number): Promise<string> {
	if (options.actionId) return options.actionId;
	if (state.action && state.action.expiresAt > Date.now()) return state.action.id;
	if (state.actionInFlight) return state.actionInFlight;
	const request = (async () => {
		const pageUrl = bookingLandingUrl(options);
		const page = await fetch(pageUrl, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "text/html" } });
		if (!page.ok) throw new Error(`TfNSW regional booking page HTTP ${page.status}`);
		const scripts = [...(await page.text()).matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/g)]
			.map((match) => new URL(match[1], pageUrl))
			.filter((url) => url.origin === new URL(pageUrl).origin && url.pathname.startsWith("/_next/static/chunks/"));
		let cursor = 0, action: string | null = null;
		const signal = AbortSignal.timeout(timeoutMs);
		await Promise.all(Array.from({ length: Math.min(4, scripts.length) }, async () => {
			while (!action && cursor < scripts.length && !signal.aborted) {
				const url = scripts[cursor++];
				try {
					const response = await fetch(url, { signal });
					if (!response.ok) continue;
					const match = /createServerReference\)\(\s*["']([a-f0-9]{40,64})["'][\s\S]{0,200}?["']getTrips["']\)/.exec(await response.text());
					if (match) action = match[1];
				} catch { /* Another public chunk may contain the action. */ }
			}
		}));
		if (!action) throw new Error("TfNSW regional booking action was not found");
		state.action = { id: action, expiresAt: Date.now() + STATION_CACHE_MS };
		return action;
	})();
	state.actionInFlight = request;
	try { return await request; }
	finally { state.actionInFlight = null; }
}

function offersForTrip(trip: RegionalTrip): VehicleBookingFareClass[] {
	return Object.entries(trip.offers).flatMap(([classCode, offers]) =>
		offers.map((offer) => ({
			code: offer.travelClass || classCode,
			label: offer.travelClassDescription,
			minimumAvailability: offer.minimumAvailability,
			price: offer.price,
			isSleeper: offer.isAccommodationTypeSleeper,
		})),
	);
}

function warnEmptySearchResult(trip: AugmentedTripInstance, serviceDate: string, resultCount: number): void {
	const now = Date.now();
	if (now - lastEmptyResultWarningAt < EMPTY_RESULT_WARNING_INTERVAL_MS) return;
	lastEmptyResultWarningAt = now;
	logger.warn(
		`TfNSW regional booking returned no matching service for ${trip.trip_number} on ${serviceDate} (${resultCount} result(s)).`,
		{
			module: "TfNSW regional booking",
			function: "queryAvailability",
		},
	);
}

async function queryAvailability(
	trip: AugmentedTripInstance,
	ctx: CacheContext,
	options: TfnswRegionalBookingOptions,
	originCode: string,
	destinationCode: string,
	serviceDate: string,
	state: RegionalBookingState,
): Promise<BookingResult> {
	const pageUrl = options.pageUrl ?? DEFAULT_PAGE_URL;
	const timeoutMs = options.requestTimeoutMs ?? ctx.config.requestTimeoutMs;
	const search = async () => fetch(pageUrl, {
		method: "POST",
		signal: AbortSignal.timeout(options.requestTimeoutMs ?? ctx.config.requestTimeoutMs),
		headers: {
			accept: "text/x-component",
			"next-action": await bookingAction(state, options, timeoutMs),
			"content-type": "text/plain;charset=UTF-8",
			origin: new URL(pageUrl).origin,
		},
		body: JSON.stringify([
			{
				id: randomUUID(),
				origin: originCode,
				destination: destinationCode,
				departingDateTime: `${scheduledDepartureIdentity(trip, serviceDate)?.date}T00:00:00`,
				passengers: [{ externalRef: randomUUID(), age: "$undefined", prmNeeds: "$undefined" }],
			},
		]),
	});
	let response = await search();
	if (response.status === 404 && !options.actionId) {
		state.action = null;
		response = await search();
	}
	if (!response.ok) throw new Error(`TfNSW regional search HTTP ${response.status}`);
	const regionalTrips = parseTfnswRegionalSearchResponse(await response.text());
	const serviceNumber = bookingServiceNumber(trip, ctx);
	const candidate = regionalTrips
		.map((regionalTrip) => ({
			regionalTrip,
			leg: matchesTrip(regionalTrip, trip, originCode, destinationCode, serviceDate, serviceNumber),
		}))
		.filter((match): match is { regionalTrip: RegionalTrip; leg: RegionalLeg } => match.leg !== null);
	if (candidate.length !== 1) {
		warnEmptySearchResult(trip, serviceDate, regionalTrips.length);
		return { availability: null, status: "no-match" };
	}
	const fareClasses = offersForTrip(candidate[0].regionalTrip);
	// The official client treats a matched trip with no positive offers as fully booked.
	const soldOut = fareClasses.length === 0 || fareClasses.every((fare) => fare.minimumAvailability === 0);
	return { status: soldOut ? "sold-out" : "available", availability: {
		reservedCarriages: [],
		reservedSeatsAvailable: null,
		unreservedTicketsAvailable: null,
		fareClasses,
		reservationAvailable: !soldOut,
		reservationRequired: !candidate[0].leg.isUnreservedService,
		seatMapAvailable: false,
		journeyUrl: `${pageUrl}?$=numAdults:1&tripPlans@$origin$value=${encodeURIComponent(originCode)}&inputValue=${encodeURIComponent(candidate[0].regionalTrip.origin.name)};&destination$value=${encodeURIComponent(destinationCode)}&inputValue=${encodeURIComponent(candidate[0].regionalTrip.destination.name)};&tripDates$type=oneWay&departing=${scheduledDepartureIdentity(trip, serviceDate)?.date}&returning=;;`,
		source: "Transport for NSW regional booking",
		observedAt: new Date().toISOString(),
		timeZone: "Australia/Sydney",
		journey: { origin: candidate[0].regionalTrip.origin.name, destination: candidate[0].regionalTrip.destination.name },
	} };
}

function getState(ctx: CacheContext): RegionalBookingState {
	return getPluginState(ctx, TFNSW_REGIONAL_BOOKING_PLUGIN_ID, () => ({
		stationCodes: null,
		stationCodesExpiresAt: 0,
		action: null,
		actionInFlight: null,
		inventory: new Map(),
		inFlight: new Map(),
		lastInventoryPruneAt: 0,
	}));
}

function pruneExpiredInventory(state: RegionalBookingState, now: number): void {
	if (now - state.lastInventoryPruneAt < INVENTORY_PRUNE_INTERVAL_MS) return;
	for (const [key, entry] of state.inventory) {
		if (entry.expiresAt <= now) state.inventory.delete(key);
	}
	state.lastInventoryPruneAt = now;
}

function formationFromAvailability(
	trip: AugmentedTripInstance,
	availability: VehicleBookingAvailability | null,
	status: VehicleBookingAvailabilityStatus = availability ? "available" : "unavailable",
): VehicleFormation | null {
	return createVehicleFormation(trip, null, {
		source: availability?.source ?? "Transport for NSW regional booking",
		observedAt: availability?.observedAt ?? null,
		bookingAvailability: availability,
		bookingAvailabilityStatus: status,
	});
}

export const _test = {
	matchesTrip,
	formationFromAvailability,
};

export async function getTfnswRegionalBookingFormation(
	trip: AugmentedTripInstance,
	ctx: CacheContext,
	options: TfnswRegionalBookingOptions = {},
): Promise<VehicleFormation | null> {
	if (trip.feed_id !== NSW_TRAINLINK_FEED_ID) return null;
	try { return await regionalBookingFormation(trip, ctx, options); }
	catch (error) {
		logger.warn(error instanceof Error ? error.message : "TfNSW regional booking check failed", {
			module: "TfNSW regional booking", function: "getTfnswRegionalBookingFormation",
		});
		return formationFromAvailability(trip, null, "error");
	}
}

async function regionalBookingFormation(trip: AugmentedTripInstance, ctx: CacheContext, options: TfnswRegionalBookingOptions,
	deadline = Date.now() + (options.requestTimeoutMs ?? ctx.config.requestTimeoutMs)): Promise<VehicleFormation | null> {
	const journey = remainingBookingJourney(trip, "Australia/Sydney");
	if (!journey) return formationFromAvailability(trip, null, "closed");
	const timeoutMs = options.requestTimeoutMs ?? ctx.config.requestTimeoutMs;
	const state = getState(ctx);
	const now = Date.now();
	pruneExpiredInventory(state, now);
	const originCode = await resolveStationCode(journey, state, options, true, timeoutMs);
	const destinationCode = await resolveStationCode(journey, state, options, false, timeoutMs);
	const serviceDate = trip.serviceDate;
	if (!originCode || !destinationCode || !isoDate(serviceDate)) return formationFromAvailability(trip, null, "unsupported");
	const renderResult = async (result: BookingResult): Promise<VehicleFormation | null> => {
		// Near-departure stations may be omitted from online search. Check later pickup
		// stations before reporting no match; every returned count names its actual leg.
		if (result.status === "no-match" && Date.now() < deadline) {
			const following = remainingBookingJourney({ ...journey, stopTimes: journey.stopTimes.slice(1) }, "Australia/Sydney");
			if (following) return regionalBookingFormation(following, ctx, options, deadline);
		}
		return formationFromAvailability(trip, result.availability, result.status);
	};
	const key = `${trip.instance_id}\0${originCode}\0${destinationCode}`;
	const cached = state.inventory.get(key);
	if (cached && cached.expiresAt > now) return renderResult(cached);
	const active = state.inFlight.get(key);
	if (active) {
		const result = await active;
		return renderResult(result);
	}
	const request = queryAvailability(journey, ctx, { ...options, requestTimeoutMs: Math.max(1, deadline - Date.now()) }, originCode, destinationCode, serviceDate, state)
		.then((result) => {
			state.inventory.set(key, {
				...result,
				expiresAt: Date.now() + (result.availability ? INVENTORY_CACHE_MS : MISSING_INVENTORY_CACHE_MS),
			});
			return result;
		});
	state.inFlight.set(key, request);
	try {
		const result = await request;
		return renderResult(result);
	} finally {
		state.inFlight.delete(key);
	}
}
