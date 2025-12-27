import { CacheContext, getAugmentedTripInstance, getAugmentedTrips, getTripUpdates } from "../../cache.js";
import { GTFS, StopTime } from "qdf-gtfs";
import { GTHADeparturesResponse, UPEDeparturesResponse } from "./types.js";
import logger from "../../utils/logger.js";
import { getServiceDayStart } from "../../utils/time.js";
import { isConsideredTripId } from "../../utils/considered.js";

const GO_LOOKAHEAD_SECS = 600;
const PLATFORM_LOOKAHEAD_SECS = 7200;
const GOTRACKER_REFERRER = "https://www.gotracker.ca/gotracker/web/";
const GOTRACKER_THROTTLE_MS = 2 * 60 * 1000;
const GOTRACKER_EXCLUDED_STOPS = new Set(["PA", "UN"]);

let prevs: {
	tripInstanceId: string;
	stopId: string;
	actualPlatform: string | null;
	scheduledPlatform: string | null;
}[] = [];
let lastGoTrackerFetchMs: Record<string, number> = {};

function applyPlatformUpdate(
	stopTime: {
		instance_id: string;
		actual_stop_id?: string | null;
		scheduled_stop_id?: string | null;
		actual_platform_code?: string | null;
		scheduled_platform_code?: string | null;
		rt_platform_code_updated?: boolean;
	},
	stopId: string,
	platform: string | null,
	scheduledPlatform: string | null,
) {
	// If the RT feed sends null, keep previously known values.
	const newActual = platform ?? stopTime.actual_platform_code ?? null;
	const newScheduled = scheduledPlatform ?? stopTime.scheduled_platform_code ?? null;

	const changed =
		newActual !== stopTime.actual_platform_code ||
		newScheduled !== stopTime.scheduled_platform_code ||
		!stopTime.rt_platform_code_updated;
	if (!changed) return;

	prevs = prevs.filter((v) => !(v.tripInstanceId === stopTime.instance_id && v.stopId === stopId));
	prevs.push({
		tripInstanceId: stopTime.instance_id,
		stopId,
		actualPlatform: newActual,
		scheduledPlatform: newScheduled,
	});

	stopTime.actual_platform_code = newActual;
	stopTime.scheduled_platform_code = newScheduled;
	stopTime.rt_platform_code_updated = true;
}

function toServiceDate(epochMs: number | undefined) {
	if (epochMs === undefined || Number.isNaN(epochMs)) return undefined;
	return new Date(epochMs).toISOString().slice(0, 10).replace(/-/g, "");
}

function parseSerializedDate(serialized: string | undefined) {
	if (!serialized) return undefined;
	const match = /\/Date\((?<ms>-?\d+)\)\//.exec(serialized);
	if (!match?.groups?.ms) return undefined;
	return Number.parseInt(match.groups.ms, 10);
}

function parseGoTrackerPayload(raw: string) {
	const match = raw.match(/<Data>(.*)<\/Data>/s);
	if (!match?.[1]) return undefined;
	try {
		return JSON.parse(match[1]);
	} catch {
		return undefined;
	}
}

const lines = {
	DA: ["Lakeshore East", "Stouffville"],
	SC: ["Lakeshore East", "Stouffville"],
	KE: ["Stouffville"],
	AG: ["Stouffville"],
	MK: ["Stouffville"],
	UI: ["Stouffville"],
	CE: ["Stouffville"],
	MR: ["Stouffville"],
	MJ: ["Stouffville"],
	ST: ["Stouffville"],
	LI: ["Stouffville"],
	DW: ["Barrie"],
	RU: ["Barrie"],
	MP: ["Barrie"],
	KC: ["Barrie"],
	AU: ["Barrie"],
	NE: ["Barrie"],
	EA: ["Barrie"],
	BD: ["Barrie"],
	BA: ["Barrie"],
	AD: ["Barrie"],
	BL: ["Kitchener"],
	MD: ["Kitchener"],
	WE: ["Kitchener"],
	ET: ["Kitchener"],
	MA: ["Kitchener"],
	BE: ["Kitchener"],
	BR: ["Kitchener"],
	MO: ["Kitchener"],
	GE: ["Kitchener"],
	AC: ["Kitchener"],
	GL: ["Kitchener"],
	KI: ["Kitchener"],
	EG: ["Lakeshore East"],
	GU: ["Lakeshore East"],
	RO: ["Lakeshore East"],
	PIN: ["Lakeshore East"],
	AJ: ["Lakeshore East"],
	WH: ["Lakeshore East"],
	OS: ["Lakeshore East"],
	EX: ["Lakeshore West"],
	MI: ["Lakeshore West"],
	LO: ["Lakeshore West"],
	PO: ["Lakeshore West"],
	CL: ["Lakeshore West"],
	OA: ["Lakeshore West"],
	BO: ["Lakeshore West"],
	AP: ["Lakeshore West"],
	BU: ["Lakeshore West"],
	AL: ["Lakeshore West"],
	HA: ["Lakeshore West"],
	WR: ["Lakeshore West"],
	CF: ["Lakeshore West"],
	SCTH: ["Lakeshore West"],
	NI: ["Lakeshore West"],
	KP: ["Milton"],
	DI: ["Milton"],
	CO: ["Milton"],
	ER: ["Milton"],
	SR: ["Milton"],
	ME: ["Milton"],
	LS: ["Milton"],
	ML: ["Milton"],
	OR: ["Richmond Hill"],
	OL: ["Richmond Hill"],
	LA: ["Richmond Hill"],
	RI: ["Richmond Hill"],
	GO: ["Richmond Hill"],
	BM: ["Richmond Hill"],
};

