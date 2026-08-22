import { randomUUID } from "node:crypto";
import type { CacheContext } from "../../../cache/types.js";
import type { AugmentedTripInstance } from "../../../utils/augmentedTrip.js";
import logger from "../../../utils/logger.js";
import { getPluginState } from "../../../plugins/types.js";
import {
	createVehicleFormation,
	type VehicleBookingAvailability,
	type VehicleBookingFareClass,
	type VehicleFormation,
} from "../../../utils/vehicleModel.js";

const DEFAULT_PAGE_URL = "https://transportnsw.info/regional-travel/trip-selection";
const DEFAULT_ACTION_ID = "7f0d1acc145b1083b6d4195f42bc401b36df4427c9";
const STATION_CACHE_MS = 6 * 60 * 60 * 1000;
const STATION_RETRY_MS = 5 * 60 * 1000;
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
	inventory: Map<string, { availability: VehicleBookingAvailability | null; expiresAt: number }>;
	inFlight: Map<string, Promise<VehicleBookingAvailability | null>>;
	lastInventoryPruneAt: number;
};

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
	if (!item || !origin || !destination || !offers || !legs.length) return null;
	const originId = stringValue(origin.id),
		originName = stringValue(origin.name);
	const destinationId = stringValue(destination.id),
		destinationName = stringValue(destination.name);
	if (!originId || !originName || !destinationId || !destinationName) return null;
	const parsedOffers: Record<string, RegionalOffer[]> = {};
	for (const [classCode, value] of Object.entries(offers)) {
		if (!Array.isArray(value)) continue;
		parsedOffers[classCode] = value.map(parseOffer).filter((offer): offer is RegionalOffer => offer !== null);
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
		return result.trips.map(parseRegionalTrip).filter((trip): trip is RegionalTrip => trip !== null);
	}
	return [];
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
	const pageUrl = options.pageUrl ?? DEFAULT_PAGE_URL;
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
	let cacheDuration = STATION_CACHE_MS;
	try {
		const stations = await fetchStations(options, timeoutMs);
		if (stations.length === 0) throw new Error("TfNSW regional station list was empty");
		for (const station of stations) {
			result.set(`name:${normalizeStationName(station.name)}`, station.id);
		}
	} catch (error) {
		cacheDuration = STATION_RETRY_MS;
		const message = error instanceof Error ? error.message : String(error);
		logger.warn(`TfNSW regional station list unavailable: ${message}. Retrying soon.`, {
			module: "TfNSW regional booking",
			function: "stationMap",
		});
	}
	state.stationCodes = result;
	state.stationCodesExpiresAt = now + cacheDuration;
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
	const dayOffset = Math.floor(seconds / 86_400);
	const minute = Math.floor((((seconds % 86_400) + 86_400) % 86_400) / 60);
	const [year, month, day] = date.split("-").map(Number);
	const serviceDay = new Date(Date.UTC(year, month - 1, day + dayOffset));
	return { date: serviceDay.toISOString().slice(0, 10), minute };
}

function regionalDepartureIdentity(value: string): { date: string; minute: number } | null {
	const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(value);
	if (!match) return null;
	return { date: match[1], minute: Number(match[2]) * 60 + Number(match[3]) };
}

