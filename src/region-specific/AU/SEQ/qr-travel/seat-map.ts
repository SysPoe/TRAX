import { createHash } from "node:crypto";
import type { CacheContext } from "../../../../cache/types.js";
import { getPluginState } from "../../../../plugins/types.js";
import {
	QRT_RAIL_SEARCH_URL,
	bookingDate,
	isoDate,
	matchQrtBookingStation,
	qrtBookingState,
	qrtBookingStationsFor,
	qrtRailServices,
	qrtSearchRequest,
	regularProduct,
	selectQrtBookingLeg,
	selectQrtRailService,
	signedQrtBookingFetch,
	type RailService,
} from "./booking.js";
import type { QRTTravelTrip } from "./types.js";

const SEAT_MAP_URL =
	"https://queenslandrailtravel-booking.opendestinations.com/bookingsiteapi/api/rail/InteractiveSeatMap";
const STATE_ID = "au-seq-qrt-seat-map";
/** Availability is a snapshot; refresh at most this often and serve stale data meanwhile. */
const SEAT_MAP_TTL_MS = 30 * 60 * 1000;
const MISSING_SEAT_MAP_TTL_MS = 60 * 1000;
/** Candidate provider services rarely change within a schedule day. */
const CANDIDATE_TTL_MS = 30 * 60 * 1000;
const DIAGRAM_CACHE_BYTES = 24 * 1024 * 1024;

const IMAGE_CONTENT_TYPES: Record<string, string> = {
	JPG: "image/jpeg",
	JPEG: "image/jpeg",
	PNG: "image/png",
	GIF: "image/gif",
	WEBP: "image/webp",
	SVG: "image/svg+xml",
};

/** One seat from the provider's booking-oriented seat map, not live occupancy. */
export type QrtBookingSeatMapSeat = {
	id: string;
	name: string;
	number: string | number | null;
	typeName: string | null;
	/** Diagram position in CSS pixels; null when the provider omitted coordinates. */
	x: number | null;
	y: number | null;
	available: boolean;
	compatibleServiceTypeOptionIds: string[];
};

export type QrtBookingSeatMapFare = {
	serviceOptionId: string;
	serviceTypeOptionId: string | null;
	name: string | null;
};

export type QrtBookingSeatMapCarriageInformation = {
	question: string;
	answer: string;
};

export type QrtBookingSeatMapCarriage = {
	id: string;
	name: string | null;
	sequence: string | number | null;
	series: string | null;
	available: boolean;
	allowedServiceOptions: { id: string; name: string }[];
	diagramHash: string | null;
	diagramContentType: string | null;
	seats: QrtBookingSeatMapSeat[];
	publishedInformation: QrtBookingSeatMapCarriageInformation[];
};

export type QrtBookingSeatMap = {
	/** TRAX service id of the tracked run this map belongs to. */
	serviceId: string;
	travelDate: string;
	/** Fare the compatibility data was requested for; seats failing it are not selectable. */
	selectedFare: QrtBookingSeatMapFare | null;
	source: string;
	asOf: string;
	carriages: QrtBookingSeatMapCarriage[];
};

export type QrtSeatMapDiagram = { bytes: Uint8Array; contentType: string };

type DiagramEntry = QrtSeatMapDiagram;

type SeatMapState = {
	candidates: Map<string, { service: RailService | null; expiresAt: number }>;
	seatMaps: Map<string, { map: QrtBookingSeatMap | null; expiresAt: number }>;
	inFlight: Map<string, Promise<QrtBookingSeatMap | null>>;
	/** Content-addressed carriage diagrams; keyed by sha256 of the decoded bytes. */
	diagrams: Map<string, DiagramEntry>;
	diagramBytes: number;
};

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function stringValue(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function booleanValue(value: unknown): boolean {
	return value === true;
}

function idString(value: unknown): string | null {
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	return stringValue(value);
}

function coordinate(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Number(value.trim());
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}

function seatNumber(value: unknown): string | number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	return stringValue(value);
}

function sequenceValue(value: unknown): string | number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	return stringValue(value);
}

function compatibleOptionIds(value: unknown): string[] {
	return typeof value === "string"
		? value
				.split(",")
				.map((part) => part.trim())
				.filter(Boolean)
		: [];
}

function diagramContentType(imageType: unknown): string | null {
	const type = stringValue(imageType)?.toUpperCase();
	return type ? (IMAGE_CONTENT_TYPES[type] ?? "application/octet-stream") : null;
}

/** Content-addressed diagram store shared by every seat map in this runtime. */
function storeDiagram(state: SeatMapState, imageData: unknown, imageType: unknown): string | null {
	if (typeof imageData !== "string" || !imageData.trim()) return null;
	const bytes = Buffer.from(imageData, "base64");
	if (!bytes.length) return null;
	const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 32);
	if (!state.diagrams.has(hash)) {
		const contentType = diagramContentType(imageType) ?? "application/octet-stream";
		state.diagrams.set(hash, { bytes, contentType });
		state.diagramBytes += bytes.length;
		for (const [key, entry] of state.diagrams) {
			if (state.diagramBytes <= DIAGRAM_CACHE_BYTES) break;
			state.diagramBytes -= entry.bytes.length;
			state.diagrams.delete(key);
		}
	}
	return hash;
}

