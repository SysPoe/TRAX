import { expandWithSRTPassingStops } from "./srt.js";
import logger from "../../../../utils/logger.js";
import { getConsideredStations } from "../../../../utils/stations.js";
import {
	parseTimeWithConfig,
	getTimezoneOffsetSeconds,
	getServiceDate,
	getLocalISOString,
} from "../../../../utils/time.js";
import type {
	QRTDirection,
	QRTGetServiceResponse,
	QRTPlace,
	QRTServiceLine,
	QRTService,
	QRTServiceUpdate,
	QRTTrainMovementDTO,
	QRTTravelStopTime,
	QRTTravelTrip,
} from "./types.js";
import ensureQRTEnabled from "./enabled.js";
import type { TraxConfig } from "../../../../config.js";
import type { CacheContext } from "../../../../cache.js";
import { cacheFileExists, loadCacheFile, writeCacheFile } from "../../../../utils/fs.js";

export { getQRTStations } from "./stations.js";

// ---------------------------------------------------------------------------
// QRT places disk-cache helpers
// ---------------------------------------------------------------------------

const QRT_PLACES_CACHE_FILE = "qrt-places.json";
/** Re-use cached places for up to 6 hours; the list changes very rarely. */
const QRT_PLACES_TTL_MS = 6 * 60 * 60 * 1000;
/** Maximum time we'll wait for a live fetch before falling back to cache. */
const QRT_PLACES_FETCH_TIMEOUT_MS = 10_000;

type QRTPlacesDiskCache = {
	lastUpdated: number;
	data: QRTPlace[];
};

function loadQRTPlacesFromDisk(config: TraxConfig): QRTPlacesDiskCache | null {
	try {
		if (!cacheFileExists(QRT_PLACES_CACHE_FILE, config.cacheDir)) return null;
		return JSON.parse(loadCacheFile(QRT_PLACES_CACHE_FILE, config.cacheDir)) as QRTPlacesDiskCache;
	} catch {
		return null;
	}
}

function saveQRTPlacesToDisk(places: QRTPlace[], config: TraxConfig): void {
	try {
		writeCacheFile(
			QRT_PLACES_CACHE_FILE,
			JSON.stringify({ lastUpdated: Date.now(), data: places }),
			config.cacheDir,
		);
	} catch {
		// Non-fatal — the cache will be re-fetched on the next refresh.
	}
}

/**
 * Fetch QRT places, with disk-cache TTL and fallback.
 *
 * - If the on-disk cache is fresher than TTL: return immediately (no network).
 * - Otherwise: race a live fetch against a timeout.  On success the result is
 *   persisted to disk (fire-and-forget) for next time.  On failure the stale
 *   cached value (if any) is returned so a slow/failed endpoint never blocks
 *   the static-cache refresh.
 */
export async function getPlacesWithCache(config: TraxConfig): Promise<QRTPlace[]> {
	ensureQRTEnabled(config);

	const disk = loadQRTPlacesFromDisk(config);
	if (disk && Date.now() - disk.lastUpdated < QRT_PLACES_TTL_MS) {
		logger.debug(`Using cached QRT places (age ${Math.round((Date.now() - disk.lastUpdated) / 60_000)}m).`, {
			module: "qtt",
			function: "getPlacesWithCache",
		});
		return disk.data;
	}

	try {
		const timeoutPromise = new Promise<never>((_, reject) =>
			setTimeout(() => reject(new Error("QRT places fetch timed out")), QRT_PLACES_FETCH_TIMEOUT_MS),
		);
		const places = await Promise.race([getPlaces(config), timeoutPromise]);
		// Persist to disk asynchronously so we don't delay the caller.
		setImmediate(() => saveQRTPlacesToDisk(places, config));
		return places;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (disk) {
			logger.warn(
				`QRT places fetch failed (${message}); using stale cache (age ${Math.round((Date.now() - disk.lastUpdated) / 60_000)}m).`,
				{
					module: "qtt",
					function: "getPlacesWithCache",
				},
			);
			return disk.data;
		}
		throw error;
	}
}

