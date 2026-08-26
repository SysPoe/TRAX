import { createHmac, randomBytes } from "node:crypto";
import type { CacheContext } from "../../../../cache/types.js";
import { getPluginState } from "../../../../plugins/types.js";
import type { VehicleBookingAvailability, VehicleBookingFareClass } from "../../../../utils/vehicleModel.js";
import type { QRTTravelStopTime, QRTTravelTrip } from "./types.js";

const BOOKING_PAGE_URL = "https://queenslandrailtravel-booking.opendestinations.com/BookingSite/rail/search";
const BOOKING_API_ROOT = "https://queenslandrailtravel-booking.opendestinations.com/bookingsiteapi/api";
const SEARCH_INPUT_URL = `${BOOKING_API_ROOT}/rail/searchinput`;
const SEARCH_URL = `${BOOKING_API_ROOT}/rail/search`;
const STATE_ID = "au-seq-qrt-booking";
const DIRECTORY_CACHE_MS = 6 * 60 * 60 * 1000;
const SIGNER_CACHE_MS = 6 * 60 * 60 * 1000;
const INVENTORY_CACHE_MS = 5 * 60 * 1000;
const MISSING_INVENTORY_CACHE_MS = 60 * 1000;

type SignerBundle = { clientId: string; keys: [string, string, string, string] };
type BookingStation = { id: number; code: string | null; name: string };
type InventoryEntry = { availability: VehicleBookingAvailability | null; expiresAt: number };

type BookingState = {
	signer: SignerBundle | null;
	signerExpiresAt: number;
	signerInFlight: Promise<SignerBundle | null> | null;
	stations: BookingStation[] | null;
	stationsExpiresAt: number;
	stationsInFlight: Promise<BookingStation[]> | null;
	inventory: Map<string, InventoryEntry>;
	inFlight: Map<string, Promise<VehicleBookingAvailability | null>>;
};

type RailService = Record<string, unknown>;

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

function nonNegativeInteger(value: unknown): number | null {
	const parsed = nonNegativeNumber(value);
	return parsed === null ? null : Math.floor(parsed);
}

function responseFields(value: unknown): Record<string, unknown> | null {
	return record(record(value)?.fields);
}

export function parseQrtSignerBundle(bundle: string): SignerBundle | null {
	const match =
		/\{id:["']([^"']+)["'],k1:["']([^"']+)["'],k2:["']([^"']+)["'],k3:["']([^"']+)["'],k4:["']([^"']+)["']\}/.exec(
			bundle,
		);
	return match ? { clientId: match[1], keys: [match[2], match[3], match[4], match[5]] } : null;
}

export function qrtRequestSignature(
	url: string,
	bundle: SignerBundle,
	nonce = randomBytes(16).toString("hex"),
	timestamp = Math.floor(Date.now() / 1000),
): string {
	const key = [...bundle.keys].reverse().join("");
	const message = `${bundle.clientId}${url.toLowerCase()}${timestamp}${nonce}${timestamp}`;
	const digest = createHmac("sha256", key).update(message).digest("base64");
	return `${bundle.clientId},${digest},${nonce},${timestamp}`;
}

async function discoverSigner(ctx: CacheContext): Promise<SignerBundle | null> {
	const page = await fetch(BOOKING_PAGE_URL, { signal: AbortSignal.timeout(ctx.config.requestTimeoutMs) });
	if (!page.ok) throw new Error(`QRT booking page HTTP ${page.status}`);
	const pageUrl = page.url || BOOKING_PAGE_URL;
	const html = await page.text();
	const scriptPath = /<script[^>]+src=["']([^"']*main-es2015[^"']*\.js)["']/i.exec(html)?.[1];
	if (!scriptPath) throw new Error("QRT booking signer bundle was not linked from the booking page");
	const basePath = /<base[^>]+href=["']([^"']+)["']/i.exec(html)?.[1];
	const scriptUrl = new URL(scriptPath, basePath ? new URL(basePath, pageUrl) : pageUrl);
	const script = await fetch(scriptUrl, { signal: AbortSignal.timeout(ctx.config.requestTimeoutMs) });
	if (!script.ok) throw new Error(`QRT booking bundle HTTP ${script.status}`);
	const bundle = parseQrtSignerBundle(await script.text());
	if (!bundle) throw new Error("QRT booking signer values were not present in the client bundle");
	return bundle;
}

