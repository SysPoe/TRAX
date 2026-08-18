import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import TRAX, {
	NetworkRuntimeRegistry,
	createCaGthaNetwork,
	decodeTripInstanceId,
	encodePublicEntityId,
	decodePublicEntityId,
	createAuVicVlineNetwork,
	normalizeVLineUnit,
	ptvVehicleDescriptorConsist,
	parseVLinePlatformServices,
	parseVLineJourneys,
	parseVLineLocations,
	parseVLineBookingPage,
	parseVLinePlatformArrivals,
	parseVLineScsBoard,
	vlineAccessToken,
	vlinePassengerCars,
	vlineTdn,
	vlineVehicleModel,
	matchChronosRun,
	chronosHourlyToken,
	getChronosRunPattern,
} from "../dist/index.js";
import {
	applyChronosEstimate,
	applyJourneyPlannerService,
	createEmptyVLineDetails,
	matchScsRows,
	serviceMatchesPlatformTrip,
	vlinePlatformStationDemands,
	vlinePlatformStationsDue,
	vlineFormationUnits,
} from "../dist/region-specific/AU/VIC/enrichment.js";
import { getVLineLocations, getVLinePlatformDepartures } from "../dist/region-specific/AU/VIC/journey-planner.js";
import { ptvMetroFormationUnit } from "../dist/region-specific/AU/VIC/ptv-metro.js";
import { viaCarriageCodeDiagramKind, viaCarriageDiagramKind, viaCarriageTypeLabel } from "../dist/plugins/via.js";
import {
	buildVLineRealtimeTripAliases,
	canonicalVLineRealtimeTripId,
} from "../dist/region-specific/AU/VIC/realtime-aliases.js";
import { canonicalizeRealtimeTripUpdate, canonicalizeRealtimeVehiclePosition } from "../dist/cache/realtime.js";
import { findUniqueTripInstanceForServiceDate } from "../dist/cache/augmentedEntities.js";
import { TripScheduleRelationship } from "qdf-gtfs";
import {
	buildCisBoardingAssignments,
	collectCisStationCandidates,
	parseCisStationBoard,
	viaTrainKey,
} from "../dist/region-specific/CA/VIA/station-board.js";
import { selectViaBookingFare } from "../dist/region-specific/CA/VIA/consist.js";
import {
	applyGthaVehicleBearing,
	parseGthaCourse,
} from "../dist/region-specific/CA/GTHA/realtime.js";

assert.deepEqual(
	selectViaBookingFare({
		data: {
			offer: {
				travels: [
					{
						routes: [
							{
								legs: [
									{
										service_schedule_date: "2026-08-16T00:00:00-0400",
										service_name: "VIA50",
										service_identifier: "service-50",
									},
								],
								bundles: [
									{
										items: [
											{
												seat_selection_status: "SEAT_SELECTION_AVAILABLE",
												passenger_fares: [
													{ passenger_id: "passenger_1", tariff_code: "ECOPLUS" },
												],
											},
										],
									},
								],
							},
						],
					},
				],
			},
		},
	}),
	{
		leg: {
			service_schedule_date: "2026-08-16T00:00:00-0400",
			service_name: "VIA50",
			service_identifier: "service-50",
		},
		tariffCode: "ECOPLUS",
	},
);
assert.equal(selectViaBookingFare({ data: { offer: { travels: [{ routes: [] }] } } }), null);

const gthaWithFallbacks = createCaGthaNetwork(["primary", "secondary", "primary"]);
const gthaWithoutKeys = createCaGthaNetwork();
assert.equal(gthaWithoutKeys.name, "Canada Rail");
assert.deepEqual(gthaWithoutKeys.feeds.find((feed) => feed.id === "go").realtimeSources, []);
assert.ok(gthaWithoutKeys.feeds.some((feed) => feed.id === "via"));
const goVehicles = gthaWithFallbacks.feeds
	.find((feed) => feed.id === "go")
	.realtimeSources.find((source) => source.id === "go-vehicles");
assert.match(goVehicles.source.url, /key=primary$/);
assert.deepEqual(goVehicles.source.fallbackUrls, [goVehicles.source.url.replace("primary", "secondary")]);
assert.deepEqual(gthaWithFallbacks.places.find((place) => place.id === "guelph").members, [
	{ feedId: "go", localId: "GL" },
	{ feedId: "via", localId: "70" },
]);
assert.deepEqual(gthaWithFallbacks.places.find((place) => place.id === "toronto-union").members, [
	{ feedId: "go", localId: "UN" },
	{ feedId: "up", localId: "UN" },
	{ feedId: "via", localId: "119" },
]);
assert.deepEqual(gthaWithFallbacks.places.find((place) => place.id === "guildwood").members, [
	{ feedId: "go", localId: "GU" },
	{ feedId: "via", localId: "450" },
]);
assert.deepEqual(gthaWithFallbacks.places.find((place) => place.id === "stratford").members, [
	{ feedId: "go", localId: "SF" },
	{ feedId: "via", localId: "7" },
]);

const goPosition = { feed_id: "go", position: { bearing: 0 } };
assert.equal(parseGthaCourse("223"), 223);
assert.equal(parseGthaCourse(0), 0);
assert.equal(parseGthaCourse(360), 0);
assert.equal(parseGthaCourse("not-a-course"), null);
assert.equal(applyGthaVehicleBearing(goPosition, 223).position.bearing, 223);
assert.equal(applyGthaVehicleBearing(goPosition, 0).position.bearing, 0);
assert.equal(applyGthaVehicleBearing(goPosition, null).position.bearing, null);
assert.equal(
	applyGthaVehicleBearing({ feed_id: "go", position: { bearing: 42 } }, null).position.bearing,
	42,
);
assert.equal(applyGthaVehicleBearing({ feed_id: "via", position: { bearing: 0 } }, null).position.bearing, 0);

