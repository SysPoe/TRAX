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
		series_ranges: [{ from: 2000, to: 2079 }],
		description: {
			model_year: 1976,
			model_year_end: 1978,
			manufacturer: "Hawker Siddeley Canada",
			model: "BiLevel Series I Coach",
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
			boarding_steps: 1,
			ramp: { is_available: false },
			passenger_info: {
				audio_announcements: true,
				visual_next_stop_display: false,
			},
		},
		series_notes: [
			"GO Transit 2000-2079 are Hawker Siddeley Canada Bilevel coaches built between 1976 and 1978 at a cost of $35 million ($437,500 a piece) (1976 $CDN). The 80 cars of this order was at the time GO's largest single order of equipment. When delivered, starting in March 1977, they were used predominantly on the Lakeshore Corridor but soon made it to other lines as services were added and ridership increased.",
			'The BiLevel design (as it is now known) was arrived at expressly at GO Transit\'s behest. In the early 1970s, GO quickly found out that the single-level cars then being used were simply not able to provide the capacity required within the track time that they were been allotted by CN. After tests with leased "Gallery-style" equipment from C&NW and later CPR, it was decided that an entirely new car design would be the best way to attack the problem.',
			"In the late-1990s, in the midst of a funding cutback and ridership slump, GO would sell 16 coaches to TRE, along with F59 locomotives 565-568. A year later, GO exchanged 5 of the coaches for two cab cars, 223 and 224. One other car, 2010, would be bought outright by GO.",
			"Refurbishment (1998): These cars underwent their first refurbishment starting in 1998, giving them more modern features and interior. A portion were refurbished by CAD Railway Services and the remaining portion were done by GEC Alsthom. Features included updated seats with improved ergonomics, taller headrests, and new flooring.",
			"Second Refurbishment (2015-2019): Series I Bilevels underwent a second refurbishment by CAD Railway Services. Changes include pale green fabric seat cushions, taller warm grey vinyl headrests, new grey ceilings and side walls, and LED exterior step lights.",
		],
	},
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
				has_power_outlets: false,
				has_usb_ports: false,
			},
		},
		accessibility: {
			is_fully_accessible: false,
			boarding_steps: 1,
			ramp: { is_available: false },
			passenger_info: {
				audio_announcements: true,
				visual_next_stop_display: false,
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
			style: "Two-tone",
			hex_color: "#29621A",
		},
		capacity: {
			seating: 161,
			bicycles: 2,
			wheelchair_bays: 0,
			restrictions: [],
		},
		amenities: {
			restrooms: { total: 0, is_accessible: false },
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
			boarding_steps: 1,
			ramp: { is_available: false },
			passenger_info: {
				audio_announcements: true,
				visual_next_stop_display: false,
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
			boarding_steps: 1,
			ramp: { is_available: false },
			passenger_info: {
				audio_announcements: true,
				visual_next_stop_display: false,
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
			bicycles: 2,
			wheelchair_bays: 0,
			restrictions: [],
		},
		amenities: {
			restrooms: { total: 0, is_accessible: false },
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
			boarding_steps: 1,
			ramp: { is_available: false },
			passenger_info: {
				audio_announcements: true,
				visual_next_stop_display: false,
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
			boarding_steps: 1,
			ramp: {
				is_available: false,
			},
			passenger_info: {
				audio_announcements: true,
				visual_next_stop_display: false,
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
			seating: 160,
			bicycles: 2,
			wheelchair_bays: 0,
			restrictions: [],
		},
		amenities: {
			restrooms: { total: 0, is_accessible: false },
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
			boarding_steps: 1,
			ramp: { is_available: false },
			passenger_info: {
				audio_announcements: true,
				visual_next_stop_display: false,
			},
		},
	},
	{
		type: "Coach",
		series_ranges: [{ from: 2400, to: 2455 }],
		description: {
			model_year: 1990,
			manufacturer: "Can-Car Rail / UTDC",
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
			style: "Two-tone",
			hex_color: "#29621A",
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
			boarding_steps: 1,
			ramp: { is_available: false },
			passenger_info: {
				audio_announcements: true,
				visual_next_stop_display: false,
			},
		},
	},
	{
		type: "Coach",
		series_ranges: [{ from: 2499, to: 2499 }],
		description: {
			model_year: 1990,
			manufacturer: "Can-Car Rail / UTDC",
			model: "BiLevel Series V Prototype Coach",
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
			seating: 147,
			bicycles: 2,
			wheelchair_bays: 0,
			restrictions: [],
		},
		amenities: {
			restrooms: { total: 2, is_accessible: true },
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
			boarding_steps: 1,
			ramp: { is_available: false },
			passenger_info: {
				audio_announcements: true,
				visual_next_stop_display: false,
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
			seating: 133,
			bicycles: 2,
			wheelchair_bays: 8,
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
			boarding_steps: 1,
			ramp: {
				is_available: true,
				deployment_notes:
					"Ramp put out by Customer Service Ambassador from a door in the accessability coach at all stops. Board from the ramped mini-platform on the train platform.",
			},
			passenger_info: {
				audio_announcements: true,
				visual_next_stop_display: false,
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
			seating: 151,
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
			boarding_steps: 1,
			ramp: { is_available: false },
			passenger_info: {
				audio_announcements: true,
				visual_next_stop_display: false,
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
			seating: 133,
			bicycles: 2,
			wheelchair_bays: 8,
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
			boarding_steps: 1,
			ramp: {
				is_available: true,
				deployment_notes:
					"Ramp put out by Customer Service Ambassador from a door in the accessability coach at all stops. Board from the ramped mini-platform on the train platform.",
			},
			passenger_info: {
				audio_announcements: true,
				visual_next_stop_display: false,
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
			seating: 147,
			bicycles: 2,
			wheelchair_bays: 0,
			restrictions: ["Full-width cab"],
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
			boarding_steps: 1,
			ramp: { is_available: false },
			passenger_info: {
				audio_announcements: true,
				visual_next_stop_display: false,
			},
		},
	},
	{
		type: "Coach",
		series_ranges: [
			{ from: 2700, to: 2742 },
			{ from: 2747, to: 2857 },
		],
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
			style: "Bilevel",
			hex_color: "#008341",
		},
		capacity: {
			seating: 151,
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
			boarding_steps: 1,
			ramp: { is_available: false },
			passenger_info: {
				audio_announcements: true,
				visual_next_stop_display: false,
			},
		},
	},
	{
		type: "Coach",
		series_ranges: [{ from: 2743, to: 2746 }],
		description: {
			model_year: 2010,
			manufacturer: "Bombardier Transportation",
			model: "BiLevel Series VIII Bicycle Coach",
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
			seating: 100,
			bicycles: 18,
			wheelchair_bays: 0,
			restrictions: ["Bicycle coach"],
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
			boarding_steps: 1,
			ramp: { is_available: false },
			passenger_info: {
				audio_announcements: true,
				visual_next_stop_display: false,
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
			style: "Bilevel",
			hex_color: "#008341",
		},
		capacity: {
			seating: 133,
			bicycles: 2,
			wheelchair_bays: 8,
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
			boarding_steps: 1,
			ramp: {
				is_available: true,
				deployment_notes:
					"Ramp put out by Customer Service Ambassador from a door in the accessability coach at all stops. Board from the ramped mini-platform on the train platform.",
			},
			passenger_info: {
				audio_announcements: true,
				visual_next_stop_display: false,
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
			style: "Bilevel",
			hex_color: "#008341",
		},
		capacity: {
			seating: 147,
			bicycles: 2,
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
			boarding_steps: 1,
			ramp: { is_available: false },
			passenger_info: {
				audio_announcements: true,
				visual_next_stop_display: false,
			},
		},
	},
	{
		type: "Coach",
		series_ranges: [{ from: 4000, to: 4245 }],
		description: {
			model_year: 2016,
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
			seating: 151,
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
			boarding_steps: 1,
			ramp: { is_available: false },
			passenger_info: {
				audio_announcements: true,
				visual_next_stop_display: false,
			},
		},
	},
	{
		type: "Accessible Coach",
		series_ranges: [{ from: 4500, to: 4534 }],
		description: {
			model_year: 2017,
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
			seating: 133,
			bicycles: 2,
			wheelchair_bays: 8,
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
			boarding_steps: 1,
			ramp: {
				is_available: true,
				deployment_notes:
					"Ramp put out by Customer Service Ambassador from a door in the accessability coach at all stops. Board from the ramped mini-platform on the train platform.",
			},
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
			seating: 147,
			bicycles: 2,
			wheelchair_bays: 0,
			restrictions: ["Crash Energy Management features", "Raised operator cab"],
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
			boarding_steps: 1,
			ramp: { is_available: false },
			passenger_info: {
				audio_announcements: true,
				visual_next_stop_display: false,
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
