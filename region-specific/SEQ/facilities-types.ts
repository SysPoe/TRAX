export interface RailwayStationFacilityOhoursTime {
    days?: string;
    open?: string;
    close?: string;
    status?: string;
    note?: string;
}

export interface RailwayStationFacilityOhoursSection {
    title: string;
    times: RailwayStationFacilityOhoursTime[];
}

export interface RailwayStationFacilityOhours {
    sections?: RailwayStationFacilityOhoursSection[];
    status?: string;
}

export interface PlatformLevelness {
    level: "all" | "partial" | "none";
    note: string;
}

export interface RailwayStationFacilitySginfor {
    [key: string]: PlatformLevelness | string[] | undefined;
    _notes?: string[];
}

export interface RailwayStationFacility {
    title: string;
    ln: string[];
    ohours: RailwayStationFacilityOhours;
    stops: string[];
    sginfor: RailwayStationFacilitySginfor;
    facility_accessible_adult_change_facilities: boolean;
    facility_accessible_kiss_n_ride: boolean;
    facility_accessible_parking: boolean;
    facility_accessible_ramp: boolean;
    facility_accessible_toilet_lh: boolean;
    facility_accessible_toilet_rh: boolean;
    facility_add_value_vending_machine_avvm: boolean;
    facility_assistance_animal_relief_area: boolean;
    facility_assisted_boarding_point: boolean;
    facility_australia_post_parcel_locker: boolean;
    facility_baby_change: boolean;
    facility_bike_enclosure: boolean;
    facility_bike_rack: number;
    facility_boarding_ramp_available: boolean;
    facility_boarding_ramp_required: boolean;
    facility_bus_interchange: boolean;
    facility_bus_stop: boolean;
    facility_carpark: boolean;
    facility_cctv_cameras: boolean;
    facility_customer_information_screens: boolean;
    facility_customer_service_window: boolean;
    facility_drinking_fountain: boolean;
    facility_escalator: boolean;
    facility_fare_gates: boolean;
    facility_hearing_loop_available: boolean;
    facility_help_phone: boolean;
    facility_kiss_n_ride: boolean;
    facility_level_boarding_to_vehicle: boolean;
    facility_level_crossing: boolean;
    facility_lift: boolean;
    facility_limited_access: boolean;
    facility_next_train_information: boolean;
    facility_pedestrian_footbridge: boolean;
    facility_priority_seating: boolean;
    facility_public_phone: boolean;
    facility_refuse_bins: boolean;
    facility_secure_bike_storage: boolean;
    facility_stairs: boolean;
    facility_steep_ramp: boolean;
    facility_tactile_ground_surface_indicators_platform_edges: boolean;
    facility_taxi_bay: boolean;
    facility_ticket_vending_machine: boolean;
    facility_toilets: boolean;
    facility_unattended_site: boolean;
    facility_vending_machine: boolean;
    facility_motorcycle_parking: number;
    facility_station_seating: number;
}
