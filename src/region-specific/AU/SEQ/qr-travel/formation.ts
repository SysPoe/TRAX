import type { CacheContext } from "../../../../cache/types.js";
import type { VehicleFormation, VehicleBookingAvailabilityStatus } from "../../../../utils/vehicleModel.js";
import { getQrtBookingAvailability, selectQrtBookingLeg } from "./booking.js";
import { getQrtPublishedFormation } from "./published-formations.js";
import type { QRTTravelTrip } from "./types.js";

export async function getQrtFormation(service: QRTTravelTrip, ctx: CacheContext): Promise<VehicleFormation> {
	let bookingStatus: VehicleBookingAvailabilityStatus = selectQrtBookingLeg(service) ? "no-match" : "closed";
	const [published, bookingAvailability] = await Promise.all([
		getQrtPublishedFormation(service, ctx),
		getQrtBookingAvailability(service, ctx).catch(() => { bookingStatus = "error"; return null; }),
	]);
	if (bookingAvailability) {
		bookingStatus = bookingAvailability.stale ? "available"
			: bookingAvailability.fareClasses?.every((fare) => fare.minimumAvailability === 0) ? "sold-out" : "available";
	}
	return {
		vehicleId: null,
		model: published?.matchName ?? service.line ?? service.serviceName ?? null,
		passengerCars: published?.units.length ? published.units.length : null,
		scheduledPassengerCars: published?.units.length ? published.units.length : null,
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
		bookingAvailabilityStatus: bookingStatus,
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
