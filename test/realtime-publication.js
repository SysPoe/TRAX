import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { context, update, key, date } from "./fixtures/runtime-audit.mjs";
import { augmentTrip } from "../dist/utils/augmentedTrip.js";
import { registerAugmentedTrip, getStopDeparturesCached } from "../dist/cache/augmentedEntities.js";
import { refreshRealtimeCache, refreshStaticCache, StaleGenerationError } from "../dist/cache/refreshCaches.js";
import { TRAX } from "../dist/index.js";
import { GTFS } from "qdf-gtfs";
import { loadRealtime, replayRetainedRealtime } from "../dist/gtfsInterfaceLayer.js";
import { createRealtimeReadView } from "../dist/cache/snapshot.js";
import { staticZip } from "./fixtures/native-realtime.mjs";
import { addDaysToServiceDate, getServiceDate } from "../dist/utils/time.js";
import { YieldBudget } from "../dist/utils/cooperative.js";

function fixture() {
	const { ctx, gtfs, trip } = context();
	let realtime = [update([{ stop_sequence: 1, stop_id: "A", departure_delay: 30 }])];
	gtfs.getRealtimeTripUpdates = () => realtime;
	gtfs.getRealtimeVehiclePositions = () => [];
	gtfs.getRealtimeAlerts = () => [];
	const augmented = augmentTrip(trip, ctx, new Map([[key, realtime]]), undefined, { serviceDates: [date] });
	ctx.augmented.tripsRec.set(key, augmented);
	ctx.augmented.trips = [augmented];
	ctx.augmented.tripArrayIndex.set(key, 0);
	ctx.augmented.tripUpdatesCache.set(key, realtime);
	registerAugmentedTrip(ctx, augmented);
	const runtime = new TRAX(ctx.config.network, { disableTimers: true, logFunction: () => {}, progressLog: () => {} });
	runtime.gtfs = gtfs;
	runtime.config = ctx.config;
	runtime.ctx = ctx;
	return {
		ctx,
		gtfs,
		runtime,
		setUpdates: (value) => (realtime = value),
		instanceId: augmented.instances[0].instance_id,
	};
}

test("public readers keep the old trip, indexes, and plugin state until every realtime hook completes", async () => {
	const { ctx, gtfs, runtime, setUpdates, instanceId } = fixture();
	ctx.pluginState.set("publication-fixture", { state: "old" });
	let release;
	const barrier = new Promise((resolve) => (release = resolve));
	let entered;
	const waiting = new Promise((resolve) => (entered = resolve));
	ctx.config.network.plugins.push({
		id: "publication-fixture",
		feedIds: ["rail"],
		capabilities: [],
		async afterRealtime(candidate) {
			candidate.pluginState.get("publication-fixture").state = "new";
			candidate.augmented.instancesRec.get(instanceId).vehicle_model = "fixture-new";
			entered();
			await barrier;
		},
	});
	setUpdates([update([{ stop_sequence: 1, stop_id: "A", departure_delay: 90 }])]);
	const refresh = refreshRealtimeCache(gtfs, ctx.config, ctx);
	await waiting;
	try {
		assert.equal(runtime.getAugmentedTripInstance(instanceId).stopTimes[0].actual_departure_time, 36030);
		assert.equal(runtime.getAugmentedTripInstance(instanceId).vehicle_model, null);
		assert.equal(ctx.pluginState.get("publication-fixture").state, "old");
	} finally {
		release();
		await refresh;
	}
	assert.equal(runtime.getAugmentedTripInstance(instanceId).stopTimes[0].actual_departure_time, 36090);
	assert.equal(runtime.getAugmentedTripInstance(instanceId).vehicle_model, "fixture-new");
	assert.equal(ctx.pluginState.get("publication-fixture").state, "new");
});

test("failed or superseded realtime work retains the complete last published snapshot", async () => {
	for (const stale of [false, true]) {
		const { ctx, gtfs, runtime, setUpdates, instanceId } = fixture();
		ctx.config.network.plugins.push({
			id: "failed-fixture",
			feedIds: ["rail"],
			capabilities: [],
			afterRealtime(candidate) {
				candidate.augmented.instancesRec.get(instanceId).vehicle_model = "discarded";
				throw stale ? new StaleGenerationError() : new Error("fixture hook failed");
			},
		});
		setUpdates([update([{ stop_sequence: 1, stop_id: "A", departure_delay: 90 }])]);
		await assert.rejects(refreshRealtimeCache(gtfs, ctx.config, ctx));
		assert.equal(runtime.getAugmentedTripInstance(instanceId).stopTimes[0].actual_departure_time, 36030);
		assert.equal(runtime.getAugmentedTripInstance(instanceId).vehicle_model, null);
	}
});

