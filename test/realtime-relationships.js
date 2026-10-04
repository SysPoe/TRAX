import assert from "node:assert/strict";
import { test } from "node:test";
import { GTFS, TripScheduleRelationship as T } from "qdf-gtfs";
import { createEmptyRawCache, createEmptyAugmentedCache, createRuntimeState } from "../dist/cache/factories.js";
import {
	getAugmentedStops,
	getAugmentedTripInstance,
	getTripIdsByServiceDate,
} from "../dist/cache/augmentedEntities.js";
import { refreshRealtimeCache, refreshStaticCache } from "../dist/cache/refreshCaches.js";
import { getDeparturesForStop } from "../dist/utils/departures.js";
import { resolveConfig } from "../dist/config.js";
import { entityKey } from "../dist/identity.js";
import { addDaysToServiceDate, getServiceDate, getServiceDayStart } from "../dist/utils/time.js";
import { realtimeFeed, staticZip } from "./fixtures/native-realtime.mjs";

const zone = "Australia/Brisbane";
const date = getServiceDate(new Date(), zone);
const tomorrow = addDaysToServiceDate(date, 1);
const key = (id = "t", feedId = "f") => entityKey({ feedId, localId: id });
const tripUpdate = (relationship, options = {}) => ({ date, relationship, ...options });
const calls = (serviceDate = date, offset = 0) =>
	["a", "c"].map((stopId, index) => ({
		stopId,
		sequence: index + 1,
		at: getServiceDayStart(serviceDate, zone) + 21600 + index * 600 + offset,
	}));

async function fixture({ otherFeed = false } = {}) {
	const gtfs = new GTFS({ ansi: false, cache: false, logger() {}, progress() {} });
	const archive = staticZip({
		"agency.txt":
			"agency_id,agency_name,agency_url,agency_timezone\nagency,Rail,https://example.test,Australia/Brisbane\n",
		"routes.txt": "route_id,agency_id,route_short_name,route_long_name,route_type\nr,agency,R,Rail,2\n",
		"stops.txt":
			"stop_id,stop_name,stop_lat,stop_lon\na,Alpha,-27.0,153.0\nb,Bravo,-27.01,153.01\nc,Charlie,-27.02,153.02\n",
		"trips.txt": "route_id,service_id,trip_id\nr,daily,t\nr,daily,frequency\n",
		"stop_times.txt":
			"trip_id,arrival_time,departure_time,stop_id,stop_sequence\nt,06:00:00,06:00:00,a,1\nt,06:05:00,06:05:00,b,2\nt,06:10:00,06:10:00,c,3\nfrequency,00:00:00,00:00:00,a,1\nfrequency,00:10:00,00:10:00,c,2\n",
		"calendar.txt": `service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\ndaily,1,1,1,1,1,1,1,${addDaysToServiceDate(date, -2)},${addDaysToServiceDate(date, 2)}\n`,
		"frequencies.txt": "trip_id,start_time,end_time,headway_secs,exact_times\nfrequency,06:00:00,07:00:00,900,1\n",
	});
	const feedIds = otherFeed ? ["f", "g"] : ["f"];
	await gtfs.loadFromBuffers(
		feedIds.map(() => archive),
		feedIds,
	);
	const config = resolveConfig(
		{
			id: "relationships-test",
			name: "Relationships test",
			modes: ["rail"],
			plugins: [],
			feeds: feedIds.map((id) => ({
				id,
				timeZone: zone,
				staticSource: { url: "https://example.test/static" },
				realtimeSources: [
					{
						id: `${id}-agency`,
						targetFeedId: id,
						kind: "trip-updates",
						source: { url: "https://example.test/rt" },
					},
				],
			})),
		},
		{ logFunction() {}, progressLog() {} },
	);
	for (const feedId of feedIds) config.feedTimeZones.set(feedId, zone);
	const ctx = {
		gtfs,
		config,
		raw: createEmptyRawCache(),
		augmented: createEmptyAugmentedCache(),
		runtimeState: createRuntimeState(),
		pluginState: new Map(),
	};
	Object.assign(ctx, await refreshStaticCache(gtfs, config, ctx));
	return {
		gtfs,
		ctx,
		apply(updates, sourceId = "f-agency", feedId = "f") {
			gtfs.updateRealtime({ kind: "trip-updates", data: realtimeFeed(updates), targetFeedId: feedId, sourceId });
		},
		refresh: () => refreshRealtimeCache(gtfs, ctx.config, ctx),
	};
}