function stateFor(ctx: CacheContext): BookingState {
	return getPluginState(ctx, STATE_ID, () => ({
		signer: null,
		signerExpiresAt: 0,
		signerInFlight: null,
		stations: null,
		stationsExpiresAt: 0,
		stationsInFlight: null,
		inventory: new Map(),
		inFlight: new Map(),
	}));
}

async function signerFor(ctx: CacheContext, state: BookingState): Promise<SignerBundle | null> {
	if (state.signer && state.signerExpiresAt > Date.now()) return state.signer;
	if (!state.signerInFlight) {
		state.signerInFlight = discoverSigner(ctx)
			.catch(() => null)
			.then((signer) => {
				state.signer = signer;
				state.signerExpiresAt = Date.now() + (signer ? SIGNER_CACHE_MS : MISSING_INVENTORY_CACHE_MS);
				state.signerInFlight = null;
				return signer;
			});
	}
	return state.signerInFlight;
}

async function signedFetch(
	url: string,
	ctx: CacheContext,
	state: BookingState,
	init: Omit<RequestInit, "signal"> = {},
): Promise<Response> {
	const signer = await signerFor(ctx, state);
	if (!signer) throw new Error("QRT booking signer is unavailable");
	const headers = new Headers(init.headers);
	headers.set("accept", "application/json");
	headers.set("X-OdlApp-Signature", qrtRequestSignature(url, signer));
	return fetch(url, { ...init, headers, signal: AbortSignal.timeout(ctx.config.requestTimeoutMs) });
}

export function parseQrtBookingStations(payload: unknown): BookingStation[] {
	const stations = responseFields(payload)?.stations;
	if (!Array.isArray(stations)) return [];
	const unique = new Map<number, BookingStation>();
	for (const value of stations) {
		const station = record(value);
		const id = nonNegativeInteger(station?.genericid);
		const rawName = stringValue(station?.name);
		if (id === null || !rawName) continue;
		const codeMatch = /^([A-Z0-9]+)\s*-\s*(.+)$/i.exec(rawName);
		unique.set(id, { id, code: codeMatch?.[1]?.toUpperCase() ?? null, name: codeMatch?.[2]?.trim() ?? rawName });
	}
	return [...unique.values()];
}

async function stationsFor(ctx: CacheContext, state: BookingState): Promise<BookingStation[]> {
	if (state.stations && state.stationsExpiresAt > Date.now()) return state.stations;
	if (!state.stationsInFlight) {
		state.stationsInFlight = signedFetch(SEARCH_INPUT_URL, ctx, state)
			.then(async (response) => {
				if (!response.ok) throw new Error(`QRT search input HTTP ${response.status}`);
				return parseQrtBookingStations(await response.json());
			})
			.catch(() => [])
			.then((stations) => {
				state.stations = stations;
				state.stationsExpiresAt =
					Date.now() + (stations.length ? DIRECTORY_CACHE_MS : MISSING_INVENTORY_CACHE_MS);
				state.stationsInFlight = null;
				return stations;
			});
	}
	return state.stationsInFlight;
}

