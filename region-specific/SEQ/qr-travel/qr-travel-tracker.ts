import { expandWithSRTPassingStops } from "./srt.js";
import logger from "../../../utils/logger.js";
import { getConsideredStations } from "../../../utils/stations.js";
import { parseTimeWithConfig, getTimezoneOffsetSeconds } from "../../../utils/time.js";
import type {
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
import { TraxConfig } from "../../../config.js";
import { CacheContext } from "../../../cache.js";

export async function trackTrain(serviceID: string, serviceDate: string, config: TraxConfig): Promise<QRTGetServiceResponse> {
	ensureQRTEnabled(config);
	const url = `https://www.queenslandrailtravel.com.au/SPWebApp/api/ServiceUpdates/GetService?serviceId=${serviceID}&serivceDate=${serviceDate}${serviceDate.includes("T") ? "" : "T00:00:00.000Z"
		}`;

	const response = await fetch(url);
	if (!response.ok) {
		const errorText = await response.text();
		logger.error(`Failed to fetch service data: ${response.status} ${response.statusText}`, {
			module: "qr-travel-tracker",
			function: "trackTrain",
			serviceID,
			url,
			status: response.status,
			statusText: response.statusText,
			errorText,
		});
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
			module: "qr-travel-tracker",
			function: "getServiceLines",
			status: res.status,
			statusText: res.statusText,
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
		module: "qr-travel-tracker",
		function: "getAllServices",
		count: json.length,
	});
	return json as QRTService[];
}

export async function getServiceUpdates(config: TraxConfig, startDate?: string, endDate?: string): Promise<QRTServiceUpdate[]> {
	ensureQRTEnabled(config);
	const offsetMs = getTimezoneOffsetSeconds(config.timezone) * 1000;
	const now = new Date(Date.now() + offsetMs);
	const defaultStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
	const defaultEnd = new Date(defaultStart);
	defaultEnd.setUTCFullYear(defaultEnd.getUTCFullYear() + 1);

	const start = startDate ?? defaultStart.toISOString().slice(0, 10);
	const end = endDate ?? defaultEnd.toISOString().slice(0, 10);

	const isoOffset = (offsetMs >= 0 ? "+" : "-") + 
		Math.floor(Math.abs(offsetMs) / 3600000).toString().padStart(2, "0") + ":" + 
		((Math.abs(offsetMs) % 3600000) / 60000).toString().padStart(2, "0");

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
		module: "qr-travel-tracker",
		function: "getServiceUpdates",
		count: json.length,
	});
	return json as QRTServiceUpdate[];
}

function convertQRTServiceToTravelTrip(
	service: QRTService,
	serviceResponse: QRTGetServiceResponse,
	direction: string,
	line: string,
    ctx: CacheContext
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
			ctx.config
		);
		let departureDelayInfo = getDelay(
			departureDelaySeconds,
			actualDeparture === "0001-01-01T00:00:00" ? movement.PlannedDeparture : actualDeparture,
			ctx.config
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
	};

	return {
		run:
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
	direction: any,
	service: any,
	services: QRTService[],
    ctx: CacheContext
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
                    ctx
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
					module: "qr-travel-tracker",
					function: "getCurrentQRTravelTrains",
				});
				return null;
			}
		} else {
			logger.warn(`Service response not successful for service ${service.ServiceId}`, {
				module: "qr-travel-tracker",
				function: "getCurrentQRTravelTrains",
			});
			return null;
		}
	} catch (error: any) {
		logger.warn(`Failed to track service ${service.ServiceId}: ${error.message ?? error}`, {
			module: "qr-travel-tracker",
			function: "getCurrentQRTravelTrains",
		});
		return null;
	}
}

export async function getCurrentQRTravelTrains(ctx: CacheContext, retries = 5): Promise<QRTTravelTrip[]> {
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
	} catch (error: any) {
		let secs = 5 * (6 - retries);
		logger.error(
			`Failed to get current QR Travel trains: ${error.message ?? error}. Retrying in ${secs} seconds.`,
			{
				module: "qr-travel-tracker",
				function: "getCurrentQRTravelTrains",
				error: error.message ?? error,
			},
		);
		retries--;
		if (retries > 0) {
			await new Promise((resolve) => setTimeout(resolve, secs * 1000));
			return getCurrentQRTravelTrains(ctx, retries);
		} else {
			throw new Error(`Failed to get current QR Travel trains after multiple retries: ${error.message ?? error}`);
		}
	}
}