assert.equal(vlineTdn("01-GEL--8-T0-8761"), "8761");
assert.equal(vlineTdn("01-GEL--8-T0-87612"), null);
assert.equal(normalizeVLineUnit(" vl 131 "), "VL131");
assert.equal(normalizeVLineUnit("N451"), null);
assert.equal(vlineVehicleModel("N-Set"), "N Class");
assert.equal(vlinePassengerCars("VLocity", 2), 6);
assert.deepEqual(ptvVehicleDescriptorConsist("vic-metro", "1079T-1125T-457M-458M-549M-550M"), [
	"1079T",
	"1125T",
	"457M",
	"458M",
	"549M",
	"550M",
]);
assert.deepEqual(ptvVehicleDescriptorConsist("vic-vline", " V1292 "), ["V1292"]);
assert.equal(ptvVehicleDescriptorConsist("vic-metro", "singleton"), null);
assert.equal(vlinePassengerCars("N-Set", 5), 5);
assert.equal(vlineAccessToken("caller", "signature", "JP_GETPLATFORMDEPARTURES").length, 40);
const vlineNoKey = createAuVicVlineNetwork();
assert.equal(vlineNoKey.id, "au-vic-vline");
assert.equal(vlineNoKey.feeds[0].staticSource.archiveEntry, "1/google_transit.zip");
assert.deepEqual(vlineNoKey.feeds[0].realtimeSources, []);
assert.equal(vlineNoKey.feeds[1].id, "vic-metro");
assert.equal(vlineNoKey.feeds[1].staticSource.archiveEntry, "2/google_transit.zip");
assert.deepEqual(vlineNoKey.places[0].members, [
	{ feedId: "vic-vline", localId: "vic:rail:SSS" },
	{ feedId: "vic-metro", localId: "vic:rail:SSS" },
]);
assert.equal(vlineNoKey.places.length, 17);
assert.ok(vlineNoKey.places.some((place) => place.id === "watergardens"));
const vlineWithKey = createAuVicVlineNetwork({ gtfsRtKey: "test-key" });
assert.deepEqual(
	vlineWithKey.feeds.flatMap((feed) => feed.realtimeSources).map((source) => source.source.headers.KeyId),
	["test-key", "test-key", "test-key", "test-key"],
);

const inferredVLineDetails = createEmptyVLineDetails("8761");
inferredVLineDetails.leadingUnit = { value: "V1292" };
inferredVLineDetails.subtype = { value: "VLocity" };
const inferredVLineUnits = vlineFormationUnits({ passenger_cars: 6 }, inferredVLineDetails);
assert.equal(inferredVLineUnits.length, 6);
assert.equal(inferredVLineUnits[0].id, "V1292");
assert.deepEqual(
	inferredVLineUnits.slice(1).map((unit) => unit.id),
	[null, null, null, null, null],
);
assert.ok(inferredVLineUnits.every((unit) => unit.diagramKind === "dmu"));
assert.deepEqual(
	[ptvMetroFormationUnit("457M"), ptvMetroFormationUnit("1079T")].map((unit) => [
		unit.type,
		unit.model,
		unit.diagramKind,
	]),
	[
		["Motor", "Comeng", "motor"],
		["Trailer", "Comeng", "trailer"],
	],
);
assert.equal(viaCarriageDiagramKind("Baggage car"), "baggage");
assert.equal(viaCarriageDiagramKind("Prestige Sleeper"), "sleeper");
assert.equal(viaCarriageTypeLabel(viaCarriageDiagramKind("SVC")), "Service car");
assert.equal(viaCarriageCodeDiagramKind("CREW", "VIDE - (BAG, CREW, DINER)"), "crew");

const canonicalVLineTripId = "01-BGO--10-T0-8021";
const providerVLineTripId = "01-BGO--3-T0-8021";
const vlineAliasCtx = {
	config: { network: vlineNoKey },
	pluginState: new Map(),
	augmented: {
		tripsRec: new Map([
			[
				`vic-vline\0${canonicalVLineTripId}`,
				{
					feed_id: "vic-vline",
					trip_id: canonicalVLineTripId,
					scheduledStartServiceDates: ["20260814"],
					instances: [
						{
							serviceDate: "20260814",
							stopTimes: [{ passing: false, scheduled_departure_time: 12 * 3600 + 2 * 60 }],
						},
					],
				},
			],
		]),
	},
};
buildVLineRealtimeTripAliases(vlineAliasCtx);
const vlineDescriptor = {
	feed_id: "vic-vline",
	trip_id: providerVLineTripId,
	start_date: "20260814",
	start_time: "12:02:00",
	schedule_relationship: TripScheduleRelationship.SCHEDULED,
};
assert.equal(canonicalVLineRealtimeTripId(vlineDescriptor, vlineAliasCtx), canonicalVLineTripId);
assert.equal(
	canonicalVLineRealtimeTripId(
		{ ...vlineDescriptor, schedule_relationship: TripScheduleRelationship.ADDED },
		vlineAliasCtx,
	),
	providerVLineTripId,
);
const canonicalUpdate = canonicalizeRealtimeTripUpdate(
	{
		trip: vlineDescriptor,
		stop_time_updates: [{ trip_id: providerVLineTripId }],
	},
	vlineAliasCtx,
);
assert.equal(canonicalUpdate.trip.trip_id, canonicalVLineTripId);
assert.equal(canonicalUpdate.stop_time_updates[0].trip_id, canonicalVLineTripId);
assert.equal(
	canonicalizeRealtimeVehiclePosition({ trip: vlineDescriptor }, vlineAliasCtx).trip.trip_id,
	canonicalVLineTripId,
);