function normalizedStationName(value: string): string {
	return value
		.toLowerCase()
		.replace(/\bst\b/g, "street")
		.replace(/\brailway\b|\bstation\b/g, "")
		.replace(/[^a-z0-9]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

export function matchQrtBookingStation(
	stop: Pick<QRTTravelStopTime, "placeCode" | "placeName">,
	stations: readonly BookingStation[],
): BookingStation | null {
	const code = stop.placeCode.trim().toUpperCase();
	const byCode = code ? stations.filter((station) => station.code === code) : [];
	if (byCode.length === 1) return byCode[0];
	const wanted = normalizedStationName(stop.placeName);
	const exact = stations.filter((station) => normalizedStationName(station.name) === wanted);
	if (exact.length === 1) return exact[0];
	const containing = stations.filter((station) => {
		const candidate = normalizedStationName(station.name);
		return candidate.includes(wanted) || wanted.includes(candidate);
	});
	return containing.length === 1 ? containing[0] : null;
}

function isoDate(value: string): string | null {
	return /^(\d{4}-\d{2}-\d{2})/.exec(value)?.[1] ?? null;
}

function timeMinute(value: string): string | null {
	return /T(\d{2}:\d{2})/.exec(value)?.[1] ?? null;
}

function bookingDate(value: string): string | null {
	const date = isoDate(value);
	if (!date) return null;
	const [year, month, day] = date.split("-").map(Number);
	const monthName = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][month - 1];
	return monthName && day >= 1 && day <= 31 ? `${String(day).padStart(2, "0")} ${monthName} ${year}` : null;
}

function runToken(value: string): string {
	return (
		value
			.trim()
			.split(/\s+/)[0]
			?.replace(/[^A-Z0-9]/gi, "")
			.toUpperCase() ?? ""
	);
}

function railServices(payload: unknown): RailService[] {
	const services = responseFields(payload)?.raiL_SERVICES;
	return Array.isArray(services) ? services.map(record).filter((value): value is RailService => value !== null) : [];
}

export function selectQrtRailService(
	services: readonly RailService[],
	service: Pick<QRTTravelTrip, "trip_number" | "departureDate">,
	origin: BookingStation,
	destination: BookingStation,
): RailService | null {
	const date = isoDate(service.departureDate);
	const minute = timeMinute(service.departureDate);
	const expectedRun = runToken(service.trip_number);
	const matches = services.filter((candidate) => {
		const travelDate = stringValue(candidate.traveL_DATE);
		const departure = stringValue(candidate.departurE_TIME);
		return (
			runToken(stringValue(candidate.traiN_NAME) ?? "") === expectedRun &&
			isoDate(travelDate ?? "") === date &&
			stringValue(candidate.startregioncode)?.toUpperCase() === origin.code &&
			stringValue(candidate.endregioncode)?.toUpperCase() === destination.code &&
			timeMinute(departure ?? "") === minute
		);
	});
	return matches.length === 1 ? matches[0] : null;
}

function regularProduct(name: string): boolean {
	return /^(?:economy seats?|business seats?|railbeds?|single sleepers?|twin sleepers?)$/i.test(name.trim());
}

export function qrtRegularFareClasses(service: RailService): VehicleBookingFareClass[] {
	const options = service.raiL_OPTIONS;
	if (!Array.isArray(options)) return [];
	const currency = stringValue(service.currency);
	return options
		.map(record)
		.filter((option): option is Record<string, unknown> => option !== null)
		.filter((option) => nonNegativeInteger(option.servicE_OPTION_TYPE) === 0)
		.flatMap((option) => {
			const product = stringValue(option.servicE_OPTION_NAME);
			const availability = nonNegativeInteger(option.availablE_QUANTITY);
			if (!product || !regularProduct(product) || availability === null) return [];
			const fareType = stringValue(option.pricE_TYPE);
			const optionId =
				nonNegativeInteger(option.servicE_TYPE_OPTIONID) ?? nonNegativeInteger(option.servicE_OPTION_ID);
			const priceTypeId = nonNegativeInteger(option.pricE_TYPE_ID);
			return [
				{
					code: [optionId, priceTypeId].filter((value) => value !== null).join(":"),
					label: fareType ? `${product} · ${fareType}` : product,
					minimumAvailability: availability,
					price: nonNegativeNumber(option.adulT_PRICE_WITH_DISCOUNT) ?? nonNegativeNumber(option.adulT_PRICE),
					isSleeper: /RailBed|Sleeper/i.test(product),
					capacity: nonNegativeInteger(option.totalcapacity),
					currency,
				} satisfies VehicleBookingFareClass,
			];
		})
		.sort(
			(left, right) =>
				left.label.localeCompare(right.label) || (left.price ?? Infinity) - (right.price ?? Infinity),
		);
}

function searchRequest(origin: BookingStation, destination: BookingStation, travelDate: string): unknown {
	return {
		RailServiceSearchRequest: [
			{
				BookingTypeID: 1,
				oldBookedOption: 0,
				upgradeFlow: false,
				PriceTypeID: null,
				IsReturnTrip: false,
				ClientID: 0,
				DiscountCode: { ReturnApplicableDiscounts: false, DiscountCode: "" },
				ReturnAllPriceTypes: 1,
				SearchType: 0,
				ServiceID: null,
				ConcessionTypes: [
					{
						ConcessionTypeId: 0,
						IsLead: true,
						ConcessionTypeSequence: 0,
						PassengerType: "ADULT",
						ConcessionTypeName: null,
						BookedServiceId: "0",
					},
				],
				ReturnAllConcessionTypes: false,
				StopTypeID: 1,
				RailRegions: [
					{
						FromRegionID: origin.id,
						ToRegionID: destination.id,
						TravelDate: travelDate,
						ReturnFromRegionID: 0,
						ReturnToRegionID: 0,
						ReturnTravelDate: travelDate,
						TotalAdults: 1,
						TotalChildren: 0,
						ChildrenAge: [],
						ServiceTypeID: "",
						ReturnServiceTypeID: "",
						DiscountCode: "",
						TotalInfants: 0,
						InfantAges: [],
						ChildAges: [],
					},
				],
				BookingReferenceNumber: "",
			},
		],
	};
}

async function queryAvailability(
	service: QRTTravelTrip,
	ctx: CacheContext,
	state: BookingState,
	origin: BookingStation,
	destination: BookingStation,
	travelDate: string,
): Promise<VehicleBookingAvailability | null> {
	const response = await signedFetch(SEARCH_URL, ctx, state, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(searchRequest(origin, destination, travelDate)),
	});
	if (!response.ok) throw new Error(`QRT rail search HTTP ${response.status}`);
	const candidate = selectQrtRailService(railServices(await response.json()), service, origin, destination);
	if (!candidate) return null;
	const fareClasses = qrtRegularFareClasses(candidate);
	if (!fareClasses.length) return null;
	return {
		reservedCarriages: [],
		reservedSeatsAvailable: null,
		unreservedTicketsAvailable: null,
		fareClasses,
		reservationAvailable: true,
		reservationRequired: true,
		seatMapAvailable: false,
		journeyUrl: BOOKING_PAGE_URL,
		source: "Queensland Rail Travel booking",
		observedAt: new Date().toISOString(),
		timeZone: "Australia/Brisbane",
	};
}