/**
 * Normalizes a raw InteractiveSeatMap response. `storeDiagrams` receives the
 * decoded diagram bytes so callers (and tests) control persistence.
 */
export function parseQrtSeatMap(
	payload: unknown,
	storeDiagrams: (imageData: unknown, imageType: unknown) => string | null,
): QrtBookingSeatMapCarriage[] {
	const fields = record(record(payload)?.fields);
	const railCars = Array.isArray(fields?.railCars) ? fields.railCars : [];
	return railCars
		.map((value): QrtBookingSeatMapCarriage | null => {
			const car = record(value);
			if (!car) return null;
			const allowed = Array.isArray(car.allowedRailServiceOptions)
				? car.allowedRailServiceOptions
						.map((option) => {
							const entry = record(option);
							const id = entry ? idString(entry.id) : null;
							return id ? { id, name: stringValue(entry?.name) ?? "" } : null;
						})
						.filter((option): option is { id: string; name: string } => option !== null)
				: [];
			const seats = Array.isArray(car.seats)
				? car.seats
						.map((seatValue): QrtBookingSeatMapSeat | null => {
							const seat = record(seatValue);
							const id = seat ? idString(seat.id) : null;
							const name = seat ? stringValue(seat.name) : null;
							if (!id || !name) return null;
							return {
								id,
								name,
								number: seatNumber(seat?.number),
								typeName: stringValue(seat?.typeName),
								x: coordinate(seat?.xcoord),
								y: coordinate(seat?.ycoord),
								available: booleanValue(seat?.available),
								compatibleServiceTypeOptionIds: compatibleOptionIds(seat?.serviceTypeOptionId),
							};
						})
						.filter((seat): seat is QrtBookingSeatMapSeat => seat !== null)
				: [];
			const information = Array.isArray(car.carriageGeneralInformation)
				? car.carriageGeneralInformation
						.map((infoValue) => {
							const info = record(infoValue);
							const question = stringValue(info?.carriageQuestions);
							const answer = stringValue(info?.carriageAnswers);
							return question && answer ? { question, answer } : null;
						})
						.filter((info): info is QrtBookingSeatMapCarriageInformation => info !== null)
				: [];
			const name = stringValue(car.name);
			const diagramHash = storeDiagrams(car.imageData, car.imageType);
			return {
				id: idString(car.id) ?? name ?? "",
				name,
				sequence: sequenceValue(car.sequence),
				series: stringValue(car.series),
				available: booleanValue(car.available),
				allowedServiceOptions: allowed,
				diagramHash,
				diagramContentType: diagramHash ? diagramContentType(car.imageType) : null,
				seats,
				publishedInformation: information,
			};
		})
		.filter((car): car is QrtBookingSeatMapCarriage => car !== null && car.id !== "");
}

/** Picks the regular fare option the map is requested for: the cheapest regular seat product. */
export function selectQrtSeatMapFareOption(service: RailService): RailService | null {
	const options = service.raiL_OPTIONS;
	if (!Array.isArray(options)) return null;
	const regular = options
		.map(record)
		.filter((option): option is Record<string, unknown> => option !== null)
		.filter((option) => option.servicE_OPTION_TYPE == null || option.servicE_OPTION_TYPE === 0)
		.filter((option) => {
			const name = stringValue(option.servicE_OPTION_NAME);
			return name !== null && regularProduct(name);
		});
	const pool = regular.length
		? regular
		: options.map(record).filter((option): option is Record<string, unknown> => option !== null);
	return (
		pool.sort((left, right) => {
			const leftPrice = typeof left.adulT_PRICE === "number" ? left.adulT_PRICE : Number.POSITIVE_INFINITY;
			const rightPrice = typeof right.adulT_PRICE === "number" ? right.adulT_PRICE : Number.POSITIVE_INFINITY;
			return leftPrice - rightPrice;
		})[0] ?? null
	);
}

export function qrtSeatMapRequest(service: RailService, option: RailService): unknown {
	return {
		Service: {
			ServiceId: service.serviceid,
			TravelDate: isoDate(typeof service.traveL_DATE === "string" ? service.traveL_DATE : ""),
			RailRouteID: service.raiL_ROUTE_ID,
			Options: [
				{
					ServiceOptionID: option.servicE_OPTION_ID,
					Passengers: [{ PassengerId: 1 }],
				},
			],
		},
	};
}

function seatMapFare(option: RailService): QrtBookingSeatMapFare {
	return {
		serviceOptionId: String(option.servicE_OPTION_ID ?? ""),
		serviceTypeOptionId:
			option.servicE_TYPE_OPTIONID === null || option.servicE_TYPE_OPTIONID === undefined
				? null
				: String(option.servicE_TYPE_OPTIONID),
		name: stringValue(option.servicE_OPTION_NAME),
	};
}

function stateFor(ctx: CacheContext): SeatMapState {
	return getPluginState(ctx, STATE_ID, () => ({
		candidates: new Map(),
		seatMaps: new Map(),
		inFlight: new Map(),
		diagrams: new Map(),
		diagramBytes: 0,
	}));
}