function instances(ctx, tripId = "t", serviceDate = date, feedId = "f") {
	return (
		ctx.augmented.tripsRec
			.get(key(tripId, feedId))
			?.instances.filter((instance) => instance.serviceDate === serviceDate) ?? []
	);
}
function departures(ctx, tripId = "t", serviceDate = date, feedId = "f", stopId = "a") {
	const stop = getAugmentedStops(ctx, { feedId, localId: stopId })[0];
	return getDeparturesForStop(stop, serviceDate, "05:00:00", "08:00:00", ctx).filter(
		(departure) => ctx.augmented.instancesRec.get(departure.instance_id)?.trip_id === tripId,
	);
}

test("native NEW creates a visible realtime-only trip and is removed when its source drops it", async () => {
	const { gtfs, ctx, apply, refresh } = await fixture();
	apply([tripUpdate(8, { tripId: "new-trip", calls: calls() })]);
	assert.equal(gtfs.getRealtimeTripUpdates()[0].trip.schedule_relationship, T.NEW);
	await refresh();
	assert.equal(instances(ctx, "new-trip").length, 1);
	assert.equal(departures(ctx, "new-trip").length, 1);
	assert.equal(departures(ctx, "new-trip")[0].realtime, true);
	assert.deepEqual(
		instances(ctx, "new-trip")[0]
			.stopTimes.filter((stop) => !stop.passing)
			.map((stop) => stop.actual_stop_id),
		["a", "c"],
	);
	assert.equal(
		departures(ctx, "new-trip", date, "f", "b").length,
		0,
		"an inferred passing station is not a boarding call",
	);
	Object.assign(ctx, await refreshStaticCache(gtfs, ctx.config, ctx));
	assert.equal(departures(ctx, "new-trip").length, 1, "a static cache rebuild also materializes NEW");
	apply([]);
	await refresh();
	assert.equal(instances(ctx, "new-trip").length, 0);
	assert.equal(departures(ctx, "new-trip").length, 0);
	assert.equal(ctx.raw.tripsByKey.has(key("new-trip")), false);
});

test("native DELETED removes the dated service and warmed board while retaining other dates", async () => {
	const { gtfs, ctx, apply, refresh } = await fixture();
	assert.equal(departures(ctx).length, 1);
	assert.equal(departures(ctx, "t", tomorrow).length, 1);
	const oldInstanceId = instances(ctx)[0].instance_id;
	apply([tripUpdate(7, { startTime: "06:00:00", calls: calls() })]);
	assert.equal(gtfs.getRealtimeTripUpdates()[0].trip.schedule_relationship, T.DELETED);
	await refresh();
	assert.equal(instances(ctx).length, 0);
	assert.equal(departures(ctx).length, 0);
	assert.equal(getTripIdsByServiceDate(ctx, date).includes(key()), false);
	assert.equal(
		getAugmentedTripInstance(ctx, oldInstanceId),
		null,
		"a stale trip URL cannot resurrect the deleted service",
	);
	assert.equal(departures(ctx, "t", tomorrow).length, 1);
	apply([]);
	await refresh();
	assert.equal(departures(ctx).length, 1, "a later full snapshot without the deletion restores the static service");
});

test("timestamp reversals reselect one replacement when producers differ only in optional start_time", async () => {
	const { ctx, apply, refresh } = await fixture();
	apply([tripUpdate(5, { id: "one", calls: calls(date, 60), timestamp: 10 })], "one");
	apply([tripUpdate(5, { id: "two", startTime: "06:00:00", calls: calls(date, 120), timestamp: 20 })], "two");
	await refresh();
	assert.equal(instances(ctx).length, 1);
	assert.equal(instances(ctx)[0].realtime_update.source_id, "two");
	assert.equal(departures(ctx)[0].actual_departure_time, 21720);
	apply([tripUpdate(5, { id: "one", calls: calls(date, 60), timestamp: 30 })], "one");
	await refresh();
	assert.equal(instances(ctx).length, 1);
	assert.equal(instances(ctx)[0].realtime_update.source_id, "one");
	assert.equal(departures(ctx)[0].actual_departure_time, 21660);
});

