import { type TraxConfig } from "../config.js";
import { CacheContext } from "../cache/index.js";
import { AugmentedTrip, AugmentedTripInstance } from "./augmentedTrip.js";
import { pluginSupportsFeed } from "../plugins/types.js";

export type VehicleInfo = {
	vehicle_model: string | null;
	vehicle_id: string | null;
	passenger_cars?: number | null;
	scheduled_passenger_cars?: number | null;
	consist?: string[] | null;
	details?: unknown | null;
};

/** Provider-neutral detail for one ordered unit in a vehicle formation. */
export type VehicleDiagramKind =
	| "locomotive"
	| "cab"
	| "bilevel"
	| "accessible"
	| "motor"
	| "trailer"
	| "dmu"
	| "coach"
	| "baggage"
	| "diner"
	| "dome"
	| "sleeper"
	| "service"
	| "crew"
	| "transition";

export type VehicleFormationUnit = {
	/** Null when a provider reports the car count but not every fleet number. */
	id: string | null;
	diagramKind: VehicleDiagramKind;
	type: string | null;
	manufacturer: string | null;
	model: string | null;
	seats: number | null;
	bicycles: number | null;
	accessible: boolean | null;
	wifi: boolean | null;
	powerOutlets: boolean | null;
	accentColor: string | null;
	/** Published descriptive sections for this car. Omitted when the provider has no car profile. */
	publishedSections?: VehiclePublishedSection[];
};

export type VehiclePublishedSection = {
	title: string;
	details: string[];
};

export type VehiclePublishedProfile = {
	title: string;
	logoUrl: string | null;
	accentColor: string | null;
	sections: VehiclePublishedSection[];
	sourceUrl: string | null;
};

/** Segment-specific booking inventory. This is deliberately separate from the physical formation. */
export type VehicleBookingFareClass = {
	code: string;
	label: string;
	minimumAvailability: number;
	price: number | null;
	isSleeper: boolean;
	capacity?: number | null;
	currency?: string | null;
};

export type VehicleBookingAvailability = {
	reservedCarriages: string[];
	reservedSeatsAvailable: number | null;
	unreservedTicketsAvailable: number | null;
	fareClasses?: VehicleBookingFareClass[];
	reservationAvailable: boolean;
	reservationRequired: boolean;
	seatMapAvailable: boolean;
	journeyUrl: string | null;
	source: string;
	observedAt: string;
	timeZone?: string;
};

export type VehicleBookingAvailabilityStatus = "available" | "unavailable";

export type VehicleFormationMetadata = {
	accessibleSpaces?: number | null;
	bicycleSpaces?: number | null;
	isLive?: boolean | null;
	source?: string | null;
	observedAt?: string | null;
	bookingAvailability?: VehicleBookingAvailability | null;
	bookingAvailabilityStatus?: VehicleBookingAvailabilityStatus | null;
	publishedProfile?: VehiclePublishedProfile | null;
};

/** The single vehicle/consist contract exposed to every consumer. */
export type VehicleFormation = {
	vehicleId: string | null;
	model: string | null;
	passengerCars: number | null;
	scheduledPassengerCars: number | null;
	units: VehicleFormationUnit[];
	accessibleSpaces: number | null;
	bicycleSpaces: number | null;
	isLive: boolean | null;
	source: string | null;
	observedAt: string | null;
	bookingAvailability: VehicleBookingAvailability | null;
	bookingAvailabilityStatus: VehicleBookingAvailabilityStatus | null;
	publishedProfile: VehiclePublishedProfile | null;
};

