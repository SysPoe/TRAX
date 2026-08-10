import type { CacheContext } from "../cache/types.js";
import type { RailwayStationFacility } from "../region-specific/AU/SEQ/facilities-types.js";
import type { PlatformData } from "../utils/platformData.js";
import type { QRTPlace, QRTStations, QRTTravelTrip } from "../region-specific/AU/SEQ/qr-travel/types.js";
import { getPluginState } from "./types.js";

export interface SeqPluginState {
	qrtPlaces: QRTPlace[];
	qrtStations: QRTStations;
	qrtTrains: QRTTravelTrip[];
	platformData?: PlatformData;
	railwayStationFacilities: RailwayStationFacility[];
}

export function getSeqState(ctx: CacheContext): SeqPluginState {
	return getPluginState(ctx, "au-seq:data", () => ({
		qrtPlaces: [], qrtStations: {}, qrtTrains: [], platformData: undefined, railwayStationFacilities: [],
	}));
}