test("DELETED suppresses another source's scheduled update only in the matching feed and date", async () => {
	const { ctx, apply, refresh } = await fixture({ otherFeed: true });
	apply([
		tripUpdate(0, { calls: calls(), timestamp: 1000 }),
		tripUpdate(0, { date: tomorrow, calls: calls(tomorrow) }),
	]);
	apply([tripUpdate(7)], "delete");
	apply([tripUpdate(0, { calls: calls() })], "g-agency", "g");
	await refresh();
	assert.equal(departures(ctx).length, 0);
	assert.equal(departures(ctx, "t", tomorrow).length, 1);
	assert.equal(departures(ctx, "t", date, "g").length, 1);
});

test("REPLACEMENT owns a nonfrequency service even if another source omits start_time", async () => {
	for (const scheduledStart of [undefined, "06:00:00", "6:00:00"]) {
		const { ctx, apply, refresh } = await fixture();
		apply([tripUpdate(0, { startTime: scheduledStart, calls: calls(), timestamp: 1000 })]);
		apply([tripUpdate(5, { startTime: "06:00:00", calls: calls(date, 120), timestamp: 10 })], "replacement");
		await refresh();
		const dated = instances(ctx);
		assert.equal(dated.length, 1);
		assert.equal(dated[0].schedule_relationship, T.REPLACEMENT);
		assert.deepEqual(
			dated[0].stopTimes.filter((stop) => !stop.passing).map((stop) => stop.actual_stop_id),
			["a", "c"],
		);
		assert.equal(departures(ctx).length, 1);
		assert.equal(
			departures(ctx, "t", date, "f", "b").length,
			0,
			"the replaced static station is not a boarding call",
		);
	}
});

test("REPLACEMENT and DELETED preserve other frequency instances with normalized start_time", async () => {
	const { ctx, apply, refresh } = await fixture();
	apply([
		tripUpdate(0, { tripId: "frequency", startTime: "06:00:00", calls: calls() }),
		tripUpdate(0, { tripId: "frequency", startTime: "06:15:00", calls: calls(date, 900) }),
	]);
	apply([tripUpdate(5, { tripId: "frequency", startTime: "6:00:00", calls: calls(date, 120) })], "replacement");
	await refresh();
	assert.equal(instances(ctx, "frequency").length, 4);
	assert.equal(
		instances(ctx, "frequency").filter((instance) => instance.schedule_relationship === T.REPLACEMENT).length,
		1,
	);
	assert.equal(departures(ctx, "frequency").length, 4);
	apply([tripUpdate(7, { tripId: "frequency", startTime: "6:00:00", calls: calls() })], "replacement");
	await refresh();
	assert.deepEqual(
		instances(ctx, "frequency")
			.map((instance) => instance.frequency_start_time)
			.sort((a, b) => a - b),
		[22500, 23400, 24300],
	);
	assert.equal(departures(ctx, "frequency").length, 3);
	assert.equal(new Set(instances(ctx, "frequency").map((instance) => instance.instance_id)).size, 3);
});

test("a replacement of the static service preserves a separately timed duplicated service", async () => {
	const { ctx, apply, refresh } = await fixture();
	apply([tripUpdate(6, { startTime: "07:00:00", calls: calls(date, 3600) })]);
	apply([tripUpdate(5, { startTime: "06:00:00", calls: calls(date, 120) })], "replacement");
	await refresh();
	assert.deepEqual(
		instances(ctx)
			.map((instance) => instance.schedule_relationship)
			.sort((a, b) => a - b),
		[T.REPLACEMENT, T.DUPLICATED],
	);
	assert.equal(departures(ctx).length, 2);
});
