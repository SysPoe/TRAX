import assert from "node:assert/strict";
import { encode } from "@msgpack/msgpack";
import { createTransitAppPlugin, mapTransitRoutes } from "../dist/plugins/transit-app.js";
import {
	TransitAppClient,
	parseTransitVehicle,
	parseTransitPrediction,
	parseTransitCrowding,
} from "../dist/plugins/transit-app-client.js";
import { createEmptyRawCache, createEmptyAugmentedCache, createRuntimeState } from "../dist/cache/factories.js";
import { getVehiclePositions } from "../dist/cache/gtfsReads.js";
import { resolveConfig } from "../dist/config.js";
import { entityKey } from "../dist/identity.js";

const now = Date.parse("2026-10-03T10:00:00Z");
const originalNow = Date.now;
Date.now = () => now;
try {
	const nativeDeparture = (now + 60_000) / 1000 - 946684800;
	const tuple = [
		0,
		0,
		[0, 0, 0],
		1,
		0,
		nativeDeparture,
		"",
		"",
		"",
		"8592",
		"trip",
		false,
		[],
		0,
		"",
		"prediction-id",
		nativeDeparture - 30,
	];
	assert.deepEqual(parseTransitPrediction(tuple, now), {
		tripId: "trip",
		departureAt: now + 60_000,
		scheduledDepartureAt: now + 30_000,
		observedAt: now,
	});
	assert.equal(parseTransitPrediction([...tuple.slice(0, 10), "", ...tuple.slice(11)], now), null);
	assert.equal(parseTransitPrediction(["unrecognized schema"], now), null);
	assert.equal(parseTransitCrowding(0, now / 1000, now, 300_000)?.level, "not-crowded");
	assert.equal(parseTransitCrowding("FEW_SEATS", now / 1000, now, 300_000)?.level, "some-crowding");
	assert.equal(parseTransitCrowding(99, now / 1000, now, 300_000), null);
	assert.equal(parseTransitCrowding(1, (now - 300_000) / 1000, now, 300_000), null);

	const row = {
		uuid: "private-rider-identifier",
		feed_id: 1,
		global_route_id: 42,
		lat: 43.6,
		lng: -79.4,
		updated_at: now / 1000,
		assigned_rt_trip_ids: ["trip"],
		is_unmerged_crowd: true,
		avatars: [{ username: "private profile", rank: 10 }],
		occupancy: 1,
		occupancy_updated_at: now / 1000,
	};
	const vehicle = parseTransitVehicle(row, now, 180_000);
	assert(vehicle);
	assert(!JSON.stringify(vehicle).includes("private profile"));
	assert.equal(parseTransitVehicle({ ...row, lat: 180 }, now, 180_000), null);
	assert.equal(parseTransitVehicle({ ...row, updated_at: (now - 180_000) / 1000 }, now, 180_000), null);

	const feed = { feedId: "rail", transitFeedId: 1, latitude: 43.6, longitude: -79.4 };
	const route = { feed_id: "rail", route_id: "R", route_short_name: "R", route_long_name: "Rail", route_type: 2 };
	const payload = {
		routes: [
			{
				feed_id: 1,
				global_route_id: 42,
				realtime_recipe_id: 9,
				short_name: "R",
				long_name: "Rail",
				itineraries: [
					{
						itineraries: [{ realTimeRouteIds: ["R"] }],
						stops_by_itinerary_id_map: { 0: [{ stop_id: 800, stop_stable_id: 44, raw_stop_id: "A" }] },
					},
				],
			},
		],
	};
	const mappings = mapTransitRoutes(payload, feed, [route], new Set(["A"]));
	assert.equal(mappings.length, 1);
	assert.deepEqual([...mappings[0].stops], [[44, "A"]]);
	assert.equal(mapTransitRoutes(payload, { ...feed, transitFeedId: 2 }, [route], new Set(["A"])).length, 0);
	assert.equal(
		mapTransitRoutes(
			payload,
			feed,
			[
				{ ...route, route_id: "X" },
				{ ...route, route_id: "Y" },
			],
			new Set(["A"]),
		).length,
		0,
	);
	const grouped = structuredClone(payload);
	grouped.routes[0].itineraries[0].itineraries[0].realTimeRouteIds.push("R2");
	assert.equal(
		mapTransitRoutes(grouped, feed, [route, { ...route, route_id: "R2" }], new Set(["A"])).length,
		2,
		"explicit GTFS IDs allow several routes under one Transit line",
	);

	let requestedUrl, auth;
	const client = new TransitAppClient({
		installationId: "12345678-1234-1234-1234-123456789012",
		apiKey: "test-key",
		fetch: async (url, init) => {
			requestedUrl = url;
			auth = init.headers.Authorization;
			return new Response(encode({ "42:44": [tuple] }));
		},
	});
	const predictions = await client.predictions(mappings);
	assert.equal(requestedUrl.searchParams.get("route_stop_pairs"), "42:44");
	assert.equal(requestedUrl.origin, "https://api.transitapp.com");
	assert.equal(
		requestedUrl.pathname,
		"/v3/real_time/gtfsrt_predictions_batch",
		"use the canonical endpoint so redirects cannot discard Basic auth",
	);
	assert.equal(Buffer.from(auth.slice(6), "base64").toString(), "12345678-1234-1234-1234-123456789012:test-key");
	assert.equal(predictions[0].stopId, "A");
	let redirectCalls = 0;
	const redirectClient = new TransitAppClient({
		installationId: "12345678-1234-1234-1234-123456789012",
		apiKey: "test-key",
		fetch: async (url, init) => {
			assert.equal(init.headers.Authorization, auth);
			if (++redirectCalls === 1)
				return new Response(null, {
					status: 301,
					headers: {
						Location: "https://realtime-data-api.transitapp.com/v3/real_time/gtfsrt_predictions_batch",
					},
				});
			assert.equal(url.hostname, "realtime-data-api.transitapp.com");
			return new Response(encode({ "42:44": [tuple] }));
		},
	});
	assert.equal((await redirectClient.predictions(mappings)).length, 1);
	const unsafeRedirectClient = new TransitAppClient({
		installationId: "12345678-1234-1234-1234-123456789012",
		apiKey: "test-key",
		fetch: async () => new Response(null, { status: 302, headers: { Location: "https://example.test/steal" } }),
	});
	await assert.rejects(unsafeRedirectClient.predictions(mappings), /unsupported redirect/);
	let batches = 0;
	const batchClient = new TransitAppClient({
		installationId: "12345678-1234-1234-1234-123456789012",
		apiKey: "test-key",
		fetch: async (url) => {
			const pairs = url.searchParams.get("route_stop_pairs").split(",");
			assert(pairs.length <= 10, "stay within the verified upstream batch size");
			batches++;
			return new Response(encode(Object.fromEntries(pairs.map((pair) => [pair, [tuple]]))));
		},
	});
	assert.equal(
		(
			await batchClient.predictions([
				{ ...mappings[0], stops: new Map(Array.from({ length: 23 }, (_, i) => [100 + i, `stop-${i}`])) },
			])
		).length,
		23,
	);
	assert.equal(batches, 3, "fetch every stop across bounded batches");
	const sent = [];
	const snapshotClient = new TransitAppClient({
		installationId: "12345678-1234-1234-1234-123456789012",
		apiKey: "test-key",
		snapshotWindowMs: 1,
		webSocket: () => {
			const socket = { send: (value) => sent.push(JSON.parse(value)), close() {} };
			queueMicrotask(() => {
				socket.onopen();
				socket.onmessage({ data: JSON.stringify({ type: "vehicle", vehicles: null }) });
			});
			return socket;
		},
	});
	assert.deepEqual(await snapshotClient.vehicles(mappings), [], "a JSON-null list is a valid empty route snapshot");
	assert.equal(sent[1].subscribe, "vehicle");
	assert(
		!sent.some((message) => "lat" in message || "lng" in message),
		"the adapter never publishes a rider location",
	);

	let fail = false,
		officialPositions = [],
		officialUpdates = [];
	const plugin = createTransitAppPlugin({
		installationId: "12345678-1234-1234-1234-123456789012",
		apiKey: "test-key",
		feeds: [feed],
		client: {
			searchRoutes: async () => payload,
			vehicles: async () => {
				if (fail) throw Error("offline");
				return [vehicle];
			},
			predictions: async () => {
				if (fail) throw Error("offline");
				return predictions;
			},
		},
	});
	const config = resolveConfig(
		{
			id: "test",
			name: "Test",
			feeds: [{ id: "rail", staticSource: { url: "https://example.test/feed" }, realtimeSources: [] }],
			modes: ["rail"],
			plugins: [plugin],
		},
		{ logFunction() {} },
	);
	config.feedTimeZones.set("rail", "UTC");
	const ctx = {
		config,
		raw: createEmptyRawCache(),
		augmented: createEmptyAugmentedCache(),
		runtimeState: createRuntimeState(),
		pluginState: new Map(),
		gtfs: {
			getRealtimeVehiclePositions: () => officialPositions,
			getRealtimeTripUpdates: () => officialUpdates,
			getServiceDatesByTrip: () => ["20261003"],
			getStopTimes: () => [{ stop_sequence: 1, departure_time: 36_030 }],
		},
	};
	ctx.raw.routesByKey.set(entityKey({ feedId: "rail", localId: "R" }), route);
	ctx.raw.tripsByKey.set(entityKey({ feedId: "rail", localId: "trip" }), {
		feed_id: "rail",
		trip_id: "trip",
		route_id: "R",
		service_id: "daily",
	});
	ctx.raw.stopsByFeed.set("rail", [{ stop_id: "A" }]);
	ctx.raw.tripStopTimeBoundsByKey.set(entityKey({ feedId: "rail", localId: "trip" }), {
		start_time: 35_000,
		end_time: 38_000,
	});
	await plugin.beforeRealtime(ctx);
	assert.equal(ctx.raw.injectedVehiclePositions.length, 1);
	assert.equal(ctx.raw.injectedTripUpdates[0].stop_time_updates[0].departure_time, (now + 60_000) / 1000);
	assert.equal(ctx.raw.injectedVehiclePositions[0].trip.start_date, "20261003");
	assert(!JSON.stringify(ctx.raw.injectedVehiclePositions).includes(row.uuid));
	const api = plugin.api(ctx);
	assert.equal(api.getTripObservation("rail", "trip", "20261003").crowding.level, "some-crowding");
	assert.equal(api.getTripObservation("rail", "trip", "20261004"), null);
	assert.equal(api.getTripObservation("another-feed", "trip", "20261003"), null);
	const publicVehicleId = ctx.raw.injectedVehiclePositions[0].vehicle.id;
	vehicle.id = "another-private-rider-identifier";
	await plugin.beforeRealtime(ctx);
	assert.equal(
		ctx.raw.injectedVehiclePositions[0].vehicle.id,
		publicVehicleId,
		"changing riders does not change the public service marker identity",
	);

	officialPositions = [{ ...ctx.raw.injectedVehiclePositions[0], source_id: "agency" }];
	officialUpdates = [{ ...ctx.raw.injectedTripUpdates[0], source_id: "agency" }];
	await plugin.beforeRealtime(ctx);
	assert.equal(ctx.raw.injectedVehiclePositions.length, 0, "do not duplicate fresh agency positions");
	assert.equal(ctx.raw.injectedTripUpdates.length, 0, "do not overwrite fresh agency predictions");
	officialPositions = [];
	officialUpdates = [];
	await plugin.beforeRealtime(ctx);
	const revision = api.getRevision();
	fail = true;
	Date.now = () => now + 180_001;
	assert.equal(getVehiclePositions(ctx).length, 0, "expired positions disappear even before a refresh");
	assert.equal(api.getTripObservation("rail", "trip", "20261003"), null);
	assert.notEqual(api.getRevision(), revision, "projection caches invalidate at observation expiry");
	await assert.rejects(plugin.beforeRealtime(ctx), /supplemental sources failed/);
	assert.equal(ctx.raw.injectedTripUpdates.length, 0);
	assert.equal(ctx.raw.injectedVehiclePositions.length, 0);

	// A 24:xx GTFS trip belongs to the previous operating date.
	const nightNow = Date.parse("2026-10-04T00:10:00Z");
	Date.now = () => nightNow;
	fail = false;
	vehicle.observedAt = nightNow;
	vehicle.crowding = null;
	vehicle.tripIds = ["trip", "inactive-trip", "trip"];
	ctx.raw.tripStopTimeBoundsByKey.set(entityKey({ feedId: "rail", localId: "trip" }), {
		start_time: 86_100,
		end_time: 88_200,
	});
	ctx.raw.tripsByKey.set(entityKey({ feedId: "rail", localId: "inactive-trip" }), {
		feed_id: "rail",
		trip_id: "inactive-trip",
		route_id: "R",
		service_id: "daily",
	});
	ctx.raw.tripStopTimeBoundsByKey.set(entityKey({ feedId: "rail", localId: "inactive-trip" }), {
		start_time: 35_000,
		end_time: 38_000,
	});
	await plugin.beforeRealtime(ctx);
	assert.equal(ctx.raw.injectedVehiclePositions[0].trip.start_date, "20261003");
	assert.equal(
		ctx.raw.injectedVehiclePositions[0].trip.trip_id,
		"trip",
		"inactive assigned IDs and duplicate aliases do not hide the operating trip",
	);
	ctx.raw.tripStopTimeBoundsByKey.set(entityKey({ feedId: "rail", localId: "inactive-trip" }), {
		start_time: 86_100,
		end_time: 88_200,
	});
	await plugin.beforeRealtime(ctx);
	assert.equal(ctx.raw.injectedVehiclePositions.length, 0, "two operating assigned trips remain ambiguous");
	vehicle.tripIds = ["trip"];
	ctx.raw.frequenciesByTripKey.set(entityKey({ feedId: "rail", localId: "trip" }), [{ headway_secs: 600 }]);
	await plugin.beforeRealtime(ctx);
	assert.equal(ctx.raw.injectedVehiclePositions.length, 0, "frequency templates need an instance start time");
	console.log("Transit provider tests passed");
} finally {
	Date.now = originalNow;
}