const jpServices = parseVLinePlatformServices(`
<GetPlatformDeparturesResult xmlns:a="urn:vline" xmlns:i="urn:nil"><a:PlatformService>
<a:Origin>Melbourne, Southern Cross</a:Origin><a:Destination>Waurn Ponds Station</a:Destination>
<a:ScheduledDepartureTime>2026-08-12T14:50:00</a:ScheduledDepartureTime>
<a:ScheduledDestinationArrivalTime>2026-08-12T16:08:00</a:ScheduledDestinationArrivalTime>
<a:ServiceId>8761</a:ServiceId><a:Platform>4A</a:Platform><a:Direction>D</a:Direction>
<a:ConsistSubType>VLocity</a:ConsistSubType><a:ConsistCount>2</a:ConsistCount>
<a:ConsistVehicles i:nil="true"/><a:IsLiveConsistInfo>true</a:IsLiveConsistInfo><a:ServiceStatus>Planned</a:ServiceStatus>
</a:PlatformService></GetPlatformDeparturesResult>`);
assert.equal(jpServices.length, 1);
assert.deepEqual(jpServices[0], {
	locationName: null,
	origin: "Melbourne, Southern Cross",
	destination: "Waurn Ponds Station",
	scheduledDepartureTime: "2026-08-12T14:50:00",
	scheduledDestinationArrivalTime: "2026-08-12T16:08:00",
	tdn: "8761",
	platform: "4A",
	direction: "Down",
	consistSubtype: "VLocity",
	consistCount: 2,
	consistVehicles: null,
	isLiveConsistInfo: true,
	serviceStatus: "Planned",
	consistDescription: null,
	accessibleSpaces: null,
	bicycleSpaces: null,
	actualArrivalTime: null,
	actualDestinationArrivalTime: null,
	platformEvent: "departure",
	reservationAvailable: false,
	reservationRequired: false,
	reservedCarriages: [],
	reservedSeatsAvailable: null,
	unreservedTicketsAvailable: null,
	canBookInJourneyPlanner: false,
});
const jpArrivals = parseVLinePlatformArrivals(`
<GetPlatformArrivalsResult xmlns:a="urn:vline"><a:PlatformService>
<a:LocationName>Melbourne, Southern Cross</a:LocationName>
<a:Origin>Caroline Springs Station</a:Origin><a:Destination>Melbourne, Southern Cross</a:Destination>
<a:ScheduledDepartureTime>2026-08-12T08:53:00</a:ScheduledDepartureTime>
<a:ScheduledDestinationArrivalTime>2026-08-12T09:25:00</a:ScheduledDestinationArrivalTime>
<a:ActualArrivalTime>2026-08-12T09:31:00</a:ActualArrivalTime>
<a:ActualDestinationArrivalTime>2026-08-12T09:32:00</a:ActualDestinationArrivalTime>
<a:ServiceIdentifier>8301</a:ServiceIdentifier><a:Platform>16</a:Platform><a:Direction>U</a:Direction>
<a:ServiceStatus>Running</a:ServiceStatus><a:CarList>C-F</a:CarList>
</a:PlatformService></GetPlatformArrivalsResult>`);
assert.equal(jpArrivals[0].platformEvent, "arrival");
assert.equal(jpArrivals[0].locationName, "Melbourne, Southern Cross");
assert.equal(jpArrivals[0].platform, "16");
assert.equal(jpArrivals[0].actualArrivalTime, "2026-08-12T09:31:00");
assert.equal(jpArrivals[0].actualDestinationArrivalTime, "2026-08-12T09:32:00");
assert.deepEqual(jpArrivals[0].reservedCarriages, ["C", "D", "E", "F"]);
const platformMatchTrip = {
	trip_id: "01-BGO--10-T0-8240",
	serviceDate: "20260812",
	stopTimes: [
		{
			passing: false,
			scheduled_arrival_time: 12 * 3600,
			scheduled_departure_time: 12 * 3600,
			scheduled_parent_station: { stop_name: "Bendigo Railway Station" },
		},
		{
			passing: false,
			scheduled_arrival_time: 13 * 3600 + 13 * 60,
			scheduled_departure_time: 13 * 3600 + 15 * 60,
			scheduled_parent_station: { stop_name: "Geelong Railway Station" },
		},
		{
			passing: false,
			scheduled_arrival_time: 14 * 3600 + 32 * 60,
			scheduled_departure_time: null,
			scheduled_parent_station: { stop_name: "Southern Cross Railway Station" },
		},
	],
};
const platformRunMatch = {
	...jpArrivals[0],
	tdn: "8240",
	scheduledDepartureTime: "2026-08-12T14:32:00",
};
assert.equal(serviceMatchesPlatformTrip(platformRunMatch, platformMatchTrip, "southerncross"), true);
assert.equal(
	serviceMatchesPlatformTrip(
		{ ...platformRunMatch, platformEvent: "departure", scheduledDepartureTime: "2026-08-12T13:15:00" },
		platformMatchTrip,
		"geelong",
	),
	true,
);
assert.equal(serviceMatchesPlatformTrip({ ...platformRunMatch, tdn: "8241" }, platformMatchTrip, "southerncross"), false);
assert.equal(
	serviceMatchesPlatformTrip({ ...platformRunMatch, scheduledDepartureTime: "2026-08-13T14:32:00" }, platformMatchTrip, "southerncross"),
	false,
);
const arrivalStop = {
	scheduled_arrival_time: 9 * 3600 + 25 * 60,
	actual_arrival_time: 9 * 3600 + 25 * 60,
	scheduled_parent_station_id: "vic:rail:SSS",
	scheduled_stop_id: "20043",
	scheduled_parent_station: { stop_name: "Southern Cross Railway Station" },
	scheduled_stop: { stop_name: "Southern Cross Station" },
	rt_arrival_updated: false,
	realtime: false,
	realtime_info: null,
};
const arrivalTrip = { serviceDate: "20260812", rt_start_date: null, stopTimes: [arrivalStop] };
const arrivalDetails = createEmptyVLineDetails("8301");
applyJourneyPlannerService(arrivalTrip, arrivalDetails, jpArrivals[0], "2026-08-11T23:30:00Z");
assert.equal(arrivalDetails.platforms[0].stopId, "vic:rail:SSS");
assert.equal(arrivalDetails.platforms[0].event, "arrival");
assert.equal(arrivalStop.actual_arrival_time, 9 * 3600 + 31 * 60);
assert.equal(arrivalStop.realtime_info.delay_secs, 6 * 60);
const authoritativeArrival = { ...arrivalStop, actual_arrival_time: 9 * 3600 + 30 * 60, rt_arrival_updated: true };
applyJourneyPlannerService(
	{ ...arrivalTrip, stopTimes: [authoritativeArrival] },
	createEmptyVLineDetails("8301"),
	jpArrivals[0],
	"2026-08-11T23:30:00Z",
);
assert.equal(authoritativeArrival.actual_arrival_time, 9 * 3600 + 30 * 60);
const fallbackDetails = createEmptyVLineDetails("8761");
const existingObservation = (value) => ({
	value,
	source: "vline-journey-planner",
	confidence: "reported",
	observedAt: "2026-08-12T00:00:00Z",
});
const platformFallbackDetails = createEmptyVLineDetails("8761");
applyJourneyPlannerService(arrivalTrip, platformFallbackDetails, jpServices[0], "2026-08-12T00:00:30Z");
assert.equal(platformFallbackDetails.subtype.source, "vline-platform-services");
fallbackDetails.subtype = existingObservation("Sprinter");
fallbackDetails.unitCount = existingObservation(4);
fallbackDetails.passengerCars = existingObservation(4);
applyJourneyPlannerService(arrivalTrip, fallbackDetails, jpServices[0], "2026-08-12T00:01:00Z");
assert.equal(fallbackDetails.subtype.value, "Sprinter");
assert.equal(fallbackDetails.unitCount.value, 4);
assert.equal(fallbackDetails.passengerCars.value, 4);
applyJourneyPlannerService(
	arrivalTrip,
	fallbackDetails,
	{
		...jpServices[0],
		platformEvent: null,
		platform: null,
		consistSubtype: "VLocity",
		consistCount: 2,
	},
	"2026-08-12T00:02:00Z",
);
assert.equal(fallbackDetails.subtype.value, "VLocity");
assert.equal(fallbackDetails.unitCount.value, 2);
assert.equal(fallbackDetails.passengerCars.value, 6);
const locations = parseVLineLocations(`<GetAllLocationsResult xmlns:a="urn:vline">
<a:Location><a:LocationName>Geelong Station: Railway Terrace</a:LocationName><a:VNetStopCode>GEX</a:VNetStopCode><a:StopType>Station</a:StopType><a:Line>Geelong</a:Line></a:Location>
<a:Location><a:LocationName>Geelong: Deakin University</a:LocationName><a:VNetStopCode>GLB</a:VNetStopCode><a:StopType>Coach</a:StopType><a:Line>Geelong</a:Line></a:Location>
</GetAllLocationsResult>`);
assert.deepEqual(locations[0], {
	name: "Geelong Station: Railway Terrace",
	stopCode: "GEX",
	stopType: "Station",
	line: "Geelong",
});
const demandNow = Date.parse("2026-08-12T00:00:00Z");
const demandTrip = {
	instance_id: "geelong-demand",
	serviceDate: "20260812",
	schedule_relationship: 0,
	stopTimes: [
		{
			passing: false,
			pickup_type: 0,
			drop_off_type: 0,
			scheduled_arrival_time: 10 * 3600 + 20 * 60,
			scheduled_departure_time: 10 * 3600 + 22 * 60,
			scheduled_parent_station: { stop_name: "Geelong Railway Station" },
			scheduled_stop: null,
		},
	],
};
const platformDemands = vlinePlatformStationDemands([demandTrip], locations, demandNow, 240);
assert.deepEqual(platformDemands, [
	{
		location: "Geelong Station: Railway Terrace",
		stationKey: "geelong",
		tripInstanceIds: ["geelong-demand"],
		arrivals: true,
		departures: true,
		nextCallAt: Date.parse("2026-08-12T00:20:00Z"),
	},
]);
assert.equal(
	vlinePlatformStationsDue(
		platformDemands,
		new Map([["geelong", { lastAttemptAt: demandNow - 19 * 60_000 }]]),
		demandNow,
	).length,
	0,
);
assert.equal(
	vlinePlatformStationsDue(
		platformDemands,
		new Map([["geelong", { lastAttemptAt: demandNow - 20 * 60_000 }]]),
		demandNow,
	).length,
	1,
);
assert.equal(
	vlinePlatformStationsDue(
		Array.from({ length: 8 }, (_, index) => ({
			...platformDemands[0],
			stationKey: `station-${index}`,
			location: `Station ${index}`,
		})),
		new Map(),
		demandNow,
	).length,
	7,
);
const platformRequests = [];
const platformServer = http.createServer((request, response) => {
	platformRequests.push(new URL(request.url, "http://localhost"));
	response.setHeader("content-type", "application/xml");
	if (request.url.startsWith("/VLineLocations"))
		response.end(`<GetAllLocationsResult xmlns:a="urn:vline"><a:Location>
		<a:LocationName>Geelong Station: Railway Terrace</a:LocationName><a:StopType>Station</a:StopType>
	</a:Location></GetAllLocationsResult>`);
	else
		response.end(`<GetPlatformDeparturesResult xmlns:a="urn:vline"><a:PlatformService>
		<a:Origin>Melbourne, Southern Cross</a:Origin><a:Destination>Geelong Station</a:Destination>
		<a:ScheduledDepartureTime>2026-08-12T10:00:00</a:ScheduledDepartureTime><a:ServiceIdentifier>8752</a:ServiceIdentifier>
	</a:PlatformService></GetPlatformDeparturesResult>`);
});
await new Promise((resolve) => platformServer.listen(0, "127.0.0.1", resolve));
const platformAddress = platformServer.address();
const platformOptions = {
	callerId: "test-caller",
	applicationSignature: "test-signature",
	baseUrl: `http://127.0.0.1:${platformAddress.port}`,
};
assert.equal((await getVLineLocations(platformOptions))[0].name, "Geelong Station: Railway Terrace");
assert.equal(
	(await getVLinePlatformDepartures(platformOptions, "Geelong Station: Railway Terrace"))[0].locationName,
	"Geelong Station: Railway Terrace",
);
await new Promise((resolve) => platformServer.close(resolve));
assert.equal(platformRequests[1].searchParams.get("Direction"), "B");
assert.equal(platformRequests[1].searchParams.get("minutes"), "240");
const journeyServices =
	parseVLineJourneys(`<GetNextPrevious5JourneysResult xmlns:a="urn:vline"><a:Journey><a:Legs><a:Leg>
<a:Origin>Wallan Station</a:Origin><a:Destination>Melbourne, Southern Cross</a:Destination>
<a:DepartureTime>2026-08-15T10:10:00</a:DepartureTime><a:ArrivalTime>2026-08-15T10:57:00</a:ArrivalTime>
<a:ServiceIdentifier>8314</a:ServiceIdentifier><a:ServiceDirection>Up</a:ServiceDirection>
<a:ConsistSubType>Sprinter</a:ConsistSubType><a:ConsistCount>4</a:ConsistCount>
<a:DesignatedAccessibilitySpaceCount>8</a:DesignatedAccessibilitySpaceCount><a:DesignatedBikeSpaceCount>0</a:DesignatedBikeSpaceCount>
<a:IsAccessibleAvailable>true</a:IsAccessibleAvailable><a:IsBikeAvailable>false</a:IsBikeAvailable>
<a:IsLiveConsistInfo>true</a:IsLiveConsistInfo><a:ReservationAvailable>false</a:ReservationAvailable>
<a:ReservationRequired>false</a:ReservationRequired><a:CanBookInJourneyPlanner>true</a:CanBookInJourneyPlanner>
<a:EconomyClassSeatsAvailable>0</a:EconomyClassSeatsAvailable><a:UnreservedSeatsAvailable>0</a:UnreservedSeatsAvailable>
</a:Leg></a:Legs></a:Journey></GetNextPrevious5JourneysResult>`);
assert.equal(journeyServices[0].tdn, "8314");
assert.equal(journeyServices[0].consistSubtype, "Sprinter");
assert.equal(journeyServices[0].consistCount, 4);
assert.equal(journeyServices[0].accessibleSpaces, 8);
assert.equal(journeyServices[0].bicycleSpaces, 0);
assert.equal(journeyServices[0].isLiveConsistInfo, true);
assert.equal(journeyServices[0].platformEvent, null);

