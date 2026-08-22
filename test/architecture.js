import assert from "node:assert/strict";
import http from "node:http";
import TRAX, {
	NetworkRuntimeRegistry,
	createCaGthaNetwork,
	decodeTripInstanceId,
	encodePublicEntityId,
	decodePublicEntityId,
	createAuVicVlineNetwork,
	createAuRailNetwork,
	normalizeVLineUnit,
	ptvVehicleDescriptorConsist,
	parseVLinePlatformServices,
	parseVLineJourneys,
	parseVLineLocations,
	parseVLineBookingPage,
	parseVLinePlatformArrivals,
	parseVLineScsBoard,
	parseTfnswTripId,
	parseAnyTripNswOccupancy,
	applyAnyTripNswOccupancy,
	AnyTripNswOccupancyClient,
	resolveTripNumber,
	vlineAccessToken,
	vlinePassengerCars,
	vlineTdn,
	vlineVehicleModel,
} from "../dist/index.js";
import {
	applyJourneyPlannerService,
	createEmptyVLineDetails,
	journeyLocationName,
	matchAnyTripPlatformCall,
	matchScsRows,
	serviceMatchesPlatformTrip,
	vlinePlatformStationDemands,
	vlinePlatformStationsDue,
	vlineFormationUnits,
	vlineServiceBookingAvailability,
	_test as vlineEnrichmentTest,
} from "../dist/region-specific/AU/VIC/enrichment.js";
import { AnyTripPlatformClient, _test as anyTripTest } from "../dist/region-specific/AU/VIC/anytrip.js";
import { getVLineLocations, getVLinePlatformDepartures } from "../dist/region-specific/AU/VIC/journey-planner.js";
import { ptvMetroFormationUnit } from "../dist/region-specific/AU/VIC/ptv-metro.js";
import {
	viaCarriageCodeDiagramKind,
	viaCarriageDiagramKind,
	viaCarriageEquipmentLabel,
	viaCarriageTypeLabel,
} from "../dist/plugins/via.js";
import {
	buildVLineRealtimeTripAliases,
	canonicalVLineRealtimeTripId,
} from "../dist/region-specific/AU/VIC/realtime-aliases.js";
import {
	applyRealtimeReplacementPrecedence,
	canonicalizeRealtimeTripUpdate,
	canonicalizeRealtimeVehiclePosition,
	replaceInjectedTripUpdates,
} from "../dist/cache/realtime.js";
import {
	isConsideredRoute,
	isNonBoardingStopTime,
	isNonRevenueTrip,
	isPassingStopTime,
} from "../dist/utils/considered.js";
import { matchRealtimeStopTimeUpdate } from "../dist/utils/augmentedStopTime.js";
import { inferTfnswRealtimeServiceDate, tfnswPlatformCode } from "../dist/plugins/tfnsw-rail.js";
import { _test as tfnswRegionalBookingTest } from "../dist/region-specific/AU/NSW/regional-booking.js";
import { findUniqueTripInstanceForServiceDate } from "../dist/cache/augmentedEntities.js";
import { DropOffType, PickupType, RouteType, TripScheduleRelationship } from "qdf-gtfs";
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
	platformSourceServiceWindows,
	stopTimeMatchesStopId,
} from "../dist/region-specific/CA/GTHA/realtime.js";
import {
	buildGthaOperatingScheduleUpdates,
	GTHA_OPERATING_SCHEDULE_SOURCE_ID,
	isGthaOperatingScheduleForServiceDate,
} from "../dist/region-specific/CA/GTHA/operating-schedule.js";
import { SOURCE_C_LOOKAHEAD_SECS } from "../dist/region-specific/CA/GTHA/gtha-realtime-constants.js";

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
assert.equal(applyGthaVehicleBearing({ feed_id: "go", position: { bearing: 42 } }, null).position.bearing, 42);
assert.equal(applyGthaVehicleBearing({ feed_id: "up", position: { bearing: 0 } }, null).position.bearing, null);
assert.equal(applyGthaVehicleBearing({ feed_id: "up", position: { bearing: 0 } }, 0).position.bearing, 0);
assert.equal(applyGthaVehicleBearing({ feed_id: "via", position: { bearing: 0 } }, null).position.bearing, 0);
// Platform sources must match ordinary scheduled calls, such as UP Express at Union.
assert.equal(stopTimeMatchesStopId({ actual_stop_id: null, scheduled_stop_id: "UN" }, "UN"), true);
assert.equal(stopTimeMatchesStopId({ actual_stop_id: "UN", scheduled_stop_id: "OLD" }, "UN"), true);
assert.equal(stopTimeMatchesStopId({ actual_stop_id: "NEW", scheduled_stop_id: "UN" }, "UN"), false);
assert.equal(stopTimeMatchesStopId({ actual_stop_id: null, scheduled_stop_id: "PA" }, "UN"), false);
assert.equal(SOURCE_C_LOOKAHEAD_SECS, 8 * 60 * 60);
assert.deepEqual(platformSourceServiceWindows("20260819", 45 * 60, SOURCE_C_LOOKAHEAD_SECS), [
	{ serviceDate: "20260819", startTime: 45 * 60, endTime: 8 * 60 * 60 + 45 * 60 },
	{ serviceDate: "20260818", startTime: 24 * 60 * 60 + 45 * 60, endTime: 32 * 60 * 60 + 45 * 60 },
]);
assert.equal(
	isGthaOperatingScheduleForServiceDate({ date: "2026-08-18T18:42:54-04:00", commitmentTrip: [] }, "20260818"),
	true,
);
assert.equal(
	isGthaOperatingScheduleForServiceDate({ date: "2026-08-17T18:42:54-04:00", commitmentTrip: [] }, "20260818"),
	false,
);
assert.equal(isGthaOperatingScheduleForServiceDate({ date: "2026-08-18T18:42:54-04:00" }, "20260818"), false);