export async function trackTrain(
	serviceID: string,
	serviceDate: string,
	config: TraxConfig,
): Promise<QRTGetServiceResponse> {
	ensureQRTEnabled(config);
	const url = `https://www.queenslandrailtravel.com.au/SPWebApp/api/ServiceUpdates/GetService?serviceId=${serviceID}&serivceDate=${serviceDate}${
		serviceDate.includes("T") ? "" : "T00:00:00.000Z"
	}`;

	const response = await fetch(url);
	if (!response.ok) {
		const errorText = await response.text();
		logger.error(
			`Failed to fetch service data for ${serviceID} @ "${url}": ${response.status} ${response.statusText} ${errorText}`,
			{
				module: "qtt",
				function: "trackTrain",
			},
		);
		throw new Error(`Failed to fetch: ${response.status} ${response.statusText} ${url}. ${errorText}`);
	}
	const jsonObj = await response.json();
	return jsonObj as QRTGetServiceResponse;
}

export async function getPlaces(config: TraxConfig) {
	ensureQRTEnabled(config);
	let res = await fetch("https://www.queenslandrailtravel.com.au/SPWebApp/api/ContentQuery/GetItems", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			WebUrl: "https://www.queenslandrailtravel.com.au",
			ListName: "QRT Places",
			ViewFields: ["Title", "qrt_PlaceCode"],
			Filters: [],
			OrderByClauses: [{ Field: "Title", Direction: "Asc" }],
		}),
	});
	let json = JSON.parse(await res.json());
	return json as QRTPlace[];
}

export async function getServiceLines(config: TraxConfig) {
	ensureQRTEnabled(config);
	let res = await fetch("https://www.queenslandrailtravel.com.au/SPWebApp/api/ServiceUpdates/AllServices");
	if (!res.ok) {
		logger.error(`Failed to fetch service lines: ${res.status} ${res.statusText}`, {
			module: "qtt",
			function: "getServiceLines",
		});
		throw new Error(`Failed to fetch: ${res.status} ${res.statusText}`);
	}
	let json = await res.json();
	return json.ServiceLines as QRTServiceLine[];
}

export async function getAllServices(config: TraxConfig) {
	ensureQRTEnabled(config);
	let res = await fetch("https://www.queenslandrailtravel.com.au/SPWebApp/api/ContentQuery/GetItems", {
		body: JSON.stringify({
			WebUrl: "https://www.queenslandrailtravel.com.au",
			ListName: "QRT Services",
			ViewFields: ["Title", "qrt_ServiceLine", "qrt_Direction", "qrt_Destination", "qrt_Origin"],
		}),
		headers: {
			"Content-Type": "application/json",
		},
		method: "POST",
	});
	const responseText = await res.json();
	const json = JSON.parse(responseText);
	logger.debug(`Successfully fetched ${json.length} services`, {
		module: "qtt",
		function: "getAllServices",
	});
	return json as QRTService[];
}