const corridors = {
	Barrie: "65",
	Kitchener: "31",
	"Lakeshore East": "09",
	"Lakeshore West": "01",
	Milton: "21",
	"Richmond Hill": "61",
	Stouffville: "71",
};

export async function updateGTHAPlatforms(ctx: CacheContext, gtfs: GTFS) {
	const now = new Date();
	const serviceDayStart = getServiceDayStart(now.toISOString().slice(0, 10).replace(/-/g, ""), ctx.config.timezone);
	const nowSecs = Math.floor(now.getTime() / 1000 - serviceDayStart + 86400) % 86400;
	const serviceDateStr = new Date(serviceDayStart * 1000).toISOString().slice(0, 10).replace(/-/g, "");

	const UP_ids = ["UN", "PA", "BL", "MD", "WE"];

	// Stop times in the next 10 minutes (GO departures)
	const stopTimes10m = gtfs
		.getStopTimes({ date: serviceDateStr, start_time: nowSecs, end_time: nowSecs + GO_LOOKAHEAD_SECS })
		.filter((v) => isConsideredTripId(v.trip_id, gtfs))
		.map((v) => ({ stop_id: v.stop_id, trip_id: v.trip_id }))
		.concat(
			getTripUpdates(ctx).flatMap(
				(update) =>
					update.stop_time_updates
						?.filter(
							(stu) =>
								(stu.departure_time ?? stu.arrival_time) &&
								((stu.departure_time ?? stu.arrival_time ?? 0) - nowSecs + 86400) % 86400 <=
									GO_LOOKAHEAD_SECS,
						)
						.map((stu) => ({ stop_id: stu.stop_id, trip_id: update.trip.trip_id })) ?? [],
			),
		)
		.filter((v) => v);

	const stopTimes10mMap = new Map<string, { stop_id: string; trip_id: string }>();
	stopTimes10m.forEach((st) => stopTimes10mMap.set(`${st.stop_id}-${st.trip_id}`, st));
	const uniqueStopTimes10m = Array.from(stopTimes10mMap.values());

	// Stop times in the next 2 hours (UPE)
	const stopTimes2h = gtfs
		.getStopTimes({ date: serviceDateStr, start_time: nowSecs, end_time: nowSecs + PLATFORM_LOOKAHEAD_SECS })
		.filter((v) => isConsideredTripId(v.trip_id, gtfs))
		.map((v) => ({ stop_id: v.stop_id, trip_id: v.trip_id }))
		.concat(
			getTripUpdates(ctx).flatMap(
				(update) =>
					update.stop_time_updates
						?.filter(
							(stu) =>
								(stu.departure_time ?? stu.arrival_time) &&
								((stu.departure_time ?? stu.arrival_time ?? 0) - nowSecs + 86400) % 86400 <=
									PLATFORM_LOOKAHEAD_SECS,
						)
						.map((stu) => ({ stop_id: stu.stop_id, trip_id: update.trip.trip_id })) ?? [],
			),
		)
		.filter((v) => v);

	const stopTimes2hMap = new Map<string, { stop_id: string; trip_id: string }>();
	stopTimes2h.forEach((st) => stopTimes2hMap.set(`${st.stop_id}-${st.trip_id}`, st));
	const uniqueStopTimes2h = Array.from(stopTimes2hMap.values());

	// Stop times for the entire service day (GoTracker)
	const stopTimesGoTracker = gtfs
		.getStopTimes({ date: serviceDateStr, start_time: 0, end_time: 86400 })
		.filter((v) => isConsideredTripId(v.trip_id, gtfs))
		.map((v) => ({ stop_id: v.stop_id, trip_id: v.trip_id }));

	const stopTimesGoTrackerMap = new Map<string, { stop_id: string; trip_id: string }>();
	stopTimesGoTracker.forEach((st) => stopTimesGoTrackerMap.set(`${st.stop_id}-${st.trip_id}`, st));
	const uniqueStopTimesGoTracker = Array.from(stopTimesGoTrackerMap.values());

	const goStopIds = new Set(uniqueStopTimes10m.map((v) => v.stop_id));
	const upStopIds = new Set(uniqueStopTimes2h.filter((v) => UP_ids.includes(v.stop_id)).map((v) => v.stop_id));
	const goTrackerStopIds = new Set(
		uniqueStopTimesGoTracker.filter((v) => !GOTRACKER_EXCLUDED_STOPS.has(v.stop_id)).map((v) => v.stop_id),
	);

	logger.debug(
		`Updating GTHA platforms (GO ${goStopIds.size} | UPE ${upStopIds.size} | GoTracker ${goTrackerStopIds.size})`,
		{
			module: "region-specific/GTHA/realtime",
			function: "updateGTHAPlatforms",
		},
	);

	prevs.forEach((v) => {
		let ti = getAugmentedTripInstance(ctx, v.tripInstanceId);
		if (!ti) return;
		let st = ti.stopTimes.find((st) => (st.actual_stop_id ?? st.scheduled_stop_id) === v.stopId);
		if (!st) return;

		st.actual_platform_code = v.actualPlatform;
		st.scheduled_platform_code = v.scheduledPlatform;
	});

	await Promise.all([
		...Array.from(goStopIds).map(async (stop_id) => {
			try {
				const url = `https://api.metrolinx.com/external/go/departures/stops/${stop_id}/departures?page=1&pageLimit=10`;
				const response = await fetch(url);
				if (!response.ok) return;

				const data: GTHADeparturesResponse = await response.json();

				for (const departure of data.trainDepartures.items) {
					const tripNumber = departure.tripNumber;
					let platform = departure.platform.replaceAll("-", "").trim() === "" ? null : departure.platform;
					let scheduledPlatform =
						departure.scheduledPlatform?.replaceAll("-", "")?.trim() === ""
							? null
							: departure.scheduledPlatform;

					if (!platform && scheduledPlatform) platform = scheduledPlatform;
					if (!scheduledPlatform && platform) scheduledPlatform = platform;

					for (const st of uniqueStopTimes10m) {
						if (!st.trip_id.endsWith(tripNumber)) continue;
						const augmentedStopTimes = getAugmentedTrips(ctx, st.trip_id)[0]?.instances.find((v) => {
							if (v.serviceDate === departure.scheduledDateTime.slice(0, 10).replace(/-/g, ""))
								return true;
							let offset = v.stopTimes.find(
								(st) => st.actual_stop_id === stop_id,
							)?.scheduled_departure_date_offset;

							if (!offset) return false;

							let prevDate = new Date(
								Date.UTC(
									Number.parseInt(departure.scheduledDateTime.slice(0, 4)),
									Number.parseInt(departure.scheduledDateTime.slice(5, 7)) - 1,
									Number.parseInt(departure.scheduledDateTime.slice(8, 10)),
								),
							);
							prevDate.setDate(prevDate.getDate() - offset);

							if (prevDate.toUTCString().slice(0, 10).replaceAll(/-/g, "") === v.serviceDate) return true;
							return false;
						})?.stopTimes;

						if (augmentedStopTimes) {
							const ast = augmentedStopTimes.find((ast) => ast.actual_stop_id === st.stop_id);

							if (ast?.actual_stop_id === stop_id) {
								if (platform !== null || scheduledPlatform !== null) {
									applyPlatformUpdate(ast, stop_id, platform, scheduledPlatform);
								}
							}
						}
					}
				}
			} catch (e) {
				logger.error(`Failed to update GO platforms for stop ${stop_id}`, {
					error: e,
					module: "region-specific/GTHA/realtime",
					function: "updateGTHAPlatforms",
				});

				console.error(e);
			}
		}),
		...Array.from(upStopIds).map(async (stop_id) => {
			try {
				const upeUrl = `https://api.metrolinx.com/external/upe/tdp/up/departures/${stop_id}`;
				const upeResponse = await fetch(upeUrl);
				if (upeResponse.ok) {
					const upeData: UPEDeparturesResponse = await upeResponse.json();
					const dateStr = upeData.metadata.timeStamp.slice(0, 10).replace(/-/g, "");

					for (const departure of upeData.departures) {
						const tripNumber = departure.tripNumber;
						let platform = departure.platform.replaceAll("-", "").trim() === "" ? null : departure.platform;

						for (const st of uniqueStopTimes2h) {
							if (!st.trip_id.endsWith(tripNumber)) continue;
							const augmentedStopTimes = getAugmentedTrips(ctx, st.trip_id)[0]?.instances.find(
								(v) => v.serviceDate === dateStr,
							)?.stopTimes;

							if (augmentedStopTimes) {
								const ast = augmentedStopTimes.find((ast) => ast.actual_stop_id === st.stop_id);

								if (ast?.actual_stop_id === stop_id) {
									if (platform !== null) {
										applyPlatformUpdate(ast, stop_id, platform, null);
									}
								}
							}
						}
					}
				}
			} catch (e) {
				logger.error(`Failed to update UPE platforms for stop ${stop_id}`, {
					error: e,
					module: "region-specific/GTHA/realtime",
					function: "updateGTHAPlatforms",
				});

				console.error(e);
			}
		}),
		...Array.from(goTrackerStopIds).map(async (stop_id) => {
			try {
				await maybeUpdatePlatformsFromGoTracker(stop_id, uniqueStopTimesGoTracker, ctx, serviceDateStr);
			} catch (e) {
				logger.error(`Failed to update GoTracker platforms for stop ${stop_id}`, {
					error: e,
					module: "region-specific/GTHA/realtime",
					function: "updateGTHAPlatforms",
				});

				console.error(e);
			}
		}),
	]);
	logger.debug(`Completed updating GTHA platforms`, {
		module: "region-specific/GTHA/realtime",
		function: "updateGTHAPlatforms",
	});
}