const gthaStaticTrip = {
	feed_id: "go",
	trip_id: "20260818-GT-3031",
	route_id: "GT",
	direction_id: 0,
};
const gthaOverrideResult = buildGthaOperatingScheduleUpdates(
	{
		date: "2026-08-18T18:42:54-04:00",
		commitmentTrip: [
			{
				tripNumber: "3031",
				tripName: "Union Station 19:04 - Bramalea GO 19:42",
				updateTime: "2026-08-18T18:42:54",
				stop: [
					{
						order: 2,
						name: "Union Station",
						schArrival: "19:04",
						schDeparture: "19:04",
						isStopping: "1",
						isCancelled: "0",
						isOverride: "0",
					},
					{
						order: 24,
						name: "Bramalea GO",
						schArrival: "19:42",
						schDeparture: "19:42",
						isStopping: "1",
						isCancelled: "0",
						isOverride: "0",
					},
					{
						order: 28,
						name: "Brampton Innovation District GO",
						schArrival: "19:50",
						schDeparture: "19:50",
						isStopping: "1",
						isCancelled: "0",
						isOverride: "1",
					},
					{
						order: 31,
						name: "Mount Pleasant GO",
						schArrival: "19:56",
						schDeparture: null,
						isStopping: "1",
						isCancelled: "0",
						isOverride: "1",
					},
				],
			},
		],
	},
	{
		serviceDayStartEpochSeconds: 1_000_000,
		resolveTrip: (tripNumber) => (tripNumber === "3031" ? gthaStaticTrip : null),
		resolveStopId: (name) =>
			({
				"Union Station": "UN",
				"Bramalea GO": "BE",
				"Brampton Innovation District GO": "BR",
				"Mount Pleasant GO": "MO",
			})[name] ?? null,
	},
);
assert.deepEqual(gthaOverrideResult.unresolvedTrips, []);
assert.deepEqual(gthaOverrideResult.unresolvedStops, []);
assert.equal(gthaOverrideResult.updates.length, 1);
const gthaReplacement = gthaOverrideResult.updates[0];
assert.equal(gthaReplacement.source_id, GTHA_OPERATING_SCHEDULE_SOURCE_ID);
assert.equal(gthaReplacement.trip.schedule_relationship, TripScheduleRelationship.REPLACEMENT);
assert.equal(gthaReplacement.trip.start_time, "19:04:00");
assert.deepEqual(
	gthaReplacement.stop_time_updates.map((stop) => stop.stop_id),
	["UN", "BE", "BR", "MO"],
);
assert.equal(gthaReplacement.stop_time_updates.at(-1).arrival_time, 1_071_760);
assert.equal(gthaReplacement.stop_time_updates.at(-1).departure_time, null);

const officialScheduled = {
	...gthaReplacement,
	update_id: "official-3031",
	source_id: "go-trip-updates",
	trip: { ...gthaReplacement.trip, schedule_relationship: TripScheduleRelationship.SCHEDULED },
	stop_time_updates: [],
};
assert.deepEqual(applyRealtimeReplacementPrecedence([officialScheduled, gthaReplacement]), [gthaReplacement]);
const injectionCtx = { raw: { injectedTripUpdates: [{ ...officialScheduled, source_id: "other-source" }] } };
replaceInjectedTripUpdates(injectionCtx, GTHA_OPERATING_SCHEDULE_SOURCE_ID, [gthaReplacement]);
assert.deepEqual(
	injectionCtx.raw.injectedTripUpdates.map((update) => update.source_id),
	["other-source", GTHA_OPERATING_SCHEDULE_SOURCE_ID],
);

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
assert.equal(
	journeyLocationName("Traralgon Railway Station", [
		{ name: "Traralgon: Coach Stop Plaza Shopping Centre", stopCode: "TG2", stopType: "Coach", line: "Gippsland" },
		{ name: "Traralgon Station: Princes Hwy", stopCode: "TGN", stopType: "Station", line: "Gippsland" },
	]),
	"Traralgon Station: Princes Hwy",
);
const vlineWithKey = createAuVicVlineNetwork({ gtfsRtKey: "test-key" });
assert.deepEqual(
	vlineWithKey.feeds.flatMap((feed) => feed.realtimeSources).map((source) => source.source.headers.KeyId),
	["test-key", "test-key", "test-key", "test-key"],
);

const australiaWithoutTfnsw = createAuRailNetwork();
assert.equal(australiaWithoutTfnsw.id, "au-rail");
assert.deepEqual(
	australiaWithoutTfnsw.feeds.map((feed) => feed.id),
	["translink-seq", "vic-vline", "vic-metro"],
);
assert.equal(australiaWithoutTfnsw.places.length, 18);
assert.deepEqual(australiaWithoutTfnsw.places.find((place) => place.id === "brisbane-central").members, [
	{ feedId: "translink-seq", localId: "place_censta" },
]);