function bookingServiceNumber(trip: AugmentedTripInstance, ctx: CacheContext): string | null {
	return ctx.gtfs?.getRoutes({ feed_id: trip.feed_id, route_id: trip.route_id })[0]?.route_short_name?.trim() ?? null;
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
	return (
		candidate.legs.find((leg) => {
			const departure = regionalDepartureIdentity(leg.startDate);
			return (
				leg.service.carrier.toLowerCase() === "nsw trainlink" &&
				(!serviceNumber || normalizedNumber(leg.service.lineNumber) === normalizedNumber(serviceNumber)) &&
				departure?.date === wantedDeparture.date &&
				departure.minute === wantedDeparture.minute
			);
		}) ?? null
	);
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
): Promise<VehicleBookingAvailability | null> {
	const pageUrl = options.pageUrl ?? DEFAULT_PAGE_URL;
	const response = await fetch(pageUrl, {
		method: "POST",
		signal: AbortSignal.timeout(options.requestTimeoutMs ?? ctx.config.requestTimeoutMs),
		headers: {
			accept: "text/x-component",
			"next-action": options.actionId ?? DEFAULT_ACTION_ID,
			"content-type": "text/plain;charset=UTF-8",
			origin: new URL(pageUrl).origin,
		},
		body: JSON.stringify([
			{
				id: randomUUID(),
				origin: originCode,
				destination: destinationCode,
				departingDateTime: `${isoDate(serviceDate)}T00:00:00`,
				passengers: [{ externalRef: randomUUID(), age: "$undefined", prmNeeds: "$undefined" }],
			},
		]),
	});
	if (!response.ok) throw new Error(`TfNSW regional search HTTP ${response.status}`);
	const regionalTrips = parseTfnswRegionalSearchResponse(await response.text());
	const serviceNumber = bookingServiceNumber(trip, ctx);
	const candidate = regionalTrips
		.map((regionalTrip) => ({
			regionalTrip,
			leg: matchesTrip(regionalTrip, trip, originCode, destinationCode, serviceDate, serviceNumber),
		}))
		.find((match): match is { regionalTrip: RegionalTrip; leg: RegionalLeg } => match.leg !== null);
	if (!candidate) {
		warnEmptySearchResult(trip, serviceDate, regionalTrips.length);
		return null;
	}
	const fareClasses = offersForTrip(candidate.regionalTrip);
	if (!fareClasses.length) return null;
	return {
		reservedCarriages: [],
		reservedSeatsAvailable: null,
		unreservedTicketsAvailable: null,
		fareClasses,
		reservationAvailable: true,
		reservationRequired: !candidate.leg.isUnreservedService,
		seatMapAvailable: false,
		journeyUrl: pageUrl,
		source: "Transport for NSW regional booking",
		observedAt: new Date().toISOString(),
		timeZone: "Australia/Sydney",
	};
}

function getState(ctx: CacheContext): RegionalBookingState {
	return getPluginState(ctx, TFNSW_REGIONAL_BOOKING_PLUGIN_ID, () => ({
		stationCodes: null,
		stationCodesExpiresAt: 0,
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
): VehicleFormation | null {
	return createVehicleFormation(trip, null, {
		source: availability?.source ?? "Transport for NSW regional booking",
		observedAt: availability?.observedAt ?? null,
		bookingAvailability: availability,
		bookingAvailabilityStatus: availability ? "available" : "unavailable",
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
	const timeoutMs = options.requestTimeoutMs ?? ctx.config.requestTimeoutMs;
	const state = getState(ctx);
	const now = Date.now();
	pruneExpiredInventory(state, now);
	const originCode = await resolveStationCode(trip, state, options, true, timeoutMs);
	const destinationCode = await resolveStationCode(trip, state, options, false, timeoutMs);
	const serviceDate = trip.serviceDate;
	if (!originCode || !destinationCode || !isoDate(serviceDate)) return formationFromAvailability(trip, null);
	const key = `${trip.instance_id}\0${originCode}\0${destinationCode}`;
	const cached = state.inventory.get(key);
	if (cached && cached.expiresAt > now) return formationFromAvailability(trip, cached.availability);
	const active = state.inFlight.get(key);
	if (active) {
		const availability = await active;
		return formationFromAvailability(trip, availability);
	}
	const request = queryAvailability(trip, ctx, options, originCode, destinationCode, serviceDate)
		.catch(() => null)
		.then((availability) => {
			state.inventory.set(key, {
				availability,
				expiresAt: Date.now() + (availability ? INVENTORY_CACHE_MS : MISSING_INVENTORY_CACHE_MS),
			});
			return availability;
		});
	state.inFlight.set(key, request);
	try {
		const availability = await request;
		return formationFromAvailability(trip, availability);
	} finally {
		state.inFlight.delete(key);
	}
}