export function createVehicleFormation(
	trip: AugmentedTripInstance,
	providerUnits: readonly VehicleFormationUnit[] | null = null,
	metadata: VehicleFormationMetadata = {},
): VehicleFormation | null {
	const units =
		providerUnits && providerUnits.length > 0
			? providerUnits.map((unit) => ({
					...unit,
					publishedSections: unit.publishedSections?.map((section) => ({
						...section,
						details: [...section.details],
					})),
				}))
			: (trip.consist ?? []).map((id): VehicleFormationUnit => ({
					id,
					diagramKind: "coach",
					type: null,
					manufacturer: null,
					model: null,
					seats: null,
					bicycles: null,
					accessible: null,
					wifi: null,
					powerOutlets: null,
					accentColor: null,
				}));
	if (
		!trip.vehicle_id &&
		!trip.vehicle_model &&
		trip.passenger_cars == null &&
		trip.scheduled_passenger_cars == null &&
		units.length === 0 &&
		metadata.accessibleSpaces == null &&
		metadata.bicycleSpaces == null &&
		metadata.isLive == null &&
		!metadata.source &&
		!metadata.bookingAvailability &&
		metadata.bookingAvailabilityStatus == null &&
		!metadata.publishedProfile
	)
		return null;
	return {
		vehicleId: trip.vehicle_id ?? null,
		model: trip.vehicle_model ?? null,
		passengerCars: trip.passenger_cars ?? null,
		scheduledPassengerCars: trip.scheduled_passenger_cars ?? null,
		units,
		accessibleSpaces: metadata.accessibleSpaces ?? null,
		bicycleSpaces: metadata.bicycleSpaces ?? null,
		isLive: metadata.isLive ?? null,
		source: metadata.source ?? null,
		observedAt: metadata.observedAt ?? null,
		bookingAvailability: metadata.bookingAvailability ?? null,
		bookingAvailabilityStatus:
			metadata.bookingAvailabilityStatus ?? (metadata.bookingAvailability ? "available" : null),
		publishedProfile: metadata.publishedProfile
			? {
					...metadata.publishedProfile,
					sections: metadata.publishedProfile.sections.map((section) => ({
						...section,
						details: [...section.details],
					})),
				}
			: null,
	};
}

function resolveVehicleInfo(inst: AugmentedTripInstance, ctx: CacheContext, config: TraxConfig): VehicleInfo {
	for (const plugin of config.network.plugins) {
		if (!pluginSupportsFeed(plugin, inst.feed_id)) continue;
		const value = plugin.vehicleInfoForTrip?.(inst, ctx);
		if (value) return value;
	}
	return { vehicle_model: null, vehicle_id: null };
}

/** Static generations invalidate every instance id and all retained vehicle metadata. */
export function clearPreviousVehicleInfo(ctx: CacheContext): void {
	ctx.runtimeState.previousVehicleInfo.clear();
}

/** Drop metadata for instances no longer present after an incremental refresh. */
export function prunePreviousVehicleInfo(ctx: CacheContext, validInstanceIds: Iterable<string>): void {
	const previousVehicleInfo = ctx.runtimeState.previousVehicleInfo as Map<string, VehicleInfo>;
	const valid = new Set(validInstanceIds);
	for (const instanceId of previousVehicleInfo.keys()) {
		if (!valid.has(instanceId)) previousVehicleInfo.delete(instanceId);
	}
}

export function mergeVehicleInfo(ctx: CacheContext, inst: AugmentedTripInstance, incoming: VehicleInfo): VehicleInfo {
	const previousVehicleInfo = ctx.runtimeState.previousVehicleInfo as Map<string, VehicleInfo>;
	const prev = previousVehicleInfo.get(inst.instance_id);
	const vehicle_id = incoming.vehicle_id ?? prev?.vehicle_id ?? inst.vehicle_id ?? null;
	const vehicle_model = incoming.vehicle_model ?? prev?.vehicle_model ?? inst.vehicle_model ?? null;
	const passenger_cars = incoming.passenger_cars ?? prev?.passenger_cars ?? inst.passenger_cars ?? null;
	const scheduled_passenger_cars =
		incoming.scheduled_passenger_cars ?? prev?.scheduled_passenger_cars ?? inst.scheduled_passenger_cars ?? null;
	const consist = incoming.consist ?? prev?.consist ?? inst.consist ?? null;
	const details = incoming.details ?? prev?.details ?? inst.vehicle_details ?? null;

	previousVehicleInfo.set(inst.instance_id, {
		vehicle_id,
		vehicle_model,
		passenger_cars,
		scheduled_passenger_cars,
		consist,
		details,
	});

	return { vehicle_id, vehicle_model, passenger_cars, scheduled_passenger_cars, consist, details };
}

export function addVehicleModel(
	inst: AugmentedTripInstance,
	ctx: CacheContext,
	config: TraxConfig,
): AugmentedTripInstance {
	const incoming = resolveVehicleInfo(inst, ctx, config);
	const info = mergeVehicleInfo(ctx, inst, incoming);
	inst.vehicle_model = info.vehicle_model;
	inst.vehicle_id = info.vehicle_id;
	inst.passenger_cars = info.passenger_cars ?? null;
	inst.scheduled_passenger_cars = info.scheduled_passenger_cars ?? null;
	inst.consist = info.consist ?? null;
	inst.vehicle_details = info.details ?? null;
	return inst;
}

export function addVehicleModelTrip(trip: AugmentedTrip, ctx: CacheContext, config: TraxConfig): AugmentedTrip {
	for (const instance of trip.instances) addVehicleModel(instance, ctx, config);
	return trip;
}