const booking = parseVLineBookingPage(
	`<div class="journey-leg" data-departure-time="2026-08-15 12:36:00">
<div class="view-consist-panel"><input id="x_hdnServiceCode" value="8351"><input id="x_hdnCarList" value="C,D">
<tr id="x_spnReservedSeatsTrain" class="economy-seats"><span class="description">65 seats available</span><a id="x_lnbTrainSeats" class="viewseats">View seats</a></tr>
<tr id="x_spnUnreservedSeats" class="unreserved-seats"><span class="description">50 tickets available</span></tr></div></div>`,
	{
		tdn: "8351",
		scheduledDepartureTime: "2026-08-15T12:36:00",
		journeyUrl: "https://www.vline.com.au/example",
		observedAt: "2026-08-15T00:20:00Z",
	},
);
assert.deepEqual(booking, {
	tdn: "8351",
	reservedCarriages: ["C", "D"],
	reservedSeatsAvailable: 65,
	unreservedTicketsAvailable: 50,
	reservationAvailable: true,
	reservationRequired: false,
	seatMapAvailable: true,
	journeyUrl: "https://www.vline.com.au/example",
	observedAt: "2026-08-15T00:20:00Z",
});
const scsRows =
	parseVLineScsBoard(`<table><tr class="rowModule"><td class="first-service"><table class="main-module"><tr>
<td><span class="mdepartuertime">14:50</span><span class="mtowardsdes">towards Waurn Ponds</span></td>
<td><div class="mPlatform"><div class="platformbay">Platform</div>4A</div></td></tr></table></td></tr></table>`);
assert.deepEqual(scsRows, [
	{
		time: "14:50",
		destination: "Waurn Ponds",
		boardGroup: null,
		coachesFrom: null,
		platform: "4A",
		boardingKind: "platform",
		departingIn: null,
		departingInSeconds: null,
		cancelled: false,
	},
]);
const scsTrip = {
	instance_id: "example",
	trip_headsign: "Waurn Ponds",
	serviceDate: "20260812",
	stopTimes: [
		{
			scheduled_departure_time: 14 * 3600 + 50 * 60,
			scheduled_arrival_time: 14 * 3600 + 50 * 60,
			scheduled_parent_station_id: "vic:rail:SSS",
			scheduled_stop_id: "20043",
			scheduled_parent_station: { stop_name: "Southern Cross Railway Station" },
			scheduled_stop: { stop_name: "Southern Cross Station" },
		},
	],
};
assert.equal(matchScsRows([scsTrip], scsRows, "2026-08-12T04:40:00Z").get("example").value, "4A");
assert.equal(
	matchScsRows([scsTrip, { ...scsTrip, instance_id: "duplicate" }], scsRows, "2026-08-12T04:40:00Z").size,
	0,
);
const coachHandoffRows =
	parseVLineScsBoard(`<table><tr class="rowModule"><td class="first-service"><table class="main-module"><tr>
<td><div class="mdeparture-destination">Ballarat</div><span class="mdepartuertime">09:55</span><span class="mtowardsdes">towards Ararat</span></td>
<td><div class="mPlatform"><div class="platformbay">Platform</div>3A</div></td></tr><tr>
<td class="mcocancalation"><div class="normal-tdeparture-destination">COACHES FROM CAROLINE SPRINGS</div></td>
<td><div class="mDepMin">11 min</div></td></tr></table></td></tr></table>`);
assert.equal(coachHandoffRows[0].coachesFrom, "CAROLINE SPRINGS");
const coachHandoffTrip = {
	...scsTrip,
	instance_id: "coach-handoff",
	trip_headsign: "Wendouree",
	serviceDate: "20260815",
	stopTimes: [
		{
			...scsTrip.stopTimes[0],
			scheduled_departure_time: 9 * 3600 + 55 * 60,
			scheduled_arrival_time: 9 * 3600 + 55 * 60,
		},
		{
			passing: false,
			scheduled_arrival_time: 10 * 3600 + 19 * 60,
			scheduled_parent_station_id: "vic:rail:CSP",
			scheduled_stop_id: "CSP",
			scheduled_parent_station: { stop_name: "Caroline Springs Railway Station" },
			scheduled_stop: { stop_name: "Caroline Springs Station" },
		},
	],
};
assert.equal(
	matchScsRows([coachHandoffTrip], coachHandoffRows, "2026-08-14T23:44:00Z").get("coach-handoff").value,
	"3A",
);
const wrongTerminalTrip = {
	...coachHandoffTrip,
	instance_id: "wrong-terminal",
	stopTimes: [
		coachHandoffTrip.stopTimes[0],
		{ ...coachHandoffTrip.stopTimes[1], scheduled_parent_station: { stop_name: "Deer Park Railway Station" } },
	],
};
assert.equal(matchScsRows([wrongTerminalTrip], coachHandoffRows, "2026-08-14T23:44:00Z").size, 0);
assert.deepEqual(
	parseVLineScsBoard(`<table><tr class="rowModule"><td class="first-service"><table class="main-module"><tr>
<td><div class="mdeparture-destination">Bendigo</div><span class="mdepartuertime">20:31</span><span class="mtowardsdes">towards Eaglehawk</span></td>
<td><div class="mPlatform"><div class="platformbay">Coach bay</div>67</div></td></tr><tr><td class="mcocancalation">The service has been replaced by coaches</td><td><div class="mDepMin">24 min</div></td></tr></table></td></tr></table>`),
	[],
);
assert.equal(
	chronosHourlyToken("test-key", new Date("2026-08-12T04:59:59Z")),
	"c92ffbde8535fc89f8902899658b9b4d4734ca81",
);
const chronosFixture = JSON.parse(
	await readFile(new URL("./fixtures/chronos-same-time.json", import.meta.url), "utf8"),
);
const chronosContext = {
	chronosStopId: 1181,
	scheduledFirstDepartureUtc: "2026-08-12T04:50:00Z",
	routeGtfsId: "1-GEL",
	destination: "Waurn Ponds Station",
	directionId: 10,
};
assert.equal(matchChronosRun(scsTrip, chronosFixture, chronosContext), "24497");
const coachFixture = structuredClone(chronosFixture);
coachFixture.routes[1745].route_gtfs_id = "5-GEL";
assert.equal(matchChronosRun(scsTrip, coachFixture, chronosContext), null);
const ambiguousFixture = structuredClone(chronosFixture);
ambiguousFixture.departures.push({ ...ambiguousFixture.departures[1], run_id: 24498, run_ref: "24498" });
ambiguousFixture.runs[24498] = { ...ambiguousFixture.runs[24497], run_id: 24498, run_ref: "24498" };
assert.equal(matchChronosRun(scsTrip, ambiguousFixture, chronosContext), null);