export function getQrtSeatMapDiagram(ctx: CacheContext, imageHash: string): QrtSeatMapDiagram | null {
	if (!/^[0-9a-f]{6,64}$/.test(imageHash)) return null;
	return stateFor(ctx).diagrams.get(imageHash) ?? null;
}

type SeatMapDeps = {
	/** Overridable so tests can exercise the stale-while-revalidate cache without network access. */
	fetchMap?: (service: QRTTravelTrip, ctx: CacheContext, state: SeatMapState) => Promise<QrtBookingSeatMap | null>;
};

async function fetchSeatMap(
	service: QRTTravelTrip,
	ctx: CacheContext,
	state: SeatMapState,
): Promise<QrtBookingSeatMap | null> {
	const leg = selectQrtBookingLeg(service);
	const travelDate = leg ? bookingDate(leg.departureDate) : null;
	const isoTravelDate = leg ? isoDate(leg.departureDate) : null;
	if (!leg || !travelDate || !isoTravelDate) return null;

	const key = `${service.serviceId}\0${leg.departureDate}\0${leg.origin.placeCode}\0${leg.destination.placeCode}`;
	const cachedCandidate = state.candidates.get(key);
	let candidate: RailService | null = cachedCandidate === undefined ? null : (cachedCandidate?.service ?? null);
	if (!cachedCandidate || cachedCandidate.expiresAt <= Date.now()) {
		const booking = qrtBookingState(ctx);
		const stations = await qrtBookingStationsFor(ctx, booking);
		const origin = matchQrtBookingStation(leg.origin, stations);
		const destination = matchQrtBookingStation(leg.destination, stations);
		if (origin && destination) {
			const response = await signedQrtBookingFetch(QRT_RAIL_SEARCH_URL, ctx, booking, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(qrtSearchRequest(origin, destination, travelDate)),
			});
			if (response.ok) {
				candidate = selectQrtRailService(
					qrtRailServices(await response.json()),
					service,
					origin,
					destination,
					leg.departureDate,
				);
			}
		}
		state.candidates.set(key, {
			service: candidate,
			expiresAt: Date.now() + CANDIDATE_TTL_MS,
		});
	}
	if (!candidate) return null;

	const option = selectQrtSeatMapFareOption(candidate);
	if (!option) return null;

	const response = await signedQrtBookingFetch(SEAT_MAP_URL, ctx, qrtBookingState(ctx), {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(qrtSeatMapRequest(candidate, option)),
	});
	if (!response.ok) throw new Error(`QRT interactive seat map HTTP ${response.status}`);
	const carriages = parseQrtSeatMap(await response.json(), (imageData, imageType) =>
		storeDiagram(state, imageData, imageType),
	);
	if (!carriages.length) return null;
	return {
		serviceId: service.serviceId,
		travelDate: isoTravelDate,
		selectedFare: seatMapFare(option),
		source: "Queensland Rail Travel booking",
		asOf: new Date().toISOString(),
		carriages,
	};
}

/**
 * Booking-oriented seat map for a tracked QRT run. Fresh for 30 minutes; after
 * that the last cached map is served immediately while a refresh runs in the
 * background. Availability is a timestamped snapshot, never live occupancy.
 */
export async function getQrtBookingSeatMap(
	service: QRTTravelTrip,
	ctx: CacheContext,
	deps: SeatMapDeps = {},
): Promise<QrtBookingSeatMap | null> {
	const leg = selectQrtBookingLeg(service);
	if (!leg) return null;
	const isoTravelDate = isoDate(leg.departureDate);
	if (!isoTravelDate) return null;
	const state = stateFor(ctx);
	const fetchMap = deps.fetchMap ?? ((trip, context, seatMapState) => fetchSeatMap(trip, context, seatMapState));
	const key = `${service.serviceId}\0${leg.departureDate}\0${leg.origin.placeCode}\0${leg.destination.placeCode}`;

	const cached = state.seatMaps.get(key);
	if (cached && cached.expiresAt > Date.now()) return cached.map;

	const refresh = async (): Promise<QrtBookingSeatMap | null> => {
		try {
			const map = await fetchMap(service, ctx, state);
			state.seatMaps.set(key, {
				map,
				expiresAt: Date.now() + (map ? SEAT_MAP_TTL_MS : MISSING_SEAT_MAP_TTL_MS),
			});
			return map;
		} catch {
			// Keep serving the last map on refresh failure; brief negative cache otherwise.
			state.seatMaps.set(key, { map: cached?.map ?? null, expiresAt: Date.now() + MISSING_SEAT_MAP_TTL_MS });
			return cached?.map ?? null;
		} finally {
			state.inFlight.delete(key);
		}
	};

	if (cached) {
		// Stale-while-revalidate: hand back the last map now, refresh quietly.
		if (!state.inFlight.has(key)) state.inFlight.set(key, refresh());
		return cached.map;
	}
	const active = state.inFlight.get(key);
	if (active) return active;
	const request = refresh();
	state.inFlight.set(key, request);
	return request;
}