test("attached departure helpers follow the runtime's current publication", async () => {
	const { ctx, gtfs, runtime, setUpdates } = fixture();
	const stop = runtime.getAugmentedStops({ feedId: "rail", localId: "A" })[0];
	runtime.utils.departures.attachDeparturesHelpers(stop);
	assert.equal(stop._getSDDepartures(date, 0, 86400)[0].actual_departure_time, 36030);
	setUpdates([update([{ stop_sequence: 1, stop_id: "A", departure_delay: 90 }])]);
	await refreshRealtimeCache(gtfs, ctx.config, ctx, {
		publish: (candidate) => {
			runtime.ctx = candidate;
			runtime.gtfs = candidate.gtfs;
		},
	});
	assert.equal(stop._getSDDepartures(date, 0, 86400)[0].actual_departure_time, 36090);
	assert.deepEqual(
		stop._getSDDepartures(date, 0, 86400)[0],
		runtime.utils.departures.getServiceDateDeparturesForStop(stop, date, 0, 86400)[0],
	);
});

const variable = (value) => {
	let n = BigInt(value);
	const bytes = [];
	do {
		let byte = Number(n & 127n);
		n >>= 7n;
		if (n) byte |= 128;
		bytes.push(byte);
	} while (n);
	return Buffer.from(bytes);
};
const number = (field, value) => Buffer.concat([variable(field << 3), variable(value)]);
const bytes = (field, value) => {
	const data = typeof value === "string" ? Buffer.from(value) : value;
	return Buffer.concat([variable((field << 3) | 2), variable(data.length), data]);
};
const message = (...fields) => Buffer.concat(fields);