const estimateTrip = { serviceDate: "20260812", rt_start_date: null };
const estimateCall = {
	actual_departure_time: 53_400,
	scheduled_departure_time: 53_400,
	scheduled_arrival_time: 53_400,
	rt_departure_updated: false,
	realtime: false,
	realtime_info: null,
};
applyChronosEstimate(estimateTrip, estimateCall, "2026-08-12T04:55:00Z");
assert.equal(estimateCall.actual_departure_time, 53_700);
assert.equal(estimateCall.realtime, true);
assert.equal(estimateCall.realtime_info.delay_secs, 300);
const realtimeCall = { actual_departure_time: 53_820, scheduled_departure_time: 53_400, rt_departure_updated: true };
applyChronosEstimate(estimateTrip, realtimeCall, "2026-08-12T04:55:00Z");
assert.equal(realtimeCall.actual_departure_time, 53_820);

let patternRequestUrl = null;
let patternRequestTokenHeader = null;
const patternServer = http.createServer((request, response) => {
	patternRequestUrl = new URL(request.url, "http://localhost");
	patternRequestTokenHeader = request.headers.token ?? null;
	response.setHeader("content-type", "application/json");
	response.end(
		JSON.stringify({
			departures: [{ platform_number: null }, { platform_number: "" }],
			stops: {},
			routes: {},
			runs: {},
			directions: {},
		}),
	);
});
await new Promise((resolve) => patternServer.listen(0, "127.0.0.1", resolve));
const patternAddress = patternServer.address();
const parsedPattern = await getChronosRunPattern(`http://127.0.0.1:${patternAddress.port}/v3/`, "test-key", "24497", {
	dateUtc: "2026-08-12T04:50:00Z",
	stopId: 1181,
	expand: ["all"],
});
await new Promise((resolve) => patternServer.close(resolve));
assert.deepEqual(
	parsedPattern.departures.map((departure) => departure.platform_number),
	[null, ""],
);
assert.equal(patternRequestUrl.pathname, "/v3/pattern/run/24497/route_type/3");
assert.equal(patternRequestUrl.searchParams.get("date_utc"), "2026-08-12T04:50:00Z");
assert.equal(patternRequestUrl.searchParams.get("stop_id"), "1181");
assert.equal(patternRequestUrl.searchParams.get("expand"), "all");
assert.equal(patternRequestUrl.searchParams.get("include_skipped_stops"), "true");
assert.equal(patternRequestUrl.searchParams.get("include_geopath"), "true");
assert.equal(patternRequestUrl.searchParams.get("include_advertised_interchange"), "true");
assert.match(patternRequestUrl.searchParams.get("token"), /^[0-9a-f]{40}$/);
assert.equal(patternRequestTokenHeader, null);