async function maybeUpdatePlatformsFromGoTracker(
	stop_id: string,
	stopTimes: { stop_id: string; trip_id: string }[],
	ctx: CacheContext,
	serviceDateStr: string,
) {
	if (GOTRACKER_EXCLUDED_STOPS.has(stop_id)) return;

	const nowMs = Date.now();
	if (nowMs - (lastGoTrackerFetchMs[stop_id] ?? 0) < GOTRACKER_THROTTLE_MS) return;
	lastGoTrackerFetchMs[stop_id] = nowMs;

	const corridor_ids = lines[stop_id as keyof typeof lines]
		.map((v) => corridors[v as keyof typeof corridors])
		.filter((v) => v);

	let TripStatuses: any[] = [];

	for (const corridor_id of corridor_ids) {
		const goTrackerUrl = `https://www.gotracker.ca/GoTracker/web/GODataAPIProxy.svc/StationStatusJSON/Service/StationCd/Lang/${corridor_id}/${stop_id}/en-us?_=${nowMs}`;

		const response = await fetch(goTrackerUrl, { headers: { Referer: GOTRACKER_REFERRER } });
		if (!response.ok) return;

		const raw = await response.text();
		const parsed = parseGoTrackerPayload(raw);
		if (!parsed?.TripStatus) continue;
		TripStatuses = TripStatuses.concat(parsed.TripStatus);
	}

	for (const trip of TripStatuses) {
		if (!trip?.TripNumber || trip.TripNumber === "NoTrip_") continue;

		const platform = (trip.Track ?? trip.UnionArrivePlatform ?? trip.UnionDepartPlatform)?.toString()?.trim();
		if (!platform) continue;

		const parsedServiceDate = toServiceDate(
			parseSerializedDate(trip.EstimatedArrival) ?? parseSerializedDate(trip.Scheduled),
		);
		const targetServiceDate = parsedServiceDate ?? serviceDateStr;

		for (const st of stopTimes) {
			if (st.stop_id !== stop_id) continue;
			if (!st.trip_id.endsWith(trip.TripNumber)) continue;

			const augmentedStopTimes = getAugmentedTrips(ctx, st.trip_id)[0]?.instances.find(
				(v) => v.serviceDate === targetServiceDate,
			)?.stopTimes;

			if (!augmentedStopTimes) continue;
			const ast = augmentedStopTimes.find((ast) => ast.actual_stop_id === st.stop_id);
			if (!ast) continue;

			applyPlatformUpdate(ast, stop_id, platform, null);
		}
	}
}