export async function getServiceUpdates(
	config: TraxConfig,
	startDate?: string,
	endDate?: string,
): Promise<QRTServiceUpdate[]> {
	ensureQRTEnabled(config);
	const now = new Date();

	// Get start of current month in target timezone
	const startOfMonth = new Date(now);
	startOfMonth.setDate(1);
	startOfMonth.setHours(0, 0, 0, 0);

	const defaultStart = getServiceDate(startOfMonth, config.timezone).slice(0, 8); // This gives YYYYMMDD
	// But it seems it wants YYYY-MM-DD for start/end variables in this context
	const start = startDate ?? getLocalISOString(startOfMonth, config.timezone).slice(0, 10);

	const endOfNextYear = new Date(startOfMonth);
	endOfNextYear.setFullYear(endOfNextYear.getFullYear() + 1);
	const end = endDate ?? getLocalISOString(endOfNextYear, config.timezone).slice(0, 10);

	const offsetSecs = getTimezoneOffsetSeconds(config.timezone, now);
	const isoOffset =
		(offsetSecs >= 0 ? "+" : "-") +
		Math.floor(Math.abs(offsetSecs) / 3600)
			.toString()
			.padStart(2, "0") +
		":" +
		((Math.abs(offsetSecs) % 3600) / 60).toString().padStart(2, "0");

	let res = await fetch("https://www.queenslandrailtravel.com.au/SPWebApp/api/ContentQuery/GetItems", {
		body: JSON.stringify({
			WebUrl: "https://www.queenslandrailtravel.com.au/ServiceUpdates",
			ListName: "Pages",
			ViewFields: [
				"Title",
				"qrt_StartServiceDate",
				"qrt_EndServiceDate",
				"qrt_Status",
				"qrt_ServiceIds",
				"ContentType",
				"FileRef",
				"qrt_CoachReplacement",
				"qrt_SummaryMessage",
			],
			Filters: [
				{
					Field: "qrt_EndServiceDate",
					Operand: "Geq",
					FieldType: "DateTime",
					IncludeTimeValue: false,
					Values: [start + "T00:00:00" + isoOffset],
					NextJoin: "And",
				},
				{
					Field: "qrt_StartServiceDate",
					Operand: "Leq",
					FieldType: "DateTime",
					IncludeTimeValue: false,
					Values: [end + "T00:00:00" + isoOffset],
					NextJoin: "And",
				},
			],
			OrderByClauses: [{ Field: "qrt_Status", Direction: "Asc" }],
		}),
		method: "POST",
	});
	const responseText = await res.json();
	const json = JSON.parse(responseText);
	logger.debug(`Successfully fetched ${json.length} service updates`, {
		module: "qtt",
		function: "getServiceUpdates",
	});
	return json as QRTServiceUpdate[];
}