const cisNow = Date.parse("2026-08-11T22:30:00Z");
const cisCandidates = collectCisStationCandidates(
	{
		48: {
			departed: false,
			arrived: false,
			from: "TORONTO",
			to: "OTTAWA",
			instance: "2026-08-11",
			times: [
				{
					station: "Toronto",
					code: "TRTO",
					estimated: "2026-08-11T18:38:00-04:00",
					scheduled: "2026-08-11T18:38:00-04:00",
					eta: "8 mins",
					departure: {
						estimated: "2026-08-11T18:38:00-04:00",
						scheduled: "2026-08-11T18:38:00-04:00",
					},
				},
			],
		},
	},
	cisNow,
);
assert.deepEqual([...cisCandidates], [["TRTO", "Toronto"]]);

const cisBoard = parseCisStationBoard({
	DisplayTimeZone: "America/Toronto",
	ActiveBoardingLocations: ["Gate"],
	Arrivals: [],
	Departures: [
		{
			Train: "48",
			ScheduleDate: "2026-08-11",
			Scheduled: "18:38",
			Revised: "ON TIME / À L'HEURE",
			Destinations: ["OTTAWA"],
			Originations: ["TORONTO"],
			Track: "",
			Platform: "",
			Gate: "16",
			Door: "",
			Letter: "",
		},
	],
	LanguagePriorityCode: "en",
});
const cisAssignments = buildCisBoardingAssignments(
	new Map([["TRTO", { stationCode: "TRTO", stationName: "Toronto", fetchedAt: cisNow, board: cisBoard }]]),
	new Map([[viaTrainKey("48", "2026-08-11"), { tripId: "trip-48", serviceDate: "20260811" }]]),
);
assert.deepEqual(cisAssignments, [
	{
		stationCode: "TRTO",
		tripId: "trip-48",
		serviceDate: "20260811",
		event: "departure",
		locations: [
			{
				kind: "gate",
				value: "16",
				source: "via-cis",
				observed_at: "2026-08-11T22:30:00.000Z",
			},
		],
	},
]);