test("native realtime reads and static publication retain predictions while reacquisition is unavailable", async () => {
	const cacheDir = await mkdtemp(join(tmpdir(), "trax-publication-"));
	const staticData = staticZip({
		"agency.txt": "agency_id,agency_name,agency_url,agency_timezone\na,Fixture,https://example.test,UTC\n",
		"stops.txt": "stop_id,stop_name,stop_lat,stop_lon\nA,A,0,0\nB,B,0,0.1\n",
		"routes.txt": "route_id,agency_id,route_short_name,route_long_name,route_type\nR,a,R,Rail,2\n",
		"calendar.txt": `service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\ndaily,1,1,1,1,1,1,1,${date},${date}\n`,
		"trips.txt": "route_id,service_id,trip_id,trip_headsign\nR,daily,trip,Terminal\n",
		"stop_times.txt":
			"trip_id,arrival_time,departure_time,stop_id,stop_sequence\ntrip,10:00:00,10:00:00,A,1\ntrip,10:10:00,10:10:00,B,2\n",
	});
	const timestamp = 1791018000;
	const payload = (delay) =>
		message(
			bytes(1, message(bytes(1, "2.0"), number(3, timestamp))),
			bytes(
				2,
				message(
					bytes(1, "fixture-trip"),
					bytes(
						3,
						message(
							bytes(
								1,
								message(
									bytes(1, "trip"),
									bytes(2, "10:00:00"),
									bytes(3, date),
									number(4, 0),
									bytes(5, "R"),
								),
							),
							bytes(2, message(number(1, 1), bytes(3, message(number(1, delay))), bytes(4, "A"))),
							number(4, timestamp),
						),
					),
				),
			),
		);
	let currentPayload = payload(30),
		failed = false;
	const server = createServer((request, response) => {
		if (request.url === "/static") response.end(staticData);
		else if (failed) {
			response.writeHead(503);
			response.end();
		} else response.end(currentPayload);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const url = `http://127.0.0.1:${server.address().port}`;
	const network = {
		id: "native-publication",
		name: "Fixture",
		feeds: [
			{
				id: "rail",
				timeZone: "UTC",
				staticSource: { url: `${url}/static` },
				realtimeSources: [
					{ id: "fixture-rt", targetFeedId: "rail", kind: "trip-updates", source: { url: `${url}/rt` } },
				],
			},
		],
		modes: ["rail"],
		plugins: [],
	};
	const runtime = new TRAX(network, { cacheDir, disableTimers: true, progressLog: () => {}, logFunction: () => {} });
	try {
		await runtime.loadGTFS(true, false);
		const realtimeTrip = () =>
			runtime
				.getAugmentedTrips()
				.flatMap((trip) => trip.instances)
				.find((instance) => instance.realtime_update);
		assert.equal(realtimeTrip().stopTimes[0].actual_departure_time, 36030);
		const publishedObservation = runtime.getRealtimeObservationTime({ source_id: "fixture-rt", timestamp: null });
		let entered, release;
		const waiting = new Promise((resolve) => (entered = resolve)),
			barrier = new Promise((resolve) => (release = resolve));
		network.plugins.push({
			id: "native-barrier",
			feedIds: ["rail"],
			capabilities: [],
			async afterRealtime() {
				entered();
				await barrier;
			},
		});
		currentPayload = payload(90);
		const refresh = runtime.refreshRealtime();
		await waiting;
		try {
			assert.equal(runtime.gtfs.getRealtimeTripUpdates()[0].stop_time_updates[0].departure_delay, 30);
			assert.equal(runtime.getTripUpdates()[0].stop_time_updates[0].departure_delay, 30);
			assert.equal(realtimeTrip().stopTimes[0].actual_departure_time, 36030);
			assert.equal(
				runtime.getRealtimeObservationTime({ source_id: "fixture-rt", timestamp: null }),
				publishedObservation,
			);
			assert.equal(
				runtime.getSourceHealth().find((source) => source.id === "fixture-rt").lastSuccessAt,
				publishedObservation,
			);
		} finally {
			release();
			await refresh;
		}
		assert.equal(runtime.gtfs.getRealtimeTripUpdates()[0].stop_time_updates[0].departure_delay, 90);
		assert.equal(realtimeTrip().stopTimes[0].actual_departure_time, 36090);
		network.plugins.length = 0;
		failed = true;
		await runtime.refreshStatic();
		assert.equal(runtime.gtfs.getRealtimeTripUpdates()[0].timestamp, timestamp);
		assert.equal(realtimeTrip().stopTimes[0].actual_departure_time, 36090);
		await runtime.refreshRealtime();
		assert.equal(realtimeTrip().stopTimes[0].actual_departure_time, 36090);
		await runtime.refreshStatic();
		assert.equal(realtimeTrip().stopTimes[0].actual_departure_time, 36090);
	} finally {
		runtime.clearIntervals();
		await new Promise((resolve) => server.close(resolve));
	}
});

function nativeTripPayload(entities, differential = false) {
	return message(
		bytes(1, message(bytes(1, "2.0"), number(2, differential ? 1 : 0), number(3, 100))),
		...entities.map(({ id, delay = 30, deleted = false }) =>
			bytes(
				2,
				message(
					bytes(1, id),
					...(deleted
						? [number(2, 1)]
						: [
								bytes(
									3,
									message(
										bytes(1, message(bytes(1, id), bytes(3, date), number(4, 0), bytes(5, "R"))),
										bytes(
											2,
											message(number(1, 1), bytes(3, message(number(1, delay))), bytes(4, "A")),
										),
										number(4, 100),
									),
								),
							]),
				),
			),
		),
	);
}

test("static replay materializes differential changes, deletions, and later full replacements without retaining history", async () => {
	const source = new GTFS({ cache: false }),
		target = new GTFS({ cache: false });
	const { ctx } = context();
	let current = nativeTripPayload([{ id: "kept" }, { id: "changed" }]);
	const server = createServer((_request, response) => response.end(current));
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	ctx.config.network.feeds[0].realtimeSources[0].source.url = `http://127.0.0.1:${server.address().port}`;
	try {
		await loadRealtime(source, ctx.config);
		current = nativeTripPayload([{ id: "changed", delay: 90 }], true);
		await loadRealtime(source, ctx.config);
		replayRetainedRealtime(source, target);
		assert.deepEqual(target.getRealtimeTripUpdates(), source.getRealtimeTripUpdates());
		current = nativeTripPayload([{ id: "changed", deleted: true }], true);
		await loadRealtime(source, ctx.config);
		replayRetainedRealtime(source, target);
		assert.deepEqual(target.getRealtimeTripUpdates(), source.getRealtimeTripUpdates());
		assert.deepEqual(
			target.getRealtimeTripUpdates().map((value) => value.trip.trip_id),
			["kept"],
		);
		current = nativeTripPayload([{ id: "fresh-full" }]);
		await loadRealtime(source, ctx.config);
		replayRetainedRealtime(source, target);
		assert.deepEqual(target.getRealtimeTripUpdates(), source.getRealtimeTripUpdates());
		assert.deepEqual(
			target.getRealtimeTripUpdates().map((value) => value.trip.trip_id),
			["fresh-full"],
		);
	} finally {
		await new Promise((resolve) => server.close(resolve));
		source.clearStatic();
		target.clearStatic();
	}
});

test("published native trip, vehicle, and alert filters match the native getter contract", () => {
	const native = new GTFS({ cache: false });
	native.updateRealtime({
		kind: "trip-updates",
		targetFeedId: "rail",
		sourceId: "trips",
		data: nativeTripPayload([{ id: "first" }, { id: "second" }]),
	});
	const trip = message(bytes(1, "first"), bytes(5, "R"));
	const vehicle = message(bytes(1, trip), bytes(7, "A"), bytes(8, message(bytes(1, "vehicle"))));
	const alert = message(number(6, 1), bytes(10, bytes(1, bytes(1, "Fixture alert"))));
	const feed = (field, body) =>
		message(bytes(1, bytes(1, "2.0")), bytes(2, message(bytes(1, "entity"), bytes(field, body))));
	native.updateRealtime({ kind: "vehicles", targetFeedId: "rail", sourceId: "vehicles", data: feed(4, vehicle) });
	native.updateRealtime({ kind: "alerts", targetFeedId: "rail", sourceId: "alerts", data: feed(5, alert) });
	const view = createRealtimeReadView(native);
	try {
		for (const getter of ["getRealtimeTripUpdates", "getRealtimeVehiclePositions", "getRealtimeAlerts"]) {
			assert.ok(native[getter]().length, `${getter} fixture must contain real native data`);
			for (const filter of [
				{},
				{ feed_id: "rail" },
				{ feed_id: "other" },
				{ feed_id: "" },
				{ source_id: "trips" },
				{ source_id: "" },
				{ trip_id: "first" },
				{ trip_id: "" },
				{ route_id: "R" },
				{ route_id: "" },
				{ vehicle_id: "vehicle" },
				{ vehicle_id: "" },
				{ stop_id: "A" },
				{ stop_id: "" },
				{ trip_id: "first", feed_id: "other" },
			]) {
				assert.deepEqual(
					view[getter](filter),
					native[getter](filter),
					`${getter} filter ${JSON.stringify(filter)}`,
				);
			}
			const before = native[getter]();
			const returned = view[getter]();
			returned[0].update_id = "caller-mutation";
			if (returned[0].trip) returned[0].trip.trip_id = "caller-mutated-trip";
			if (returned[0].vehicle) returned[0].vehicle.id = "caller-mutated-vehicle";
			assert.deepEqual(view[getter](), before, `${getter} callers receive detached entity values`);
		}
	} finally {
		native.clearStatic();
	}
});

test("snapshot copying yields inside one large frequency trip", async () => {
	const { ctx } = context();
	ctx.augmented.trips = [
		{
			trip_id: "frequency",
			feed_id: "rail",
			instances: Array.from({ length: 1000 }, (_, index) => ({
				instance_id: `frequency-${index}`,
				stopTimes: Array.from({ length: 20 }, (_, stop) => ({
					actual_departure_time: 36000 + stop * 10,
					realtime_info: { timestamp: 100, source_id: "agency" },
				})),
			})),
		},
	];
	const { forkRealtimeContext } = await import("../dist/cache/snapshot.js");
	const originalNow = Date.now;
	let clock = originalNow(),
		running = true,
		turns = 0;
	Date.now = () => (clock += 10);
	const heartbeat = () => {
		turns++;
		if (running) setImmediate(heartbeat);
	};
	setImmediate(heartbeat);
	try {
		const candidate = await forkRealtimeContext(ctx);
		assert.equal(candidate.augmented.trips[0].instances.length, 1000);
		assert.equal(candidate.augmented.trips[0].instances[0].stopTimes[0].actual_departure_time, 36000);
		assert.ok(turns > 100, "one nested trip must yield while copying its instances and stop calls");
		candidate.augmented.trips[0].instances[0].stopTimes[0].actual_departure_time = 36100;
		assert.equal(ctx.augmented.trips[0].instances[0].stopTimes[0].actual_departure_time, 36000);
	} finally {
		running = false;
		Date.now = originalNow;
	}
});

test("snapshot copying retains coherent native lazy dates when public queries materialize or evict during a yield", async () => {
	const { forkRealtimeContext } = await import("../dist/cache/snapshot.js");
	for (const preload of [0, 8]) {
		const { ctx } = context();
		const gtfs = new GTFS({ cache: false, logger() {}, progress() {} });
		const today = getServiceDate(new Date(), "UTC");
		const lazyDate = addDaysToServiceDate(today, 5 + preload);
		await gtfs.loadFromBuffers(
			[
				staticZip({
					"agency.txt":
						"agency_id,agency_name,agency_url,agency_timezone\na,Fixture,https://example.test,UTC\n",
					"stops.txt": "stop_id,stop_name,stop_lat,stop_lon\nA,A,0,0\nB,B,0,0.1\n",
					"routes.txt": "route_id,agency_id,route_short_name,route_long_name,route_type\nR,a,R,Rail,2\n",
					"calendar.txt": `service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\ndaily,1,1,1,1,1,1,1,${addDaysToServiceDate(today, -2)},${addDaysToServiceDate(today, 20)}\n`,
					"trips.txt": "route_id,service_id,trip_id\nR,daily,trip\n",
					"stop_times.txt":
						"trip_id,arrival_time,departure_time,stop_id,stop_sequence\ntrip,10:00:00,10:00:00,A,1\ntrip,10:10:00,10:10:00,B,2\n",
				}),
			],
			["rail"],
		);
		ctx.gtfs = gtfs;
		Object.assign(ctx, await refreshStaticCache(gtfs, ctx.config, ctx));
		const oldestDate = addDaysToServiceDate(today, 5);
		for (let offset = 0; offset < preload; offset++) {
			assert.equal(
				getStopDeparturesCached(ctx, { feedId: "rail", localId: "A" }, addDaysToServiceDate(oldestDate, offset))
					.length,
				1,
			);
		}
		let copiedTrips = false,
			interleaved = false;
		const entries = ctx.augmented.tripsRec.entries.bind(ctx.augmented.tripsRec);
		ctx.augmented.tripsRec.entries = function* () {
			yield* entries();
			copiedTrips = true;
		};
		const originalYield = YieldBudget.prototype.maybeYield;
		YieldBudget.prototype.maybeYield = async function () {
			if (copiedTrips && !interleaved) {
				interleaved = true;
				assert.equal(getStopDeparturesCached(ctx, { feedId: "rail", localId: "A" }, lazyDate).length, 1);
			}
			await originalYield.call(this);
		};
		try {
			const candidate = await forkRealtimeContext(ctx);
			assert.ok(interleaved, "the public query must run after the old trip graph was copied");
			assert.equal(candidate.runtimeState.lazyServiceDates.get(lazyDate), true);
			const instance = candidate.augmented.tripsRec
				.get(key)
				.instances.find((value) => value.serviceDate === lazyDate);
			assert.ok(instance, "a complete lazy-date marker must have its trip instance");
			assert.equal(candidate.augmented.instancesRec.get(instance.instance_id), instance);
			for (const stopId of ["A", "B", "B"]) {
				assert.equal(
					getStopDeparturesCached(candidate, { feedId: "rail", localId: stopId }, lazyDate).length,
					1,
					`${stopId} must resolve the new date, including uncached and repeated reads`,
				);
			}
			if (preload) {
				assert.equal(candidate.runtimeState.lazyServiceDates.has(oldestDate), false);
				assert.equal(
					candidate.augmented.tripsRec.get(key).instances.some((value) => value.serviceDate === oldestDate),
					false,
					"eviction must remove the same date from trip instances and lazy markers",
				);
				assert.equal(
					[...candidate.augmented.instancesRec.values()].some((value) => value.serviceDate === oldestDate),
					false,
				);
			}
		} finally {
			YieldBudget.prototype.maybeYield = originalYield;
			gtfs.clearStatic();
		}
	}
});

test("a failed QRT request clears the inherited in-flight owner after publication", async () => {
	const { ctx } = context();
	ctx.config.network.plugins.push({ id: "au-seq", feedIds: ["rail"], capabilities: ["supplemental-realtime"] });
	const { refreshQRTTrainsInBackground } = await import("../dist/cache/refreshCaches.js");
	const { forkRealtimeContext } = await import("../dist/cache/snapshot.js");
	const originalFetch = globalThis.fetch,
		originalSet = globalThis.setTimeout;
	let calls = 0;
	let release;
	const barrier = new Promise((resolve) => (release = resolve));
	try {
		globalThis.fetch = async () => {
			calls++;
			await barrier;
			throw new Error("QRT fixture offline");
		};
		globalThis.setTimeout = (callback) => {
			queueMicrotask(callback);
			return { unref() {} };
		};
		refreshQRTTrainsInBackground(ctx);
		const candidate = await forkRealtimeContext(ctx);
		ctx.publicationOwner.current = candidate;
		const pending = candidate.augmented.qrtRefreshInFlight;
		assert.ok(pending);
		release();
		await pending;
		assert.equal(candidate.augmented.qrtRefreshInFlight, undefined);
		const previousCalls = calls;
		refreshQRTTrainsInBackground(candidate);
		await candidate.augmented.qrtRefreshInFlight;
		assert.ok(calls > previousCalls, "a failed request must allow the next QRT refresh");
	} finally {
		release();
		globalThis.fetch = originalFetch;
		globalThis.setTimeout = originalSet;
	}
});
