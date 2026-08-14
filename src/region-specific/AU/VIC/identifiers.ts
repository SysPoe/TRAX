import type { AugmentedTripInstance } from "../../../utils/augmentedTrip.js";

const VLINE_TRIP_ID = /^01-[A-Z0-9]{3}--\d+-T\d-([A-Z0-9]{4})$/;

/** Extract V/Line's four-character TDN without weakening the durable GTFS identity. */
export function vlineTdn(tripId: string): string | null {
	return VLINE_TRIP_ID.exec(tripId)?.[1] ?? null;
}

export function normalizeVLineUnit(value: string | null | undefined): string | null {
	const unit = value?.trim().toUpperCase().replace(/\s+/g, "");
	return unit && /^(?:VL|V)\d{3,4}$/.test(unit) ? unit : null;
}

/** Convert PTV's VehicleDescriptor.id into the ordered vehicle IDs it actually reports. */
export function ptvVehicleDescriptorConsist(feedId: "vic-vline" | "vic-metro", value: string | null | undefined): string[] | null {
	if (feedId === "vic-vline") {
		const unit = normalizeVLineUnit(value);
		return unit ? [unit] : null;
	}
	const vehicles = value?.trim().toUpperCase().split("-").map((vehicle) => vehicle.trim())
		.filter((vehicle) => /^[A-Z0-9]+$/.test(vehicle));
	// Metro uses a hyphen-separated full consist. A singleton is only an opaque vehicle descriptor.
	return vehicles && vehicles.length > 1 ? [...new Set(vehicles)] : null;
}

export function vlineInstanceMatchKey(trip: Pick<AugmentedTripInstance, "feed_id" | "trip_id" | "serviceDate">): string {
	return `${trip.feed_id}\0${trip.trip_id}\0${trip.serviceDate}`;
}

export function vlineVehicleModel(subtype: string | null | undefined): string | null {
	const value = subtype?.trim();
	if (!value) return null;
	return value.toLowerCase() === "n-set" ? "N Class" : value;
}

export function vlinePassengerCars(subtype: string | null | undefined, unitCount: number | null): number | null {
	if (!unitCount || unitCount < 1) return null;
	return subtype?.trim().toLowerCase() === "vlocity" ? unitCount * 3 : unitCount;
}