const crcTable = Array.from({ length: 256 }, (_, value) => {
	let crc = value;
	for (let bit = 0; bit < 8; bit++) crc = (crc & 1) !== 0 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
	return crc >>> 0;
});
function crc32(buffer) {
	let crc = 0xffffffff;
	for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}
function createZip(files) {
	const localParts = [],
		centralParts = [];
	let localOffset = 0;
	for (const [filename, contents] of Object.entries(files)) {
		const name = Buffer.from(filename),
			body = Buffer.from(contents),
			checksum = crc32(body);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt32LE(checksum, 14);
		local.writeUInt32LE(body.length, 18);
		local.writeUInt32LE(body.length, 22);
		local.writeUInt16LE(name.length, 26);
		localParts.push(local, name, body);
		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt32LE(checksum, 16);
		central.writeUInt32LE(body.length, 20);
		central.writeUInt32LE(body.length, 24);
		central.writeUInt16LE(name.length, 28);
		central.writeUInt32LE(localOffset, 42);
		centralParts.push(central, name);
		localOffset += local.length + name.length + body.length;
	}
	const directory = Buffer.concat(centralParts),
		end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(Object.keys(files).length, 8);
	end.writeUInt16LE(Object.keys(files).length, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(localOffset, 16);
	return Buffer.concat([...localParts, directory, end]);
}

function feed(name, timezone, includeIntermediate = false) {
	const middleStop = includeIntermediate ? `middle,${name} Middle,-27.45,153.05\n` : "";
	const middleStopTime = includeIntermediate ? "shared,25:45:00,25:45:00,middle,2,0,0\n" : "";
	const endSequence = includeIntermediate ? 3 : 2;
	return createZip({
		"agency.txt": `agency_id,agency_name,agency_url,agency_timezone\nagency,${name},https://example.test,${timezone}\n`,
		"routes.txt": "route_id,agency_id,route_short_name,route_long_name,route_type\nshared,agency,R,Shared Rail,2\n",
		"stops.txt": `stop_id,stop_name,stop_lat,stop_lon\nshared,${name} Station,-27.4,153.0\n${middleStop}end,${name} End,-27.5,153.1\n`,
		"trips.txt":
			"route_id,service_id,trip_id,trip_headsign,direction_id,shape_id\nshared,shared,shared,End,0,shared\n",
		"stop_times.txt": `trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type\nshared,25:30:00,25:30:00,shared,1,0,1\n${middleStopTime}shared,26:00:00,26:00:00,end,${endSequence},1,0\n`,
		"calendar.txt":
			"service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nshared,1,1,1,1,1,1,1,20260101,20261231\n",
		"shapes.txt":
			"shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\nshared,-27.4,153.0,1\nshared,-27.5,153.1,2\n",
	});
}

const feeds = { "/a.zip": feed("Alpha", "Australia/Brisbane"), "/b.zip": feed("Beta", "America/Toronto", true) };
const server = http.createServer((request, response) => {
	const body = feeds[request.url];
	if (!body) {
		response.writeHead(404).end();
		return;
	}
	response.writeHead(200, { "content-type": "application/zip" });
	response.end(body);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

try {
	const definition = {
		id: "synthetic",
		name: "Synthetic multi-feed",
		modes: ["rail"],
		plugins: [
			{
				id: "alpha-only",
				feedIds: ["alpha"],
				capabilities: ["facilities"],
				enrichStop(stop) {
					stop.testPluginApplied = true;
				},
			},
		],
		feeds: [
			{ id: "alpha", staticSource: { url: `${origin}/a.zip` }, realtimeSources: [] },
			{ id: "beta", staticSource: { url: `${origin}/b.zip` }, realtimeSources: [] },
		],
		places: [
			{
				id: "shared-place",
				name: "Shared Place",
				members: [
					{ feedId: "alpha", localId: "shared" },
					{ feedId: "beta", localId: "shared" },
				],
			},
			{
				id: "end-place",
				name: "End Place",
				members: [
					{ feedId: "alpha", localId: "end" },
					{ feedId: "beta", localId: "end" },
				],
			},
		],
	};
	assert.throws(
		() =>
			new TRAX({
				...definition,
				id: "duplicate-place-member",
				places: [
					...definition.places,
					{ id: "duplicate", name: "Duplicate", members: [{ feedId: "alpha", localId: "shared" }] },
				],
			}),
		/belongs to both places/,
	);
	const runtime = new TRAX(definition, { cacheDir: ".TRAXCACHE/test-synthetic" });
	await runtime.loadGTFS(false, false);
	const failingSupplemental = new TRAX(
		{
			...definition,
			id: "synthetic-supplemental-failure",
			feeds: [definition.feeds[0]],
			places: [],
			plugins: [
				{
					id: "failing-chronos",
					feedIds: ["alpha"],
					capabilities: ["supplemental-realtime"],
					beforeRealtime() {
						throw new Error("synthetic Chronos timeout");
					},
				},
				{
					id: "after-realtime-enrichment",
					feedIds: ["alpha"],
					capabilities: ["supplemental-realtime"],
					afterRealtime() {},
				},
			],
		},
		{ cacheDir: ".TRAXCACHE/test-supplemental-failure" },
	);
	await failingSupplemental.loadGTFS(false, false);
	await failingSupplemental.refreshRealtime();
	assert.equal(failingSupplemental.getAugmentedTrips({ feedId: "alpha", localId: "shared" }).length, 1);
	assert.equal(
		failingSupplemental.getSourceHealth().find((source) => source.id === "failing-chronos:supplemental").state,
		"error",
	);
	assert.equal(
		failingSupplemental.getSourceHealth().find((source) => source.id === "after-realtime-enrichment:supplemental")
			.state,
		"healthy",
	);
	assert.equal(runtime.getRawTrips({ trip_id: "shared" }).length, 2);
	assert.equal(runtime.getAugmentedStops({ feedId: "alpha", localId: "shared" })[0].stop_name, "Alpha Station");
	assert.equal(runtime.getAugmentedStops({ feedId: "beta", localId: "shared" })[0].stop_name, "Beta Station");
	assert.equal(runtime.getAugmentedStops({ feedId: "alpha", localId: "shared" })[0].testPluginApplied, true);
	assert.equal(runtime.getAugmentedStops({ feedId: "beta", localId: "shared" })[0].testPluginApplied, undefined);
	assert.deepEqual(runtime.metadata.feeds.find((value) => value.id === "alpha").capabilities, ["facilities"]);
	assert.deepEqual(runtime.metadata.feeds.find((value) => value.id === "beta").capabilities, []);
	assert.deepEqual(runtime.getPlaces()[0].members, [
		{ feedId: "alpha", localId: "shared" },
		{ feedId: "beta", localId: "shared" },
	]);
	assert.equal(runtime.getPlaceForStation({ feedId: "beta", localId: "shared" }).id, "shared-place");
	assert.ok(
		runtime
			.getSourceHealth()
			.every((source) => source.kind !== "static" || ["healthy", "stale"].includes(source.state)),
	);
	const alphaTrip = runtime.getAugmentedTrips({ feedId: "alpha", localId: "shared" })[0];
	const betaTrip = runtime.getAugmentedTrips({ feedId: "beta", localId: "shared" })[0];
	assert.ok(alphaTrip && betaTrip);
	assert.notEqual(alphaTrip.instances[0].instance_id, betaTrip.instances[0].instance_id);
	assert.equal(decodeTripInstanceId(alphaTrip.instances[0].instance_id).feedId, "alpha");
	assert.equal(alphaTrip.instances[0].stopTimes[0].scheduled_departure_time, 91_800);
	assert.equal(alphaTrip.instances[0].stopTimes[0].pickup_type, 0);
	assert.equal(alphaTrip.instances[0].stopTimes[0].drop_off_type, 1);
	assert.equal(alphaTrip.instances[0].stopTimes.at(-1).pickup_type, 1);
	assert.equal(alphaTrip.instances[0].stopTimes.at(-1).drop_off_type, 0);
	const crossFeedPassingStop = alphaTrip.instances[0].stopTimes.find((stop) => stop.passing);
	assert.equal(crossFeedPassingStop?.feed_id, "beta");
	assert.equal(crossFeedPassingStop?.scheduled_stop_id, "middle");
	assert.equal(runtime.metadata.feeds.find((value) => value.id === "beta").timeZone, "America/Toronto");

	const eagerInstanceCount = alphaTrip.instances.length;
	assert.ok(runtime.getAvailableServiceDates().includes("20261215"));
	assert.equal(alphaTrip.instances.length, eagerInstanceCount, "listing calendar dates must not build instances");
	assert.equal(runtime.getTripIdsByServiceDate("20261215").length, 2);
	const lazyAlpha = alphaTrip.instances.find((instance) => instance.serviceDate === "20261215");
	assert.ok(lazyAlpha, "a far service date should materialize on demand");
	const lazyAlphaId = lazyAlpha.instance_id;
	for (let day = 16; day <= 25; day++) runtime.getTripIdsByServiceDate(`202612${day}`);
	assert.equal(
		alphaTrip.instances.some((instance) => instance.serviceDate === "20261215"),
		false,
	);
	assert.equal(runtime.getAugmentedTripInstance(lazyAlphaId)?.instance_id, lazyAlphaId);
	const replacement = { ...lazyAlpha, instance_id: "replacement" };
	assert.equal(findUniqueTripInstanceForServiceDate([replacement], lazyAlpha.serviceDate), replacement);
	assert.equal(findUniqueTripInstanceForServiceDate([replacement], "20261216"), null);
	assert.equal(
		findUniqueTripInstanceForServiceDate(
			[replacement, { ...replacement, instance_id: "ambiguous" }],
			lazyAlpha.serviceDate,
		),
		null,
	);

	const publicId = encodePublicEntityId({
		networkId: "synthetic",
		feedId: "alpha",
		kind: "station",
		localId: "shared",
	});
	assert.deepEqual(decodePublicEntityId(publicId), {
		networkId: "synthetic",
		feedId: "alpha",
		kind: "station",
		localId: "shared",
	});

	const registry = new NetworkRuntimeRegistry();
	const other = registry.register(
		{ ...definition, id: "other", feeds: [definition.feeds[0]], places: [] },
		{ cacheDir: ".TRAXCACHE/test-other" },
	);
	await other.loadGTFS(false, false);
	assert.equal(other.getRawTrips().length, 1);
	assert.equal(runtime.getRawTrips().length, 2);
	assert.notEqual(
		other.getAugmentedTrips({ feedId: "alpha", localId: "shared" })[0].instances[0].instance_id,
		alphaTrip.instances[0].instance_id,
	);

	const winter = runtime.utils.time.parseTimeWithConfig("2026-01-15T12:00:00", "America/Toronto");
	const summer = runtime.utils.time.parseTimeWithConfig("2026-07-15T12:00:00", "America/Toronto");
	assert.equal(new Date(winter).toISOString(), "2026-01-15T17:00:00.000Z");
	assert.equal(new Date(summer).toISOString(), "2026-07-15T16:00:00.000Z");
	const serviceOriginCases = [
		["20260308", "America/Toronto", "2026-03-08T04:00:00.000Z"],
		["20261101", "America/Toronto", "2026-11-01T05:00:00.000Z"],
		["20260329", "Europe/London", "2026-03-28T23:00:00.000Z"],
		["20261025", "Europe/London", "2026-10-25T00:00:00.000Z"],
		["20260405", "Australia/Sydney", "2026-04-04T14:00:00.000Z"],
		["20261004", "Australia/Sydney", "2026-10-03T13:00:00.000Z"],
		["20260115", "Australia/Brisbane", "2026-01-14T14:00:00.000Z"],
		["20260715", "Australia/Brisbane", "2026-07-14T14:00:00.000Z"],
	];
	for (const [date, zone, expected] of serviceOriginCases) {
		assert.equal(new Date(runtime.utils.time.getServiceDayStart(date, zone) * 1000).toISOString(), expected);
	}
	assert.equal(
		runtime.utils.time.serviceTimeToInstant("20260805", 91_800, "Australia/Brisbane"),
		"2026-08-05T15:30:00.000Z",
	);
	runtime.clearIntervals();
	other.clearIntervals();
	failingSupplemental.clearIntervals();
	console.log("Architecture tests passed.");
} finally {
	server.close();
}
