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
export const GTHAVehicleDetails: GOTransitVehicle[] = [
	// --- Locomotives ---
	{
		type: "Locomotive",
		series_ranges: [{ from: 520, to: 568 }],
		description: {
			model_year: 1988,
			model_year_end: 1994,
			manufacturer: "General Motors Diesel (GMDD)",
			model: "F59PH",
			fuel_type: "Diesel-electric",
			power_hp: 3000,
			top_speed_mph: 83,
		},
		dimensions: {
			length_meters: 17.7,
			articulated_sections: 1,
			levels: 1,
			doors: 2,
		},
		livery: {
			style: "Two-tone",
			hex_color: "#29621A",
		},
		capacity: {
			seating: 2,
			bicycles: 0,
			wheelchair_bays: 0,
			restrictions: ["Crew only"],
		},
		amenities: {
			restrooms: { total: 1, is_accessible: false },
			climate_control: { has_ac: true },
			connectivity: {
				has_wifi: false,
				has_power_outlets: false,
				has_usb_ports: false,
			},
		},
		accessibility: {
			is_fully_accessible: false,
			boarding_steps: 4,
			ramp: { is_available: false },
			passenger_info: {
				audio_announcements: false,
				visual_next_stop_display: false,
			},
		},
	},
	{
		type: "Locomotive",
		series_ranges: [{ from: 600, to: 666 }],
		description: {
			model_year: 2007,
			model_year_end: 2014,
			manufacturer: "Motive Power Industries (MPI)",
			model: "MP40PH-3C",
			fuel_type: "Diesel-electric",
			power_hp: 4000,
			top_speed_mph: 93,
		},
		dimensions: {
			length_meters: 20.7,
			articulated_sections: 1,
			levels: 1,
			doors: 2,
		},
		livery: {
			style: "Two-tone",
			hex_color: "#29621A",
		},
		capacity: {
			seating: 2,
			bicycles: 0,
			wheelchair_bays: 0,
			restrictions: ["Crew only"],
		},
		amenities: {
			restrooms: { total: 1, is_accessible: false },
			climate_control: { has_ac: true },
			connectivity: {
				has_wifi: false,
				has_power_outlets: false,
				has_usb_ports: false,
			},
		},
		accessibility: {
			is_fully_accessible: false,
			boarding_steps: 4,
			ramp: { is_available: false },
			passenger_info: {
				audio_announcements: false,
				visual_next_stop_display: false,
			},
		},
	},
	{
		type: "Locomotive",
		series_ranges: [
			{ from: 667, to: 682 },
			{ from: 647, to: 647 },
		],
		description: {
			model_year: 2015,
			model_year_end: 2018,
			manufacturer: "Motive Power Industries (MPI)",
			model: "MP54AC",
			fuel_type: "Diesel-electric",
			power_hp: 5400,
			top_speed_mph: 93,
		},
		dimensions: {
			length_meters: 20.7,
			articulated_sections: 1,
			levels: 1,
			doors: 2,
		},
		livery: {
			style: "Two-tone",
			hex_color: "#29621A",
		},
		capacity: {
			seating: 2,
			bicycles: 0,
			wheelchair_bays: 0,
			restrictions: ["Crew only"],
		},
		amenities: {
			restrooms: { total: 1, is_accessible: false },
			climate_control: { has_ac: true },
			connectivity: {
				has_wifi: false,
				has_power_outlets: false,
				has_usb_ports: false,
			},
		},
		accessibility: {
			is_fully_accessible: false,
			boarding_steps: 4,
			ramp: { is_available: false },
			passenger_info: {
				audio_announcements: false,
				visual_next_stop_display: false,
			},
		},
	},

	// --- BiLevel Railcars ---
	{
		type: "Coach",
		series_ranges: [{ from: 2100, to: 2155 }],
		description: {
			model_year: 1983,
			model_year_end: 1984,
			manufacturer: "Hawker Siddeley Canada",
			model: "BiLevel Series II Coach",
			fuel_type: "Unpowered Railcar",
		},
		dimensions: {
			length_meters: 25.9,
			articulated_sections: 1,
			levels: 3,
			doors: 2,
		},
		livery: {
			style: "Bilevel",
			hex_color: "#008341",
		},
		capacity: {
			seating: 162,
			bicycles: 2,
			wheelchair_bays: 0,
			restrictions: [],
		},
		amenities: {
			restrooms: { total: 1, is_accessible: false },
			climate_control: { has_ac: true },
			connectivity: {
				has_wifi: true,
				wifi_notes: "GO Wi-Fi Plus",
				has_power_outlets: true,
				has_usb_ports: false,
			},
		},
		accessibility: {
			is_fully_accessible: false,
			boarding_steps: 2,
			ramp: { is_available: false },
			passenger_info: {
				audio_announcements: true,
				visual_next_stop_display: true,
			},
		},
	},
	{
		type: "Cab Car",
		series_ranges: [{ from: 200, to: 214 }],
		description: {
			model_year: 1983,
			model_year_end: 1984,
			manufacturer: "Hawker Siddeley Canada",
			model: "BiLevel Series II Cab Car",
			fuel_type: "Unpowered Railcar",
		},
		dimensions: {
			length_meters: 25.9,
			articulated_sections: 1,
			levels: 3,
			doors: 2,
		},
		livery: {
			style: "Bilevel",
			hex_color: "#008341",
		},
		capacity: {
			seating: 161,
			bicycles: 0,
			wheelchair_bays: 0,
			restrictions: [],
		},
		amenities: {
			restrooms: { total: 1, is_accessible: false },
			climate_control: { has_ac: true },
			connectivity: {
				has_wifi: true,
				wifi_notes: "GO Wi-Fi Plus",
				has_power_outlets: true,
				has_usb_ports: false,
			},
		},
		accessibility: {
			is_fully_accessible: false,
			boarding_steps: 2,
			ramp: { is_available: false },
			passenger_info: {
				audio_announcements: true,
				visual_next_stop_display: true,
			},
		},
	},
	{
		type: "Coach",
		series_ranges: [{ from: 2200, to: 2253 }],
		description: {
			model_year: 1988,
			model_year_end: 1989,
			manufacturer: "Can-Car Rail",
			model: "BiLevel Series III Coach",
			fuel_type: "Unpowered Railcar",
		},
		dimensions: {
			length_meters: 25.9,
			articulated_sections: 1,
			levels: 3,
			doors: 2,
		},
		livery: {
			style: "Bilevel",
			hex_color: "#008341",
		},
		capacity: {
			seating: 162,
			bicycles: 2,
			wheelchair_bays: 0,
			restrictions: [],
		},
		amenities: {
			restrooms: { total: 1, is_accessible: false },
			climate_control: { has_ac: true },
			connectivity: {
				has_wifi: true,
				wifi_notes: "GO Wi-Fi Plus",
				has_power_outlets: false,
				has_usb_ports: false,
			},
		},
		accessibility: {
			is_fully_accessible: false,
			boarding_steps: 2,
			ramp: { is_available: false },
			passenger_info: {
				audio_announcements: true,
				visual_next_stop_display: true,
			},
		},
	},
	{
		type: "Cab Car",
		series_ranges: [{ from: 215, to: 223 }],
		description: {
			model_year: 1988,
			model_year_end: 1989,
			manufacturer: "Can-Car Rail",
			model: "BiLevel Series III Cab Car",
			fuel_type: "Unpowered Railcar",
		},
		dimensions: {
			length_meters: 25.9,
			articulated_sections: 1,
			levels: 3,
			doors: 2,
		},
		livery: {
			style: "Bilevel",
			hex_color: "#008341",
		},
		capacity: {
			seating: 160,
			bicycles: 0,
			wheelchair_bays: 0,
			restrictions: [],
		},
		amenities: {
			restrooms: { total: 1, is_accessible: false },
			climate_control: { has_ac: true },
			connectivity: {
				has_wifi: true,
				wifi_notes: "GO Wi-Fi Plus",
				has_power_outlets: false,
				has_usb_ports: false,
			},
		},
		accessibility: {
			is_fully_accessible: false,
			boarding_steps: 2,
			ramp: { is_available: false },
			passenger_info: {
				audio_announcements: true,
				visual_next_stop_display: true,
			},
		},
	},
	{
		type: "Coach",
		series_ranges: [{ from: 2300, to: 2341 }],
		description: {
			model_year: 1989,
			model_year_end: 1991,
			manufacturer: "Can-Car Rail / UTDC",
			model: "BiLevel Series IV Coach",
			fuel_type: "Unpowered Railcar",
		},
		dimensions: {
			length_meters: 25.9,
			articulated_sections: 1,
			levels: 3,
			doors: 2,
		},
		livery: {
			style: "Bilevel",
			hex_color: "#008341",
		},
		capacity: {
			seating: 156,
			bicycles: 2,
			wheelchair_bays: 2,
			restrictions: [],
		},
		amenities: {
			restrooms: { total: 1, is_accessible: true },
			climate_control: { has_ac: true },
			connectivity: {
				has_wifi: true,
				wifi_notes: "GO Wi-Fi Plus",
				has_power_outlets: false,
				has_usb_ports: false,
			},
		},
		accessibility: {
			is_fully_accessible: true,
			boarding_steps: 0,
			ramp: {
				is_available: true,
				deployment_notes: "Manual ramp deployed by crew at accessible platform",
			},
			passenger_info: {
				audio_announcements: true,
				visual_next_stop_display: true,
			},
		},
	},
	{
		type: "Cab Car",
		series_ranges: [{ from: 224, to: 241 }],
		description: {
			model_year: 1989,
			model_year_end: 1991,
			manufacturer: "Can-Car Rail / UTDC",
			model: "BiLevel Series IV Cab Car",
			fuel_type: "Unpowered Railcar",
		},
		dimensions: {
			length_meters: 25.9,
			articulated_sections: 1,
			levels: 3,
			doors: 2,
		},
		livery: {
			style: "Bilevel",
			hex_color: "#008341",
		},
		capacity: {
			seating: 154,
			bicycles: 0,
			wheelchair_bays: 0,
			restrictions: [],
		},
		amenities: {
			restrooms: { total: 1, is_accessible: true },
			climate_control: { has_ac: true },
			connectivity: {
				has_wifi: true,
				wifi_notes: "GO Wi-Fi Plus",
				has_power_outlets: false,
				has_usb_ports: false,
			},
		},
		accessibility: {
			is_fully_accessible: false,
			boarding_steps: 2,
			ramp: { is_available: false },
			passenger_info: {
				audio_announcements: true,
				visual_next_stop_display: true,
			},
		},
	},
	{
		type: "Coach",
		series_ranges: [
			{ from: 2400, to: 2455 },
			{ from: 2499, to: 2499 }, // Prototype
		],
		description: {
			model_year: 2002,
			manufacturer: "Bombardier Transportation",
			model: "BiLevel Series V Coach",
			fuel_type: "Unpowered Railcar",
		},
		dimensions: {
			length_meters: 25.9,
			articulated_sections: 1,
			levels: 3,
			doors: 2,
		},
		livery: {
			style: "Bilevel",
			hex_color: "#008341",
		},
		capacity: {
			seating: 162,
			bicycles: 2,
			wheelchair_bays: 0,
			restrictions: [],
		},
		amenities: {
			restrooms: { total: 1, is_accessible: false },
			climate_control: { has_ac: true },
			connectivity: {
				has_wifi: true,
				wifi_notes: "GO Wi-Fi Plus",
				has_power_outlets: true,
				has_usb_ports: false,
			},
		},
		accessibility: {
			is_fully_accessible: false,
			boarding_steps: 2,
			ramp: { is_available: false },
			passenger_info: {
				audio_announcements: true,
				visual_next_stop_display: true,
			},
		},
	},
	{
		type: "Accessible Coach",
		series_ranges: [{ from: 2500, to: 2521 }],
		description: {
			model_year: 2002,
			manufacturer: "Bombardier Transportation",
			model: "BiLevel Series VI Accessible Coach",
			fuel_type: "Unpowered Railcar",
		},
		dimensions: {
			length_meters: 25.9,
			articulated_sections: 1,
			levels: 3,
			doors: 2,
		},
		livery: {
			style: "Bilevel",
			hex_color: "#008341",
		},
		capacity: {
			seating: 136,
			bicycles: 0,
			wheelchair_bays: 4,
			restrictions: ["Designated accessible coach"],
		},
		amenities: {
			restrooms: { total: 1, is_accessible: true },
			climate_control: { has_ac: true },
			connectivity: {
				has_wifi: true,
				wifi_notes: "GO Wi-Fi Plus",
				has_power_outlets: true,
				has_usb_ports: false,
			},
		},
		accessibility: {
			is_fully_accessible: true,
			boarding_steps: 0,
			ramp: {
				is_available: true,
				deployment_notes: "Manual ramp deployed by crew",
			},
			passenger_info: {
				audio_announcements: true,
				visual_next_stop_display: true,
			},
		},
	},
	{
		type: "Coach",
		series_ranges: [{ from: 2600, to: 2661 }],
		description: {
			model_year: 2003,
			model_year_end: 2008,
			manufacturer: "Bombardier Transportation",
			model: "BiLevel Series VII Coach",
			fuel_type: "Unpowered Railcar",
		},
		dimensions: {
			length_meters: 25.9,
			articulated_sections: 1,
			levels: 3,
			doors: 2,
		},
		livery: {
			style: "Bilevel",
			hex_color: "#008341",
		},
		capacity: {
			seating: 150,
			bicycles: 2,
			wheelchair_bays: 0,
			restrictions: [],
		},
		amenities: {
			restrooms: { total: 1, is_accessible: false },
			climate_control: { has_ac: true },
			connectivity: {
				has_wifi: true,
				wifi_notes: "GO Wi-Fi Plus",
				has_power_outlets: true,
				has_usb_ports: true,
			},
		},
		accessibility: {
			is_fully_accessible: false,
			boarding_steps: 2,
			ramp: { is_available: false },
			passenger_info: {
				audio_announcements: true,
				visual_next_stop_display: true,
			},
		},
	},
	{
		type: "Accessible Coach",
		series_ranges: [{ from: 2522, to: 2544 }],
		description: {
			model_year: 2003,
			model_year_end: 2008,
			manufacturer: "Bombardier Transportation",
			model: "BiLevel Series VII Accessible Coach",
			fuel_type: "Unpowered Railcar",
		},
		dimensions: {
			length_meters: 25.9,
			articulated_sections: 1,
			levels: 3,
			doors: 2,
		},
		livery: {
			style: "Bilevel",
			hex_color: "#008341",
		},
		capacity: {
			seating: 136,
			bicycles: 2,
			wheelchair_bays: 4,
			restrictions: [],
		},
		amenities: {
			restrooms: { total: 1, is_accessible: true },
			climate_control: { has_ac: true },
			connectivity: {
				has_wifi: true,
				wifi_notes: "GO Wi-Fi Plus",
				has_power_outlets: true,
				has_usb_ports: true,
			},
		},
		accessibility: {
			is_fully_accessible: true,
			boarding_steps: 0,
			ramp: { is_available: true },
			passenger_info: {
				audio_announcements: true,
				visual_next_stop_display: true,
			},
		},
	},
	{
		type: "Cab Car",
		series_ranges: [{ from: 242, to: 250 }],
		description: {
			model_year: 2003,
			model_year_end: 2008,
			manufacturer: "Bombardier Transportation",
			model: "BiLevel Series VII Cab Car",
			fuel_type: "Unpowered Railcar",
		},
		dimensions: {
			length_meters: 25.9,
			articulated_sections: 1,
			levels: 3,
			doors: 2,
		},
		livery: {
			style: "Bilevel",
			hex_color: "#008341",
		},
		capacity: {
			seating: 148,
			bicycles: 0,
			wheelchair_bays: 0,
			restrictions: ["Full-width cab"],
		},
		amenities: {
			restrooms: { total: 1, is_accessible: true },
			climate_control: { has_ac: true },
			connectivity: {
				has_wifi: true,
				wifi_notes: "GO Wi-Fi Plus",
				has_power_outlets: true,
				has_usb_ports: true,
			},
		},
		accessibility: {
			is_fully_accessible: false,
			boarding_steps: 2,
			ramp: { is_available: false },
			passenger_info: {
				audio_announcements: true,
				visual_next_stop_display: true,
			},
		},
	},
	{
		type: "Coach",
		series_ranges: [{ from: 2700, to: 2857 }],
		description: {
			model_year: 2008,
			model_year_end: 2015,
			manufacturer: "Bombardier Transportation",
			model: "BiLevel Series VIII Coach",
			fuel_type: "Unpowered Railcar",
		},
		dimensions: {
			length_meters: 25.9,
			articulated_sections: 1,
			levels: 3,
			doors: 2,
		},
		livery: {
			style: "Two-tone",
			hex_color: "#29621A",
		},
		capacity: {
			seating: 150,
			bicycles: 2,
			wheelchair_bays: 0,
			restrictions: [],
		},
		amenities: {
			restrooms: { total: 1, is_accessible: false },
			climate_control: { has_ac: true },
			connectivity: {
				has_wifi: true,
				wifi_notes: "GO Wi-Fi Plus",
				has_power_outlets: true,
				has_usb_ports: true,
			},
		},
		accessibility: {
			is_fully_accessible: false,
			boarding_steps: 2,
			ramp: { is_available: false },
			passenger_info: {
				audio_announcements: true,
				visual_next_stop_display: true,
			},
		},
	},
	{
		type: "Accessible Coach",
		series_ranges: [{ from: 2545, to: 2560 }],
		description: {
			model_year: 2008,
			model_year_end: 2015,
			manufacturer: "Bombardier Transportation",
			model: "BiLevel Series VIII Accessible Coach",
			fuel_type: "Unpowered Railcar",
		},
		dimensions: {
			length_meters: 25.9,
			articulated_sections: 1,
			levels: 3,
			doors: 2,
		},
		livery: {
			style: "Two-tone",
			hex_color: "#29621A",
		},
		capacity: {
			seating: 136,
			bicycles: 2,
			wheelchair_bays: 4,
			restrictions: [],
		},
		amenities: {
			restrooms: { total: 1, is_accessible: true },
			climate_control: { has_ac: true },
			connectivity: {
				has_wifi: true,
				wifi_notes: "GO Wi-Fi Plus",
				has_power_outlets: true,
				has_usb_ports: true,
			},
		},
		accessibility: {
			is_fully_accessible: true,
			boarding_steps: 0,
			ramp: { is_available: true },
			passenger_info: {
				audio_announcements: true,
				visual_next_stop_display: true,
			},
		},
	},
	{
		type: "Cab Car",
		series_ranges: [{ from: 251, to: 257 }],
		description: {
			model_year: 2008,
			model_year_end: 2015,
			manufacturer: "Bombardier Transportation",
			model: "BiLevel Series VIII Cab Car",
			fuel_type: "Unpowered Railcar",
		},
		dimensions: {
			length_meters: 25.9,
			articulated_sections: 1,
			levels: 3,
			doors: 2,
		},
		livery: {
			style: "Two-tone",
			hex_color: "#29621A",
		},
		capacity: {
			seating: 148,
			bicycles: 0,
			wheelchair_bays: 0,
			restrictions: [],
		},
		amenities: {
			restrooms: { total: 1, is_accessible: true },
			climate_control: { has_ac: true },
			connectivity: {
				has_wifi: true,
				wifi_notes: "GO Wi-Fi Plus",
				has_power_outlets: true,
				has_usb_ports: true,
			},
		},
		accessibility: {
			is_fully_accessible: false,
			boarding_steps: 2,
			ramp: { is_available: false },
			passenger_info: {
				audio_announcements: true,
				visual_next_stop_display: true,
			},
		},
	},
	{
		type: "Coach",
		series_ranges: [{ from: 4000, to: 4245 }],
		description: {
			model_year: 2015,
			model_year_end: 2020,
			manufacturer: "Bombardier Transportation",
			model: "BiLevel Series 10 (CEM) Coach",
			fuel_type: "Unpowered Railcar",
		},
		dimensions: {
			length_meters: 25.9,
			articulated_sections: 1,
			levels: 3,
			doors: 2,
		},
		livery: {
			style: "Two-tone",
			hex_color: "#29621A",
		},
		capacity: {
			seating: 150,
			bicycles: 2,
			wheelchair_bays: 0,
			restrictions: ["Crash Energy Management features"],
		},
		amenities: {
			restrooms: { total: 1, is_accessible: false },
			climate_control: { has_ac: true },
			connectivity: {
				has_wifi: true,
				wifi_notes: "GO Wi-Fi Plus",
				has_power_outlets: true,
				has_usb_ports: true,
			},
		},
		accessibility: {
			is_fully_accessible: false,
			boarding_steps: 2,
			ramp: { is_available: false },
			passenger_info: {
				audio_announcements: true,
				visual_next_stop_display: true,
			},
		},
	},
	{
		type: "Accessible Coach",
		series_ranges: [{ from: 4500, to: 4534 }],
		description: {
			model_year: 2015,
			model_year_end: 2020,
			manufacturer: "Bombardier Transportation",
			model: "BiLevel Series 10 (CEM) Accessible Coach",
			fuel_type: "Unpowered Railcar",
		},
		dimensions: {
			length_meters: 25.9,
			articulated_sections: 1,
			levels: 3,
			doors: 2,
		},
		livery: {
			style: "Two-tone",
			hex_color: "#29621A",
		},
		capacity: {
			seating: 136,
			bicycles: 2,
			wheelchair_bays: 4,
			restrictions: ["Crash Energy Management features"],
		},
		amenities: {
			restrooms: { total: 1, is_accessible: true },
			climate_control: { has_ac: true },
			connectivity: {
				has_wifi: true,
				wifi_notes: "GO Wi-Fi Plus",
				has_power_outlets: true,
				has_usb_ports: true,
			},
		},
		accessibility: {
			is_fully_accessible: true,
			boarding_steps: 0,
			ramp: { is_available: true },
			passenger_info: {
				audio_announcements: true,
				visual_next_stop_display: true,
			},
		},
	},
	{
		type: "Cab Car",
		series_ranges: [{ from: 300, to: 380 }],
		description: {
			model_year: 2015,
			model_year_end: 2020,
			manufacturer: "Bombardier Transportation",
			model: "BiLevel Series 10 (CEM) Cab Car",
			fuel_type: "Unpowered Railcar",
		},
		dimensions: {
			length_meters: 25.9,
			articulated_sections: 1,
			levels: 3,
			doors: 2,
		},
		livery: {
			style: "Two-tone",
			hex_color: "#29621A",
		},
		capacity: {
			seating: 130, // CEM cab is much larger
			bicycles: 0,
			wheelchair_bays: 0,
			restrictions: ["Crash Energy Management features", "Raised operator cab"],
		},
		amenities: {
			restrooms: { total: 1, is_accessible: true },
			climate_control: { has_ac: true },
			connectivity: {
				has_wifi: true,
				wifi_notes: "GO Wi-Fi Plus",
				has_power_outlets: true,
				has_usb_ports: true,
			},
		},
		accessibility: {
			is_fully_accessible: false,
			boarding_steps: 2,
			ramp: { is_available: false },
			passenger_info: {
				audio_announcements: true,
				visual_next_stop_display: true,
			},
		},
	},

	// --- UP Express DMUs ---
	{
		type: "DMU",
		series_ranges: [{ from: 1001, to: 1014 }],
		description: {
			model_year: 2014,
			manufacturer: "Nippon Sharyo",
			model: "Type A DMU (UP Express)",
			fuel_type: "Diesel-electric", // Tier 4 engines
			power_hp: 760,
		},
		dimensions: {
			length_meters: 25.9,
			articulated_sections: 1,
			levels: 1,
			doors: 4, // 2 per side
		},
		livery: {
			style: "Two-tone", // UP Express Livery (Tan/Orange/Blue)
			hex_color: "#E26E26",
		},
		capacity: {
			seating: 60,
			bicycles: 0,
			wheelchair_bays: 2,
			restrictions: ["Dedicated airport service"],
		},
		amenities: {
			restrooms: { total: 1, is_accessible: true },
			climate_control: { has_ac: true },
			connectivity: {
				has_wifi: true,
				has_power_outlets: true,
				has_usb_ports: false,
			},
		},
		accessibility: {
			is_fully_accessible: true,
			boarding_steps: 0,
			ramp: { is_available: true },
			passenger_info: {
				audio_announcements: true,
				visual_next_stop_display: true,
			},
		},
	},
	{
		type: "DMU",
		series_ranges: [{ from: 3001, to: 3006 }],
		description: {
			model_year: 2014,
			manufacturer: "Nippon Sharyo",
			model: "Type C DMU (UP Express)",
			fuel_type: "Diesel-electric",
			power_hp: 760,
		},
		dimensions: {
			length_meters: 25.9,
			articulated_sections: 1,
			levels: 1,
			doors: 4,
		},
		livery: {
			style: "Two-tone",
			hex_color: "#E26E26",
		},
		capacity: {
			seating: 60,
			bicycles: 0,
			wheelchair_bays: 2,
			restrictions: ["Dedicated airport service"],
		},
		amenities: {
			restrooms: { total: 1, is_accessible: true },
			climate_control: { has_ac: true },
			connectivity: {
				has_wifi: true,
				has_power_outlets: true,
				has_usb_ports: false,
			},
		},
		accessibility: {
			is_fully_accessible: true,
			boarding_steps: 0,
			ramp: { is_available: true },
			passenger_info: {
				audio_announcements: true,
				visual_next_stop_display: true,
			},
		},
	},
];

import { BILEVEL_REGISTRY } from "./bilevel_registry.js";

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