function convertQRTServiceToTravelTrip(
	service: QRTService,
	serviceResponse: QRTGetServiceResponse,
	direction: string,
	line: string,
	ctx: CacheContext,
): QRTTravelTrip {
	const serviceMeta = serviceResponse;
	const gtfsStops = getConsideredStations(ctx);
	const stops: QRTTravelStopTime[] = (serviceResponse.TrainMovements as QRTTrainMovementDTO[]).map((movement) => {
		let arrivalDelaySeconds: number | null = null;
		let departureDelaySeconds: number | null = null;
		let delayString = "scheduled";
		let delayClass: "on-time" | "scheduled" | "late" | "very-late" | "early" = "scheduled";

		if (
			movement.PlannedArrival &&
			movement.ActualArrival &&
			movement.PlannedArrival !== "0001-01-01T00:00:00" &&
			movement.ActualArrival !== "0001-01-01T00:00:00"
		) {
			const plannedArr = parseTimeWithConfig(movement.PlannedArrival, ctx.config.timezone);
			const actualArr = parseTimeWithConfig(movement.ActualArrival, ctx.config.timezone);
			arrivalDelaySeconds = Math.round((actualArr - plannedArr) / 1000);
		}
		if (
			movement.PlannedDeparture &&
			movement.ActualDeparture &&
			movement.PlannedDeparture !== "0001-01-01T00:00:00" &&
			movement.ActualDeparture !== "0001-01-01T00:00:00"
		) {
			const plannedDep = parseTimeWithConfig(movement.PlannedDeparture, ctx.config.timezone);
			const actualDep = parseTimeWithConfig(movement.ActualDeparture, ctx.config.timezone);
			departureDelaySeconds = Math.round((actualDep - plannedDep) / 1000);
			const delaySecs = departureDelaySeconds;
			if (delaySecs !== null) {
				if (Math.abs(delaySecs) <= 60) {
					delayString = "on time";
					delayClass = "on-time";
				} else if (delaySecs > 0 && delaySecs <= 300) {
					delayString = `${Math.round(delaySecs / 60)}m late`;
					delayClass = "late";
				} else if (delaySecs > 300) {
					delayString = `${Math.round(delaySecs / 60)}m late`;
					delayClass = "very-late";
				} else {
					delayString = `${Math.round(Math.abs(delaySecs) / 60)}m early`;
					delayClass = "early";
				}
			}
		}

		let actualArrival =
			movement.ActualArrival == "0001-01-01T00:00:00" ? movement.PlannedArrival : movement.ActualArrival;
		let actualDeparture =
			movement.ActualDeparture == "0001-01-01T00:00:00" ? movement.PlannedDeparture : movement.ActualDeparture;

		let arrivalDelayInfo = getDelay(
			arrivalDelaySeconds,
			actualArrival === "0001-01-01T00:00:00" ? movement.PlannedArrival : actualArrival,
			ctx.config,
		);
		let departureDelayInfo = getDelay(
			departureDelaySeconds,
			actualDeparture === "0001-01-01T00:00:00" ? movement.PlannedDeparture : actualDeparture,
			ctx.config,
		);

		type DelayClass = "on-time" | "scheduled" | "late" | "very-late" | "early";

		let gtfsStopId: string | null = null;
		let findRes = gtfsStops.find(
			(v) =>
				v.stop_name?.toLowerCase().replace("station", "").trim() ===
				movement.PlaceName.toLowerCase().replace("station", "").trim(),
		);
		if (findRes) gtfsStopId = findRes.stop_id;
		if (movement.PlaceName.toLowerCase().includes("roma st")) gtfsStopId = "place_romsta";

		let toRet: QRTTravelStopTime = {
			placeCode: movement.PlaceCode,
			placeName: movement.PlaceName,
			gtfsStopId,
			kStation: movement.KStation,
			status: movement.Status,
			trainPosition: movement.TrainPosition,
			plannedArrival: movement.PlannedArrival,
			plannedDeparture: movement.PlannedDeparture,
			actualArrival,
			actualDeparture,
			arrivalDelaySeconds,
			departureDelaySeconds,
			arrivalDelayClass:
				actualArrival === "0001-01-01T00:00:00" ? (arrivalDelayInfo.delayClass as DelayClass) : undefined,
			arrivalDelayString: actualArrival === "0001-01-01T00:00:00" ? arrivalDelayInfo.delayString : undefined,
			departureDelayClass:
				actualDeparture === "0001-01-01T00:00:00" ? (departureDelayInfo.delayClass as DelayClass) : undefined,
			departureDelayString:
				actualDeparture === "0001-01-01T00:00:00" ? departureDelayInfo.delayString : undefined,
		};
		return toRet;
	});

	const runChars: { [key: string]: string } = {
		Gulflander: "5",
		"Kuranda Scenic Railway": "3",
	};

	return {
		trip_number:
			service.Title.split(" ")[0].length == 4
				? service.Title.split(" ")[0]
				: `${runChars[line] ?? "?"}${serviceMeta.ServiceId.slice(0, 3)}`,
		serviceId: serviceMeta.ServiceId,
		serviceName: service.Title,
		direction,
		line,
		status: serviceMeta.QRTServiceDisruption?.Status ?? "Scheduled",
		offersGoldClass: false,
		serviceDate: serviceMeta.Modified,
		departureDate: stops[0]?.plannedDeparture ?? "",
		stops,
		disruption: serviceMeta.QRTServiceDisruption,
	};
}

function getDelay(delaySecs: number | null = null, departureTime: string | null, config: TraxConfig) {
	if (delaySecs === null || departureTime === null) return { delayString: "scheduled", delayClass: "scheduled" };

	let departsInSecs = Math.round(parseTimeWithConfig(departureTime, config.timezone) - Date.now()) / 1000;
	departsInSecs = Math.round(departsInSecs / 60) * 60;
	const roundedDelay = delaySecs ? Math.round(delaySecs / 60) * 60 : null;
	const delayString =
		delaySecs != null && roundedDelay != null
			? delaySecs == 0
				? "on time"
				: `${Math.floor(roundedDelay / 3600)}h ${Math.floor(
						(Math.abs(roundedDelay) % 3600) / 60,
					)}m ${delaySecs > 0 ? "late" : "early"}`
						.replace(/^0h/, "")
						.trim()
			: "scheduled";
	const delayClass: "very-late" | "late" | "early" | "on-time" | "scheduled" =
		delaySecs != null && roundedDelay != null
			? roundedDelay > 0
				? roundedDelay > 5 * 60
					? "very-late"
					: "late"
				: roundedDelay < 0
					? "early"
					: "on-time"
			: "scheduled";
	return { delayString, delayClass };
}

