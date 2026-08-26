import type { CacheContext } from "../../../../cache/types.js";
import type { VehicleFormation } from "../../../../utils/vehicleModel.js";
import { getQrtBookingAvailability } from "./booking.js";
import { getQrtPublishedFormation } from "./published-formations.js";
import type { QRTTravelTrip } from "./types.js";

export async function getQrtFormation(service: QRTTravelTrip, ctx: CacheContext): Promise<VehicleFormation> {
	const [published, bookingAvailability] = await Promise.all([
		getQrtPublishedFormation(service, ctx),
		getQrtBookingAvailability(service, ctx),
	]);
	return {
		vehicleId: null,
		model: published?.matchName ?? service.line ?? service.serviceName ?? null,
		passengerCars: published?.units.length ?? null,
		scheduledPassengerCars: published?.units.length ?? null,
		units:
			published?.units.map((unit) => ({
				...unit,
				publishedSections: unit.publishedSections?.map((section) => ({
					...section,
					details: [...section.details],
				})),
			})) ?? [],
		accessibleSpaces: null,
		bicycleSpaces: null,
		isLive: false,
		source: published ? "Queensland Rail Travel published train information" : "Queensland Rail Travel",
		observedAt: published?.observedAt ?? null,
		bookingAvailability,
		bookingAvailabilityStatus: bookingAvailability ? "available" : "unavailable",
		publishedProfile: published
			? {
					...published.profile,
					sections: published.profile.sections.map((section) => ({
						...section,
						details: [...section.details],
					})),
				}
			: null,
	};
}