export async function getQrtBookingAvailability(
	service: QRTTravelTrip,
	ctx: CacheContext,
): Promise<VehicleBookingAvailability | null> {
	const firstStop = service.stops[0];
	const lastStop = service.stops.at(-1);
	const travelDate = bookingDate(service.departureDate);
	if (!firstStop || !lastStop || !travelDate) return null;
	const state = stateFor(ctx);
	const stations = await stationsFor(ctx, state);
	const origin = matchQrtBookingStation(firstStop, stations);
	const destination = matchQrtBookingStation(lastStop, stations);
	if (!origin || !destination) return null;
	const key = `${service.serviceId}\0${service.departureDate}\0${origin.id}\0${destination.id}`;
	const now = Date.now();
	const cached = state.inventory.get(key);
	if (cached && cached.expiresAt > now) return cached.availability;
	const active = state.inFlight.get(key);
	if (active) return active;
	const request = queryAvailability(service, ctx, state, origin, destination, travelDate)
		.catch(() => null)
		.then((availability) => {
			state.inventory.set(key, {
				availability,
				expiresAt: Date.now() + (availability ? INVENTORY_CACHE_MS : MISSING_INVENTORY_CACHE_MS),
			});
			state.inFlight.delete(key);
			return availability;
		});
	state.inFlight.set(key, request);
	return request;
}
