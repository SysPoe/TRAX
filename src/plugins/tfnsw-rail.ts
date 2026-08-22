import type { RealtimeTripUpdate, RealtimeVehiclePosition, StopTime } from "qdf-gtfs";
import type { CacheContext } from "../cache/types.js";
import { getVehiclePositions } from "../cache/gtfsReads.js";
import { entityKey } from "../identity.js";
import { getPluginState } from "./types.js";
import { getServiceDayStart } from "../utils/time.js";
import type { TransitPlugin } from "./types.js";
import type { VehicleInfo } from "../utils/vehicleModel.js";
import {
	getTfnswRegionalBookingFormation,
	TFNSW_REGIONAL_BOOKING_PLUGIN_ID,
	type TfnswRegionalBookingOptions,
} from "../region-specific/AU/NSW/regional-booking.js";

const SYDNEY_TRAINS_FEED_ID = "nsw-sydney-trains";
const NSW_TRAINLINK_FEED_ID = "nsw-trainlink";
const TFNSW_RAIL_PLUGIN_ID = "au-nsw-tfnsw-rail";
const TFNSW_VEHICLE_SOURCE = "tfnsw-gtfsrt-vehicle-positions";

type TfnswVehicleState = { vehicleInfoByInstanceId: Map<string, VehicleInfo> };

function getTfnswVehicleState(ctx: CacheContext): TfnswVehicleState {
	return getPluginState(ctx, TFNSW_RAIL_PLUGIN_ID, () => ({ vehicleInfoByInstanceId: new Map() }));
}

function tfnswVehicleSetId(vehicle: RealtimeVehiclePosition): string | null {
	return vehicle.vehicle.label.trim() || vehicle.vehicle.id.trim() || null;
}

function matchingTfnswInstances(ctx: CacheContext, vehicle: RealtimeVehiclePosition) {
	const trip = ctx.augmented.tripsRec.get(entityKey({ feedId: vehicle.feed_id, localId: vehicle.trip.trip_id }));
	if (!trip) return [];
	return vehicle.trip.start_date
		? trip.instances.filter((instance) => instance.serviceDate === vehicle.trip.start_date)
		: trip.instances.length === 1
			? trip.instances
			: [];
}

/** Attach TfNSW's reported set allocation to the matching service-day instance. */
function applyTfnswVehicleAllocations(ctx: CacheContext): void {
	const state = getTfnswVehicleState(ctx);
	state.vehicleInfoByInstanceId.clear();
	for (const vehicle of getVehiclePositions(ctx)) {
		if (vehicle.feed_id !== SYDNEY_TRAINS_FEED_ID && vehicle.feed_id !== NSW_TRAINLINK_FEED_ID) continue;
		const setId = tfnswVehicleSetId(vehicle);
		if (!setId) continue;
		for (const instance of matchingTfnswInstances(ctx, vehicle)) {
			state.vehicleInfoByInstanceId.set(instance.instance_id, {
				vehicle_id: setId,
				vehicle_model: null,
				details: {
					source: TFNSW_VEHICLE_SOURCE,
					observedAt: vehicle.timestamp ? new Date(vehicle.timestamp * 1000).toISOString() : null,
					rawIdentifier: vehicle.vehicle.id || null,
				},
			});
		}
	}
}

const TFNSW_PASSENGER_SET_TYPES = {
	A: "Waratah",
	B: "Waratah Series 2",
	C: "C Set",
	D: "Mariyung, New Intercity Fleet",
	H: "Oscar",
	J: "Hunter",
	K: "K Set",
	M: "Millennium",
	N: "Endeavour",
	P: "Xplorer",
	S: "S Set",
	T: "Tangara",
	V: "V Set, Intercity",
	X: "XPT",
	Z: "Heritage and private passenger operator",
} as const;

const TFNSW_OPERATIONAL_SET_TYPES = {
	G: "Freight",
	I: "Track inspection",
	L: "Light locomotive",
	O: "Other",
	Q: "Maintenance track machine",
	U: "Bus",
	W: "Fast freight",
	Y: "Other",
} as const;

export type TfnswSetType = keyof typeof TFNSW_PASSENGER_SET_TYPES | keyof typeof TFNSW_OPERATIONAL_SET_TYPES;

export type TfnswTripDescriptor = {
	runNumber: string;
	setType: TfnswSetType;
	trainType: string;
	numberOfCars: number;
	isPassenger: boolean;
};

/** Parse TfNSW's provider-specific fields from a static GTFS trip ID. */
export function parseTfnswTripId(tripId: string): TfnswTripDescriptor | null {
	const parts = tripId.split(".");
	if ((parts.length !== 6 && parts.length !== 7) || parts[0].length === 0) return null;

	// Sydney Trains IDs have one more operational field before the set type than
	// NSW TrainLink IDs. Both formats end with set type, car count, and a trip key.
	const setTypeIndex = parts.length - 3;
	const setType = parts[setTypeIndex] as TfnswSetType;
	const passengerType = TFNSW_PASSENGER_SET_TYPES[setType as keyof typeof TFNSW_PASSENGER_SET_TYPES];
	const operationalType = TFNSW_OPERATIONAL_SET_TYPES[setType as keyof typeof TFNSW_OPERATIONAL_SET_TYPES];
	const trainType = passengerType ?? operationalType;
	const carCount = parts[setTypeIndex + 1];
	if (!/^\d+$/.test(carCount)) return null;
	const numberOfCars = Number(carCount);
	if (!trainType || !Number.isSafeInteger(numberOfCars) || numberOfCars < 0) return null;

	return {
		runNumber: parts[0],
		setType,
		trainType,
		numberOfCars,
		isPassenger: passengerType != null,
	};
}