const australiaRail = createAuRailNetwork({ tfnswApiKey: "test-tfnsw-key" });
assert.deepEqual(
	australiaRail.feeds.map((feed) => feed.id),
	["translink-seq", "vic-vline", "vic-metro", "nsw-sydney-trains", "nsw-trainlink"],
);
assert.equal(
	resolveTripNumber(australiaRail, {
		feed_id: "nsw-sydney-trains",
		trip_id: "ST21.220826.96.X.7.2042",
		trip_short_name: null,
	}),
	"ST21",
);
assert.equal(
	resolveTripNumber(australiaRail, { feed_id: "vic-vline", trip_id: "service-2042", trip_short_name: null }),
	"2042",
);
assert.deepEqual(australiaRail.places.find((place) => place.id === "southern-cross").members, [
	{ feedId: "vic-vline", localId: "vic:rail:SSS" },
	{ feedId: "vic-metro", localId: "vic:rail:SSS" },
	{ feedId: "nsw-trainlink", localId: "22180" },
]);
assert.deepEqual(australiaRail.places.find((place) => place.id === "albury").members, [
	{ feedId: "vic-vline", localId: "nsw:rail:ABY" },
	{ feedId: "nsw-trainlink", localId: "26401" },
]);
assert.deepEqual(australiaRail.places.find((place) => place.id === "brisbane-roma-street").members, [
	{ feedId: "translink-seq", localId: "place_romsta" },
	{ feedId: "nsw-trainlink", localId: "40001" },
]);
assert.deepEqual(australiaRail.places.find((place) => place.id === "sydney-central").members, [
	{ feedId: "nsw-sydney-trains", localId: "200060" },
	{ feedId: "nsw-trainlink", localId: "200060" },
]);
assert.equal(australiaRail.places.find((place) => place.id === "brisbane-central").name, "Brisbane Central");
assert.equal(australiaRail.places.find((place) => place.id === "sydney-central").name, "Sydney Central");
assert.equal(
	australiaRail.feeds.find((feed) => feed.id === "nsw-sydney-trains").staticSource.headers.Authorization,
	"apikey test-tfnsw-key",
);
const tfnswPlugin = australiaRail.plugins.find((plugin) => plugin.id === "au-nsw-tfnsw-rail");
const nonRevenueRoute = {
	feed_id: "nsw-sydney-trains",
	agency_id: "SydneyTrains",
	route_id: "RTTA_REV",
};
assert.equal(tfnswPlugin.considerRoute(nonRevenueRoute), true);
assert.equal(tfnswPlugin.isNonRevenueRoute(nonRevenueRoute), true);
const tfnswRouteContext = {
	config: { network: { plugins: [tfnswPlugin] } },
	runtimeState: { consideredRoutes: new Map() },
};
assert.equal(
	isConsideredRoute(
		{
			feed_id: "nsw-sydney-trains",
			agency_id: "Any Rail Operator",
			route_id: "RTTA_ANY_RAIL",
			route_type: RouteType.Rail,
		},
		tfnswRouteContext,
	),
	true,
);
assert.equal(
	isConsideredRoute(
		{
			feed_id: "nsw-sydney-trains",
			agency_id: "Any Bus Operator",
			route_id: "RTTA_ANY_BUS",
			route_type: RouteType.Bus,
		},
		tfnswRouteContext,
	),
	false,
);
assert.equal(
	tfnswPlugin.considerRoute({
		feed_id: "nsw-sydney-trains",
		agency_id: "Pacific National",
		route_id: "RTTA_PN",
	}),
	true,
);
assert.equal(isNonBoardingStopTime({ pickup_type: PickupType.None, drop_off_type: DropOffType.None }), true);
assert.equal(isNonBoardingStopTime({ pickup_type: PickupType.Regular, drop_off_type: DropOffType.None }), false);
assert.equal(isPassingStopTime({ pickup_type: PickupType.None, drop_off_type: DropOffType.None }), true);
assert.equal(isPassingStopTime({ pickup_type: PickupType.Regular, drop_off_type: DropOffType.None }), false);
assert.equal(isPassingStopTime({ pickup_type: PickupType.Regular, drop_off_type: DropOffType.Regular }, true), true);
assert.equal(
	isNonRevenueTrip(
		nonRevenueRoute,
		[
			{ pickup_type: PickupType.None, drop_off_type: DropOffType.None },
			{ pickup_type: PickupType.None, drop_off_type: DropOffType.None },
		],
		{ config: { network: { plugins: [] } } },
	),
	true,
);
assert.equal(
	isNonRevenueTrip(
		nonRevenueRoute,
		[
			{ pickup_type: PickupType.None, drop_off_type: DropOffType.None },
			{ pickup_type: PickupType.Regular, drop_off_type: DropOffType.None },
		],
		{ config: { network: { plugins: [] } } },
	),
	false,
);
assert.equal(tfnswPlatformCode("Redfern Station Platform 12"), "12");
assert.equal(tfnswPlatformCode("Redfern Station"), null);
assert.deepEqual(parseTfnswTripId("104B.937.150.128.A.8.90926398"), {
	runNumber: "104B",
	setType: "A",
	trainType: "Waratah",
	numberOfCars: 8,
	isPassenger: true,
});
assert.deepEqual(parseTfnswTripId("7.937.150.128.G.2.90926399"), {
	runNumber: "7",
	setType: "G",
	trainType: "Freight",
	numberOfCars: 2,
	isPassenger: false,
});
assert.deepEqual(parseTfnswTripId("ST21.220826.96.X.7.2042"), {
	runNumber: "ST21",
	setType: "X",
	trainType: "XPT",
	numberOfCars: 7,
	isPassenger: true,
});
assert.equal(parseTfnswTripId("104B.937.150.128.unknown.8.90926398"), null);
assert.equal(parseTfnswTripId("104B.937.150.128.A.eight.90926398"), null);
assert.equal(parseTfnswTripId("104B.937.150.128.A..90926398"), null);
const parsedTfnswTrip = {
	trip_id: "104B.937.150.128.A.8.90926398",
	trip_number: "6398",
	vehicle_model: null,
	scheduled_passenger_cars: null,
};
tfnswPlugin.enrichTrip(parsedTfnswTrip);
assert.equal(parsedTfnswTrip.trip_number, "104B");
assert.equal(parsedTfnswTrip.vehicle_model, "Waratah");
assert.equal(parsedTfnswTrip.scheduled_passenger_cars, 8);
const parsedTfnswFreightTrip = {
	trip_id: "7.937.150.128.G.2.90926399",
	trip_number: "6399",
	vehicle_model: null,
	scheduled_passenger_cars: null,
};
tfnswPlugin.enrichTrip(parsedTfnswFreightTrip);
assert.equal(parsedTfnswFreightTrip.trip_number, "7");
assert.equal(parsedTfnswFreightTrip.vehicle_model, "Freight");
assert.equal(parsedTfnswFreightTrip.scheduled_passenger_cars, null);
const parsedTrainLinkTrip = {
	trip_id: "ST21.220826.96.X.7.2042",
	trip_number: "2042",
	vehicle_model: null,
	scheduled_passenger_cars: null,
};
tfnswPlugin.enrichTrip(parsedTrainLinkTrip);
assert.equal(parsedTrainLinkTrip.trip_number, "ST21");
assert.equal(parsedTrainLinkTrip.vehicle_model, "XPT");
assert.equal(parsedTrainLinkTrip.scheduled_passenger_cars, 7);
const allocatedTrainLinkTrip = {
	feed_id: "nsw-trainlink",
	trip_id: "635.220826.96.P.3.2043",
	serviceDate: "20260822",
	instance_id: "trainlink-635-20260822",
};
const otherDayTrainLinkTrip = {
	...allocatedTrainLinkTrip,
	serviceDate: "20260823",
	instance_id: "trainlink-635-20260823",
};
const tfnswVehicleContext = {
	raw: { injectedVehiclePositions: [] },
	augmented: {
		tripsRec: new Map([
			[
				`13:nsw-trainlink${allocatedTrainLinkTrip.trip_id}`,
				{ instances: [allocatedTrainLinkTrip, otherDayTrainLinkTrip] },
			],
		]),
	},
	config: { network: { plugins: [tfnswPlugin] } },
	gtfs: {
		getRealtimeVehiclePositions: () => [
			{
				feed_id: "nsw-trainlink",
				trip: {
					feed_id: "nsw-trainlink",
					trip_id: allocatedTrainLinkTrip.trip_id,
					start_date: "20260822",
				},
				vehicle: { id: "opaque-vehicle-id", label: "EA2502", license_plate: "" },
				timestamp: 1787367261,
			},
		],
	},
	pluginState: new Map(),
};
tfnswPlugin.afterRealtime(tfnswVehicleContext, new Set());
assert.equal(tfnswPlugin.vehicleInfoForTrip(allocatedTrainLinkTrip, tfnswVehicleContext)?.vehicle_id, "EA2502");
assert.equal(tfnswPlugin.vehicleInfoForTrip(otherDayTrainLinkTrip, tfnswVehicleContext), null);
const anyTripOccupancyPayload = {
	header: { timestamp: 1787367261 },
	response: {
		tripInstance: {
			trip: { id: "au2:st:104B.937.150.128.A.8.90926398" },
			startDate: "20260822",
		},
		realtimePattern: [
			{ stopSequence: 1, departure: { occupancy: [1] } },
			{ stopSequence: 2, departure: { occupancy: [1, 2, 3, 4] } },
		],
	},
};
const parsedAnyTripOccupancy = parseAnyTripNswOccupancy(anyTripOccupancyPayload, {
	feedId: "nsw-sydney-trains",
	tripId: "104B.937.150.128.A.8.90926398",
	serviceDate: "20260822",
});
assert.equal(parsedAnyTripOccupancy[0].scope, "vehicle");
assert.equal(parsedAnyTripOccupancy[0].confidence, "historical");
assert.equal(parsedAnyTripOccupancy[1].scope, "carriage");
assert.equal(parsedAnyTripOccupancy[1].confidence, "reported");
assert.equal(
	parseAnyTripNswOccupancy(anyTripOccupancyPayload, {
		feedId: "nsw-sydney-trains",
		tripId: "different-trip",
		serviceDate: "20260822",
	}).length,
	0,
);
assert.equal(
	parseAnyTripNswOccupancy(anyTripOccupancyPayload, {
		feedId: "nsw-sydney-trains",
		tripId: "104B.937.150.128.A.8.90926398",
		serviceDate: "20260823",
	}).length,
	0,
);
let anyTripOccupancyRequests = 0;
let anyTripOccupancyUrl = "";
const anyTripOccupancyClient = new AnyTripNswOccupancyClient(
	{ baseUrl: "https://anytrip.test/api/v3/region/au2" },
	async (url) => {
		anyTripOccupancyRequests++;
		anyTripOccupancyUrl = String(url);
		return new Response(JSON.stringify(anyTripOccupancyPayload));
	},
);
const anyTripOccupancyTrip = {
	feed_id: "nsw-sydney-trains",
	trip_id: "104B.937.150.128.A.8.90926398",
	trip_number: "104B",
	serviceDate: "20260822",
};
await Promise.all([
	anyTripOccupancyClient.getTripOccupancy(anyTripOccupancyTrip),
	anyTripOccupancyClient.getTripOccupancy(anyTripOccupancyTrip),
]);
assert.equal(anyTripOccupancyRequests, 1);
assert.match(anyTripOccupancyUrl, /\/tripInstance\/20260822\/au2%3Ast%3A104B\/0$/);
const officialOccupancy = {
	statuses: [4],
	scope: "vehicle",
	source: "tfnsw-static-occupancies",
	confidence: "historical",
	observed_at: null,
	expires_at: null,
};
const occupancyPriorityTrip = {
	stopTimes: [
		{ _stopTime: { stop_sequence: 1 }, occupancy: officialOccupancy },
		{ _stopTime: { stop_sequence: 2 }, occupancy: null },
	],
};
assert.equal(applyAnyTripNswOccupancy(occupancyPriorityTrip, parsedAnyTripOccupancy, "2026-08-22T12:00:00Z"), 1);
assert.equal(occupancyPriorityTrip.stopTimes[0].occupancy, officialOccupancy);
assert.equal(occupancyPriorityTrip.stopTimes[1].occupancy.source, "anytrip-nsw");
const trainLinkBookingTrip = {
	feed_id: "nsw-trainlink",
	trip_number: "ST21",
	serviceDate: "20260822",
	stopTimes: [
		{
			scheduled_stop_id: "200060",
			scheduled_departure_time: 20 * 60 * 60 + 42 * 60,
		},
		{ scheduled_stop_id: "22180", scheduled_arrival_time: 31 * 60 * 60 + 30 * 60 },
	],
};
const trainLinkBookingCandidate = {
	origin: { id: "SYD", name: "Sydney Central Station" },
	destination: { id: "MEL", name: "Melbourne Southern Cross Station" },
	legs: [
		{
			origin: "SYD",
			destination: "MEL",
			startDate: "2026-08-22T20:42:00+10:00",
			endDate: "2026-08-23T07:30:00+10:00",
			isUnreservedService: false,
			service: { carrier: "NSW TrainLink", lineNumber: "621" },
		},
	],
	offers: {},
};
assert.ok(
	tfnswRegionalBookingTest.matchesTrip(
		trainLinkBookingCandidate,
		trainLinkBookingTrip,
		"SYD",
		"MEL",
		"20260822",
		"621",
	),
);
assert.equal(
	tfnswRegionalBookingTest.matchesTrip(
		trainLinkBookingCandidate,
		trainLinkBookingTrip,
		"SYD",
		"MEL",
		"20260822",
		"635",
	),
	null,
);
assert.deepEqual(
	tfnswRegionalBookingTest.formationFromAvailability(
		{
			vehicle_id: null,
			vehicle_model: "XPT",
			passenger_cars: null,
			scheduled_passenger_cars: 7,
			consist: null,
		},
		null,
	),
	{
		vehicleId: null,
		model: "XPT",
		passengerCars: null,
		scheduledPassengerCars: 7,
		units: [],
		accessibleSpaces: null,
		bicycleSpaces: null,
		isLive: null,
		source: "Transport for NSW regional booking",
		observedAt: null,
		bookingAvailability: null,
		bookingAvailabilityStatus: "unavailable",
	},
);
assert.equal(
	inferTfnswRealtimeServiceDate({
		candidateServiceDates: ["20260820", "20260821"],
		firstServiceTime: 23 * 60 * 60,
		lastServiceTime: 23.5 * 60 * 60,
		nowEpochSeconds: Date.parse("2026-08-20T13:15:00Z") / 1000,
		timeZone: "Australia/Sydney",
	}),
	"20260820",
);
assert.equal(
	matchRealtimeStopTimeUpdate({
		stopSequence: 4,
		stopId: "2015131",
		parentStationId: "201510",
		bySequence: new Map(),
		byStopId: new Map(),
		byParentStationId: new Map([["201510", { stop_id: "2015142" }]]),
	})?.stop_id,
	"2015142",
);
assert.equal(
	tfnswPlugin.considerRoute({
		feed_id: "nsw-sydney-trains",
		agency_id: "NSWTrains",
		route_id: "CTY_W1a",
	}),
	true,
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
assert.equal(viaCarriageEquipmentLabel(" VEN - GL - 4A - 62 Eco car - NOwc ", "coach"), "VEN");
assert.equal(viaCarriageEquipmentLabel("Prestige Sleeper", "sleeper"), "Prestige Sleeper");
assert.equal(viaCarriageEquipmentLabel("", "coach"), "Coach");

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
assert.equal(
	serviceMatchesPlatformTrip({ ...platformRunMatch, tdn: "8241" }, platformMatchTrip, "southerncross"),
	false,
);
assert.equal(
	serviceMatchesPlatformTrip(
		{ ...platformRunMatch, scheduledDepartureTime: "2026-08-13T14:32:00" },
		platformMatchTrip,
		"southerncross",
	),
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
const anyTripInstance = {
	trip: {
		shortName: "8605",
		route: { mode: "au3:vlinetrains" },
	},
	startDate: "20260822",
	instanceNumber: 0,
	_path: "tripInstance/20260822/au3:aa:8605/0",
};
const anyTripStopTime = {
	stop: {
		id: "au3:G1181-P1",
		disassembled: { platformName: "1" },
		parent: { id: "au3:G1181", aliases: ["au3:vic:rail:SSS"] },
	},
	scheduledStop: { id: "au3:20043" },
	stopSequence: 1,
	arrival: { time: 1787346442 },
	departure: { time: 1787346442 },
	_path: "stopTime/20260822/au3:aa:8605/0/1",
};
const anyTripPayload = {
	header: { timestamp: 1787373438 },
	response: { tripInstance: anyTripInstance, realtimePattern: [anyTripStopTime] },
};
const anyTripCalls = anyTripTest.parseTripResponse(anyTripPayload, "8605", "20260822");
assert.deepEqual(anyTripCalls[0], {
	tdn: "8605",
	serviceDate: "20260822",
	instanceNumber: 0,
	scheduledStopId: "20043",
	parentStationId: "vic:rail:SSS",
	stopSequence: 1,
	arrivalEpoch: 1787346442,
	departureEpoch: 1787346442,
	platform: "1",
	observedAt: "2026-08-22T04:37:18.000Z",
	rawIdentifier: "stopTime/20260822/au3:aa:8605/0/1",
});
assert.equal(anyTripTest.parseTripResponse(anyTripPayload, "8605", "20260823").length, 0);
const anyTripMatchStop = {
	scheduled_stop_id: "20043",
	scheduled_parent_station_id: "vic:rail:SSS",
	scheduled_departure_time: 6 * 3600,
	scheduled_arrival_time: 6 * 3600,
};
const anyTripMatchTrip = {
	feed_id: "vic-vline",
	trip_id: "01-ABY--4-T2-8605",
	serviceDate: "20260822",
	stopTimes: [anyTripMatchStop],
};
assert.equal(matchAnyTripPlatformCall(anyTripMatchTrip, anyTripCalls[0]), anyTripMatchStop);
assert.equal(matchAnyTripPlatformCall({ ...anyTripMatchTrip, serviceDate: "20260823" }, anyTripCalls[0]), null);
assert.ok(
	vlineEnrichmentTest.platformPriority({ source: "anytrip-v3", confidence: "reported" }) >
		vlineEnrichmentTest.platformPriority({ source: "vline-scs-html", confidence: "confirmed" }),
);
const precedenceStop = {
	scheduled_stop_id: "20043",
	scheduled_parent_station_id: "vic:rail:SSS",
	actual_platform_code: null,
	rt_platform_code_updated: false,
	actual_arrival_boarding_locations: [],
	actual_departure_boarding_locations: [],
};
const platformObservation = (source, value) => ({
	source,
	value,
	confidence: source === "vline-scs-html" ? "confirmed" : "reported",
	observedAt: "2026-08-22T04:37:18.000Z",
	stopId: "20043",
	event: "both",
	kind: "platform",
});
vlineEnrichmentTest.applyStoredPlatforms(
	{ stopTimes: [precedenceStop] },
	{ platforms: [platformObservation("anytrip-v3", "1"), platformObservation("vline-scs-html", "2")] },
);
assert.equal(precedenceStop.actual_platform_code, "1");
const directPlatformStop = {
	...precedenceStop,
	actual_platform_code: "9",
	rt_platform_code_updated: true,
	actual_arrival_boarding_locations: [],
	actual_departure_boarding_locations: [],
};
vlineEnrichmentTest.applyStoredPlatforms(
	{ stopTimes: [directPlatformStop] },
	{ platforms: [platformObservation("anytrip-v3", "1")] },
);
assert.equal(directPlatformStop.actual_platform_code, "9");
assert.equal(
	anyTripTest.parseStationResponse({
		header: anyTripPayload.header,
		response: { departures: [{ tripInstance: anyTripInstance, stopTimeInstance: anyTripStopTime }] },
	}).length,
	1,
);
let anyTripRequestCount = 0;
const anyTripClient = new AnyTripPlatformClient({ tripCacheTtlMs: 60_000 }, async () => {
	anyTripRequestCount++;
	return new Response(JSON.stringify(anyTripPayload), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
});
const [firstAnyTripRequest, secondAnyTripRequest] = await Promise.all([
	anyTripClient.getTripPlatforms("8605", "20260822"),
	anyTripClient.getTripPlatforms("8605", "20260822"),
]);
assert.equal(anyTripRequestCount, 1);
assert.deepEqual(firstAnyTripRequest, secondAnyTripRequest);
assert.equal(anyTripClient.diagnostics.tripCacheEntries, 1);
let missingAnyTripRequestCount = 0;
const missingAnyTripClient = new AnyTripPlatformClient({ tripCacheTtlMs: 60_000 }, async () => {
	missingAnyTripRequestCount++;
	return new Response("Trip instance not found", { status: 404 });
});
assert.deepEqual(await missingAnyTripClient.getTripPlatforms("9999", "20260822"), []);
assert.deepEqual(await missingAnyTripClient.getTripPlatforms("9999", "20260822"), []);
assert.equal(missingAnyTripRequestCount, 1);
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
assert.deepEqual(vlineServiceBookingAvailability(journeyServices[0], "2026-08-15T00:20:00Z"), {
	reservedCarriages: [],
	reservedSeatsAvailable: null,
	unreservedTicketsAvailable: null,
	reservationAvailable: false,
	reservationRequired: false,
	seatMapAvailable: false,
	journeyUrl: null,
	source: "V/Line Journey Planner",
	observedAt: "2026-08-15T00:20:00Z",
});

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
const bookingWithDifferentPublicCode = parseVLineBookingPage(
	`<div class="journey-leg" data-departure-time="2026-08-20 09:25:00">
<div class="view-consist-panel"><input id="x_hdnServiceCode" value="8307">
<input id="x_hdnServiceOriginDateTime" value="20/08/2026 9:25:00 AM"><input id="x_hdnCarList" value="C,D">
<tr id="x_spnReservedSeatsTrain" class="economy-seats"><span class="description">80 seats available</span><a id="x_lnbTrainSeats" class="viewseats">View seats</a></tr>
<tr id="x_spnUnreservedSeats" class="unreserved-seats"><span class="description">50 tickets available</span></tr></div></div>`,
	{
		tdn: "8363",
		scheduledDepartureTime: "2026-08-20T09:25:00",
		journeyUrl: "https://www.vline.com.au/example",
		observedAt: "2026-08-19T23:03:52Z",
	},
);
assert.deepEqual(bookingWithDifferentPublicCode, {
	tdn: "8363",
	reservedCarriages: ["C", "D"],
	reservedSeatsAvailable: 80,
	unreservedTicketsAvailable: 50,
	reservationAvailable: true,
	reservationRequired: false,
	seatMapAvailable: true,
	journeyUrl: "https://www.vline.com.au/example",
	observedAt: "2026-08-19T23:03:52Z",
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

function orphanTripFeed() {
	return createZip({
		"agency.txt":
			"agency_id,agency_name,agency_url,agency_timezone\nSydneyTrains,Synthetic Sydney,https://example.test,Australia/Sydney\n",
		"routes.txt":
			"route_id,agency_id,route_short_name,route_long_name,route_type\n" +
			"passenger,SydneyTrains,T1,Passenger service,2\n" +
			"RTTA_REV,SydneyTrains,RTTA,Non-revenue movement,2\n",
		"stops.txt":
			"stop_id,stop_name,stop_lat,stop_lon\ncentral,Central,-33.883,151.207\nredfern,Redfern,-33.892,151.199\n",
		"trips.txt":
			"route_id,service_id,trip_id,trip_headsign,direction_id\n" +
			"passenger,daily,passenger-trip,Redfern,0\n" +
			"RTTA_REV,daily,valid-rtta,Redfern,0\n" +
			"RTTA_REV,daily,orphan-rtta,Redfern,0\n",
		"stop_times.txt":
			"trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type\n" +
			"passenger-trip,10:00:00,10:00:00,central,1,0,1\n" +
			"passenger-trip,10:05:00,10:05:00,redfern,2,1,0\n" +
			"valid-rtta,11:00:00,11:00:00,central,1,0,1\n" +
			"valid-rtta,11:05:00,11:05:00,redfern,2,1,0\n",
		"calendar.txt":
			"service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n" +
			"daily,1,1,1,1,1,1,1,20260101,20261231\n",
	});
}

function continuationFeed() {
	return createZip({
		"agency.txt":
			"agency_id,agency_name,agency_url,agency_timezone\nagency,Continuation Test,https://example.test,Australia/Brisbane\n",
		"routes.txt":
			"route_id,agency_id,route_short_name,route_long_name,route_type\nrail,agency,R,Continuation Rail,2\n",
		"stops.txt":
			"stop_id,stop_name,stop_lat,stop_lon\n" +
			"origin,Southern Cross,-27.40,153.00\n" +
			"handoff,Flinders Street,-27.41,153.01\n" +
			"central,Melbourne Central,-27.42,153.02\n" +
			"random,Random Station,-27.43,153.03\n" +
			"epping,Epping,-27.44,153.04\n",
		"trips.txt":
			"route_id,service_id,trip_id,trip_headsign,direction_id,block_id\n" +
			"rail,daily,southern-flinders,Flinders Street,0,southern-block\n" +
			"rail,daily,flinders-central,Melbourne Central,0,southern-block\n" +
			"rail,daily,loop-out,Random Station,0,loop-block\n" +
			"rail,daily,loop-back,Southern Cross,1,loop-block\n" +
			"rail,daily,loop-epping,Epping,0,loop-block\n" +
			"rail,daily,must-alight-a,Flinders Street,0,alight-block\n" +
			"rail,daily,must-alight-b,Melbourne Central,0,alight-block\n" +
			"rail,daily,block-a,Flinders Street,0,fallback-block\n" +
			"rail,daily,block-b,Melbourne Central,0,fallback-block\n" +
			"rail,daily,block-c,Epping,0,fallback-block\n" +
			"rail,daily,block-wrong-a,Random Station,0,wrong-block\n" +
			"rail,daily,block-wrong-b,Melbourne Central,0,wrong-block\n" +
			"rail,daily,100-seq,Flinders Street,0,\n" +
			"rail,daily,101-seq,Melbourne Central,0,\n" +
			"rail,daily,200-seq,Flinders Street,0,\n" +
			"rail,daily,205-seq,Melbourne Central,0,\n" +
			"rail,daily,300-seq,Random Station,0,\n" +
			"rail,daily,301-seq,Melbourne Central,0,\n" +
			"rail,daily,400-seq,Flinders Street,0,\n" +
			"rail,daily,401-seq,Melbourne Central,0,\n" +
			"rail,daily,500-seq,Flinders Street,0,\n" +
			"rail,daily,501-seq,Melbourne Central,0,\n" +
			"rail,daily,600-seq,Flinders Street,0,\n" +
			"rail,daily,601-seq,Melbourne Central,0,\n",
		"stop_times.txt":
			"trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type\n" +
			"southern-flinders,10:00:00,10:00:00,origin,1,0,1\n" +
			"southern-flinders,10:05:00,10:05:00,handoff,2,1,0\n" +
			"flinders-central,10:07:00,10:07:00,handoff,1,0,1\n" +
			"flinders-central,10:12:00,10:12:00,central,2,1,0\n" +
			"loop-out,11:00:00,11:00:00,origin,1,0,1\n" +
			"loop-out,11:20:00,11:20:00,random,2,1,0\n" +
			"loop-back,11:22:00,11:22:00,random,1,0,1\n" +
			"loop-back,11:42:00,11:42:00,origin,2,1,0\n" +
			"loop-epping,11:44:00,11:44:00,origin,1,0,1\n" +
			"loop-epping,12:04:00,12:04:00,epping,2,1,0\n" +
			"must-alight-a,13:00:00,13:00:00,origin,1,0,1\n" +
			"must-alight-a,13:05:00,13:05:00,handoff,2,1,0\n" +
			"must-alight-b,13:07:00,13:07:00,handoff,1,0,1\n" +
			"must-alight-b,13:12:00,13:12:00,central,2,1,0\n" +
			"block-a,14:00:00,14:00:00,origin,1,0,1\n" +
			"block-a,14:05:00,14:05:00,handoff,2,1,0\n" +
			"block-b,14:07:00,14:07:00,handoff,1,0,1\n" +
			"block-b,14:12:00,14:12:00,central,2,1,0\n" +
			"block-c,14:14:00,14:14:00,central,1,0,1\n" +
			"block-c,14:19:00,14:19:00,epping,2,1,0\n" +
			"block-wrong-a,15:00:00,15:00:00,origin,1,0,1\n" +
			"block-wrong-a,15:05:00,15:05:00,random,2,1,0\n" +
			"block-wrong-b,15:07:00,15:07:00,handoff,1,0,1\n" +
			"block-wrong-b,15:12:00,15:12:00,central,2,1,0\n" +
			"100-seq,16:00:00,16:00:00,origin,1,0,1\n" +
			"100-seq,16:05:00,16:05:00,handoff,2,1,0\n" +
			"101-seq,16:07:00,16:07:00,handoff,1,0,1\n" +
			"101-seq,16:12:00,16:12:00,central,2,1,0\n" +
			"200-seq,17:00:00,17:00:00,origin,1,0,1\n" +
			"200-seq,17:05:00,17:05:00,handoff,2,1,0\n" +
			"205-seq,17:07:00,17:07:00,handoff,1,0,1\n" +
			"205-seq,17:12:00,17:12:00,central,2,1,0\n" +
			"300-seq,18:00:00,18:00:00,origin,1,0,1\n" +
			"300-seq,18:05:00,18:05:00,random,2,1,0\n" +
			"301-seq,18:07:00,18:07:00,handoff,1,0,1\n" +
			"301-seq,18:12:00,18:12:00,central,2,1,0\n" +
			"400-seq,19:00:00,19:00:00,origin,1,0,1\n" +
			"400-seq,19:05:00,19:05:00,handoff,2,1,0\n" +
			"401-seq,19:06:00,19:06:00,handoff,1,0,1\n" +
			"401-seq,19:11:00,19:11:00,central,2,1,0\n" +
			"500-seq,20:00:00,20:00:00,origin,1,0,1\n" +
			"500-seq,20:05:00,20:05:00,handoff,2,1,0\n" +
			"501-seq,20:36:00,20:36:00,handoff,1,0,1\n" +
			"501-seq,20:41:00,20:41:00,central,2,1,0\n" +
			"600-seq,21:00:00,21:00:00,origin,1,0,1\n" +
			"600-seq,21:05:00,21:05:00,handoff,2,1,0\n" +
			"601-seq,21:07:00,21:07:00,handoff,1,0,1\n" +
			"601-seq,21:12:00,21:12:00,central,2,1,0\n",
		"transfers.txt":
			"from_stop_id,to_stop_id,from_trip_id,to_trip_id,transfer_type\n" +
			"handoff,handoff,southern-flinders,flinders-central,4\n" +
			"random,random,loop-out,loop-back,4\n" +
			"origin,origin,loop-back,loop-epping,4\n" +
			"handoff,handoff,must-alight-a,must-alight-b,4\n" +
			"handoff,handoff,must-alight-a,must-alight-b,5\n",
		"calendar.txt":
			"service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n" +
			"daily,1,1,1,1,1,1,1,20260101,20261231\n",
	});
}

const feeds = {
	"/a.zip": feed("Alpha", "Australia/Brisbane"),
	"/b.zip": feed("Beta", "America/Toronto", true),
	"/orphan.zip": orphanTripFeed(),
	"/continuations.zip": continuationFeed(),
};
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
	const orphanRuntime = new TRAX(
		{
			id: "orphan-test",
			name: "Orphan trip test",
			modes: ["rail"],
			feeds: [
				{
					id: "orphan",
					staticSource: { url: `${origin}/orphan.zip` },
					realtimeSources: [],
				},
			],
			plugins: [
				{
					id: "synthetic-non-revenue",
					feedIds: ["orphan"],
					capabilities: [],
					isNonRevenueRoute: (route) => route.route_id === "RTTA_REV",
				},
			],
		},
		{ cacheDir: ".TRAXCACHE/test-orphan" },
	);
	await orphanRuntime.loadGTFS(false, false);
	assert.equal(orphanRuntime.getRawTrips({ feed_id: "orphan", trip_id: "orphan-rtta" }).length, 1);
	assert.equal(orphanRuntime.getAugmentedTrips({ feedId: "orphan", localId: "orphan-rtta" }).length, 0);
	assert.equal(
		orphanRuntime.getAugmentedTrips({ feedId: "orphan", localId: "valid-rtta" })[0].instances[0].nonRevenue,
		true,
	);
	assert.equal(
		orphanRuntime.getAugmentedTrips({ feedId: "orphan", localId: "passenger-trip" })[0].instances[0].nonRevenue,
		false,
	);
	const continuationRuntime = new TRAX(
		{
			id: "continuation-test",
			name: "Continuation test",
			modes: ["rail"],
			plugins: [],
			feeds: [
				{
					id: "continuation",
					staticSource: { url: `${origin}/continuations.zip` },
					realtimeSources: [],
				},
			],
			places: [
				{
					id: "sydney-central",
					name: "Sydney Central",
					members: [{ feedId: "continuation", localId: "central" }],
				},
			],
		},
		{ cacheDir: ".TRAXCACHE/test-continuations" },
	);
	await continuationRuntime.loadGTFS(false, false);
	const instanceFor = (tripId) =>
		continuationRuntime
			.getAugmentedTrips({ feedId: "continuation", localId: tripId })[0]
			.instances.find((instance) => instance.serviceDate === continuationRuntime.today());
	const destinationsFor = (tripId, departureTime) =>
		continuationRuntime.getOnboardReachableStops(instanceFor(tripId).instance_id, {
			stopIds: ["origin"],
			departureTime,
		});
	const destinationNames = (tripId, departureTime) =>
		destinationsFor(tripId, departureTime).map((destination) => destination.station_name);
	assert.deepEqual(destinationNames("southern-flinders", 10 * 3600), ["Flinders Street", "Sydney Central"]);
	assert.deepEqual(destinationNames("loop-out", 11 * 3600), ["Random Station"]);
	assert.deepEqual(destinationNames("must-alight-a", 13 * 3600), ["Flinders Street"]);
	assert.deepEqual(destinationNames("block-a", 14 * 3600), ["Flinders Street", "Sydney Central"]);
	assert.equal(destinationsFor("block-a", 14 * 3600)[1].continuation_source, "gtfs-block");
	assert.deepEqual(destinationNames("block-wrong-a", 15 * 3600), ["Random Station"]);

	const linkSeq = (fromTripId, toTripId, broken = false) => {
		const from = instanceFor(fromTripId);
		from.seq_diagram_next_instance_id = instanceFor(toTripId).instance_id;
		from.seq_diagram_next_link_broken = broken;
	};
	linkSeq("100-seq", "101-seq");
	linkSeq("200-seq", "205-seq");
	linkSeq("300-seq", "301-seq");
	linkSeq("400-seq", "401-seq");
	linkSeq("500-seq", "501-seq");
	linkSeq("600-seq", "601-seq", true);
	assert.deepEqual(destinationNames("100-seq", 16 * 3600), ["Flinders Street", "Sydney Central"]);
	assert.equal(destinationsFor("100-seq", 16 * 3600)[1].continuation_source, "seq-inferred");
	assert.deepEqual(destinationNames("200-seq", 17 * 3600), ["Flinders Street"]);
	assert.deepEqual(destinationNames("300-seq", 18 * 3600), ["Random Station"]);
	assert.deepEqual(destinationNames("400-seq", 19 * 3600), ["Flinders Street"]);
	assert.deepEqual(destinationNames("500-seq", 20 * 3600), ["Flinders Street"]);
	assert.deepEqual(destinationNames("600-seq", 21 * 3600), ["Flinders Street"]);
	const failingSupplemental = new TRAX(
		{
			...definition,
			id: "synthetic-supplemental-failure",
			feeds: [definition.feeds[0]],
			places: [],
			plugins: [
				{
					id: "failing-supplemental",
					feedIds: ["alpha"],
					capabilities: ["supplemental-realtime"],
					beforeRealtime() {
						throw new Error("synthetic supplemental timeout");
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
		failingSupplemental.getSourceHealth().find((source) => source.id === "failing-supplemental:supplemental").state,
		"error",
	);
	assert.equal(
		failingSupplemental.getSourceHealth().find((source) => source.id === "after-realtime-enrichment:supplemental")
			.state,
		"healthy",
	);
	assert.equal(runtime.getRawTrips({ trip_id: "shared" }).length, 2);
	assert.equal(runtime.getTripIdsByNumber("ared").size, 2);
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
