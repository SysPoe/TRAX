import rawVehicleDetails from "../../../../data/region-specific/CA/GTHA/vehicle_details.json" with { type: "json" };
import { BILEVEL_REGISTRY } from "./bilevel_registry.js";

export interface GOTransitVehicle {
	type: "Locomotive" | "Coach" | "Accessible Coach" | "Cab Car" | "DMU";
	series_ranges: { from: number; to: number }[];
	description: {
		/** The primary or starting model year. */
		model_year: number;
		/** The ending model year, if production spanned multiple years. */
		model_year_end?: number;
		manufacturer: string;
		model: string;
		fuel_type: "Diesel-electric" | "Unpowered Railcar";
		/** Horsepower rating for locomotives and DMUs */
		power_hp?: number;
		/** Top speed in miles per hour */
		top_speed_mph?: number;
	};

	dimensions: {
		length_meters: number;
		articulated_sections: number;
		levels: number;
		/** Number of passenger doors per side */
		doors: number;
	};

	livery: {
		style: "Two-tone" | "Bilevel" | "Other";
		hex_color: string;
	};

	capacity: {
		seating: number;
		bicycles: number;
		wheelchair_bays: number;
		restrictions: string[];
	};

	amenities: {
		restrooms: {
			total: number;
			is_accessible: boolean;
		};
		climate_control: {
			has_ac: boolean;
		};
		connectivity: {
			has_wifi: boolean;
			wifi_notes?: string;
			has_power_outlets: boolean;
			has_usb_ports: boolean;
		};
	};

	accessibility: {
		is_fully_accessible: boolean;
		/** Number of steps to board from a standard platform */
		boarding_steps: number;
		ramp: {
			is_available: boolean;
			deployment_notes?: string;
		};
		passenger_info: {
			audio_announcements: boolean;
			visual_next_stop_display: boolean;
		};
	};

	/** Optional historical or descriptive notes for the series */
	series_notes?: string[];

	/** Optional data for specific individual cars extracted from registries */
	individual_car_data?: {
		serial_number: string | null;
		delivery_date: string | null;
		notes: string[];
		series: string;
		is_accessible: boolean;
	} | null;
}

/**
 * GTHAVehicleDetails
 *
 * A comprehensive local database of GO Transit and UP Express vehicle specifications
 * derived from official documentation and fleet registries.
 *
 * This data is used for rendering detailed vehicle information in the real-time
 * vehicle tracking modules.
 */
export const GTHAVehicleDetails: GOTransitVehicle[] = rawVehicleDetails as GOTransitVehicle[];

/**
 * Retrieves detailed vehicle specifications for a given GTHA vehicle ID.
 * @param vehicleId The fleet number or vehicle identifier.
 * @returns The matching GOTransitVehicle details or null if not found.
 */
export function getGTHAVehicleDetails(vehicleId: string): GOTransitVehicle | null {
	const numericId = Number.parseInt(vehicleId, 10);
	if (Number.isNaN(numericId)) return null;

	let result: GOTransitVehicle | null = null;
	for (const vehicle of GTHAVehicleDetails) {
		for (const range of vehicle.series_ranges) {
			if (numericId >= range.from && numericId <= range.to) {
				result = { ...vehicle };
				break;
			}
		}
		if (result) break;
	}

	if (result) {
		const individual = BILEVEL_REGISTRY[vehicleId];
		if (individual) {
			result.individual_car_data = individual;
		}
	}

	return result;
}