async function processService(
	serviceLine: QRTServiceLine,
	direction: QRTDirection,
	service: QRTService,
	services: QRTService[],
	ctx: CacheContext,
): Promise<QRTTravelTrip | null> {
	try {
		const serviceResponse = await trackTrain(service.ServiceId, service.ServiceDate, ctx.config);
		const gtfsStops = getConsideredStations(ctx);

		if (serviceResponse.Success) {
			const qrtService = services.find(
				(s) =>
					s.qrt_Direction == direction.DirectionName &&
					s.qrt_ServiceLine.endsWith(serviceLine.ServiceLineName),
			);

			if (qrtService) {
				const travelTrip = convertQRTServiceToTravelTrip(
					qrtService,
					serviceResponse,
					direction.DirectionName,
					serviceLine.ServiceLineName,
					ctx,
				);

				const trainMovements: QRTTrainMovementDTO[] = travelTrip.stops.map((s) => {
					let gtfsStopId: string | null = null;
					let findRes = gtfsStops.find(
						(v) =>
							v.stop_name?.toLowerCase().replace("station", "").trim() ===
							s.placeName.toLowerCase().replace("station", "").trim(),
					);
					if (findRes) gtfsStopId = findRes.stop_id;
					if (s.placeName.toLowerCase().includes("roma st")) gtfsStopId = "place_romsta";
					return {
						PlaceCode: s.placeCode,
						PlaceName: s.placeName,
						gtfsStopId,
						KStation: s.kStation,
						Status: s.status,
						TrainPosition: s.trainPosition,
						PlannedArrival: s.plannedArrival,
						PlannedDeparture: s.plannedDeparture,
						ActualArrival: s.actualArrival,
						ActualDeparture: s.actualDeparture,
						ArrivalDelaySeconds: s.arrivalDelaySeconds ?? 0,
						DepartureDelaySeconds: s.departureDelaySeconds ?? 0,
					};
				});
				const expanded = expandWithSRTPassingStops(trainMovements, ctx);
				return {
					...travelTrip,
					stopsWithPassing: expanded,
				};
			} else {
				logger.warn(`No matching QRT service found for service ${service.ServiceId}`, {
					module: "qtt",
					function: "getCurrentQRTravelTrains",
				});
				return null;
			}
		} else {
			logger.warn(`Service response not successful for service ${service.ServiceId}`, {
				module: "qtt",
				function: "getCurrentQRTravelTrains",
			});
			return null;
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logger.warn(`Failed to track service ${service.ServiceId}: ${message}`, {
			module: "qtt",
			function: "getCurrentQRTravelTrains",
		});
		return null;
	}
}

export async function getCurrentQRTravelTrains(ctx: CacheContext, retries = 2): Promise<QRTTravelTrip[]> {
	ensureQRTEnabled(ctx.config);
	try {
		const [services, serviceLines] = await Promise.all([getAllServices(ctx.config), getServiceLines(ctx.config)]);

		const tasks: Promise<QRTTravelTrip | null>[] = [];
		for (const serviceLine of serviceLines) {
			for (const direction of serviceLine.Directions) {
				for (const service of direction.Services) {
					tasks.push(processService(serviceLine, direction, service, services, ctx));
				}
			}
		}

		const results = await Promise.all(tasks);
		const travelTrips = results.filter((trip): trip is QRTTravelTrip => trip !== null);

		return travelTrips;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		let secs = 5 * (3 - retries);
		logger.error(`Failed to get current QR Travel trains: ${message}. Retrying in ${secs} seconds.`, {
			module: "qtt",
			function: "getCurrentQRTravelTrains",
		});
		retries--;
		if (retries > 0) {
			await new Promise((resolve) => setTimeout(resolve, secs * 1000));
			return getCurrentQRTravelTrains(ctx, retries);
		} else {
			throw new Error(`Failed to get current QR Travel trains after multiple retries: ${message}`);
		}
	}
}