export function tfnswPlatformCode(stopName: string | null | undefined): string | null {
	const match = stopName?.match(/\bplatform\s+([0-9]+(?:\s*[A-Za-z])?)\b/i);
	return match?.[1]?.replace(/\s+/g, " ") ?? null;
}

export function inferTfnswRealtimeServiceDate(input: {
	candidateServiceDates: readonly string[];
	firstServiceTime: number;
	lastServiceTime: number;
	nowEpochSeconds: number;
	timeZone: string;
}): string | null {
	if (input.candidateServiceDates.length === 0) return null;
	const distance = (start: number, end: number) =>
		input.nowEpochSeconds < start
			? start - input.nowEpochSeconds
			: input.nowEpochSeconds > end
				? input.nowEpochSeconds - end
				: 0;
	return [...input.candidateServiceDates].sort((a, b) => {
		const aStart = getServiceDayStart(a, input.timeZone) + input.firstServiceTime;
		const aEnd = getServiceDayStart(a, input.timeZone) + input.lastServiceTime;
		const bStart = getServiceDayStart(b, input.timeZone) + input.firstServiceTime;
		const bEnd = getServiceDayStart(b, input.timeZone) + input.lastServiceTime;
		return distance(aStart, aEnd) - distance(bStart, bEnd);
	})[0];
}

function stopTimeBounds(stopTimes: readonly Pick<StopTime, "arrival_time" | "departure_time">[]) {
	const times = stopTimes.flatMap((stopTime) =>
		[stopTime.arrival_time, stopTime.departure_time].filter((time): time is number => time != null),
	);
	return times.length > 0 ? { first: Math.min(...times), last: Math.max(...times) } : null;
}

function enrichTfnswRealtimeTripUpdate(update: RealtimeTripUpdate, ctx: CacheContext): RealtimeTripUpdate {
	if (update.trip.start_date || update.feed_id !== SYDNEY_TRAINS_FEED_ID || !ctx.gtfs) return update;
	const tripKey = entityKey({ feedId: update.feed_id, localId: update.trip.trip_id });
	const stopTimes =
		ctx.augmented.rawStopTimesCache.get(tripKey) ??
		ctx.gtfs.getStopTimes({ feed_id: update.feed_id, trip_id: update.trip.trip_id });
	const bounds = stopTimeBounds(stopTimes);
	if (!bounds) return update;
	const serviceDate = inferTfnswRealtimeServiceDate({
		candidateServiceDates: ctx.gtfs.getServiceDatesByTrip({ feedId: update.feed_id, localId: update.trip.trip_id }),
		firstServiceTime: bounds.first,
		lastServiceTime: bounds.last,
		nowEpochSeconds: update.timestamp ?? Date.now() / 1000,
		timeZone: ctx.config.feedTimeZones.get(update.feed_id) ?? "Australia/Sydney",
	});
	return serviceDate ? { ...update, trip: { ...update.trip, start_date: serviceDate } } : update;
}

/**
 * The TfNSW rail archives overlap. Keep each operator in one feed so the
 * combined runtime does not emit duplicate intercity or regional trips.
 */
export type TfnswRailPluginOptions = {
	regionalBooking?: TfnswRegionalBookingOptions;
	/** Admin-triggered fallback for trips without official occupancies.txt data. */
	anyTripOccupancy?: false | AnyTripNswOccupancyClientOptions;
};

export function createTfnswRailPlugin(options: TfnswRailPluginOptions = {}): TransitPlugin {
	const anyTripClient =
		options.anyTripOccupancy === false ? null : new AnyTripNswOccupancyClient(options.anyTripOccupancy);
	return {
		id: TFNSW_RAIL_PLUGIN_ID,
		feedIds: [SYDNEY_TRAINS_FEED_ID, NSW_TRAINLINK_FEED_ID],
		capabilities: ["vehicles", "occupancy"],
		considerRoute(route) {
			if (route.feed_id === SYDNEY_TRAINS_FEED_ID) {
				// isConsideredRoute has already limited this callback to rail-like route types.
				return true;
			}
			if (route.feed_id === NSW_TRAINLINK_FEED_ID) {
				return route.agency_id === "X000" || route.agency_id === "711";
			}
			return undefined;
		},
		enrichStop(stop) {
			if (stop.platform_code) return;
			const platformCode = tfnswPlatformCode(stop.stop_name);
			if (platformCode) stop.platform_code = platformCode;
		},
		enrichTrip(trip) {
			const descriptor = parseTfnswTripId(trip.trip_id);
			if (!descriptor) return;
			trip.trip_number = descriptor.runNumber;
			trip.vehicle_model = descriptor.trainType;
			if (descriptor.isPassenger) trip.scheduled_passenger_cars = descriptor.numberOfCars;
		},
		enrichRealtimeTripUpdate: enrichTfnswRealtimeTripUpdate,
		afterRealtime: applyTfnswVehicleAllocations,
		vehicleInfoForTrip: (trip, ctx) =>
			getTfnswVehicleState(ctx).vehicleInfoByInstanceId.get(trip.instance_id) ?? null,
		isNonRevenueRoute: (route) => route.feed_id === SYDNEY_TRAINS_FEED_ID && route.route_id.startsWith("RTTA_"),
	};
}

export const tfnswRailPlugin: TransitPlugin = createTfnswRailPlugin();

export function createTfnswRegionalBookingPlugin(options: TfnswRegionalBookingOptions = {}): TransitPlugin {
	return {
		id: TFNSW_REGIONAL_BOOKING_PLUGIN_ID,
		feedIds: [NSW_TRAINLINK_FEED_ID],
		capabilities: ["consist"],
		vehicleFormation: (trip, ctx) => getTfnswRegionalBookingFormation(trip, ctx, options),
	};
}
