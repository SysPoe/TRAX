import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { TRAX } from "../dist/index.js";
import { createTfnswRailPlugin } from "../dist/plugins/tfnsw-rail.js";
import { getServiceDate } from "../dist/utils/time.js";
import { staticZip } from "./fixtures/native-realtime.mjs";

const feedId = "nsw-sydney-trains";
const tripId = "123.0.0.A.8.1";
const zone = "Australia/Sydney";
const date = getServiceDate(new Date(), zone);
const deferred = () => Promise.withResolvers();

/** Load a real runtime from a small native feed; supplemental HTTP remains on loopback. */
async function fixture(t, plugins, handleRequest = (_request, response) => response.end("{}")) {
	const archive = staticZip({
		"agency.txt":
			"agency_id,agency_name,agency_url,agency_timezone\nagency,Rail,https://example.test,Australia/Sydney\n",
		"stops.txt": "stop_id,stop_name,stop_lat,stop_lon\nA,Alpha,-33.8,151.0\nB,Bravo,-33.81,151.01\n",
		"routes.txt": "route_id,agency_id,route_short_name,route_long_name,route_type\nr,agency,T1,Rail,2\n",
		"trips.txt": `route_id,service_id,trip_id\nr,daily,${tripId}\n`,
		"stop_times.txt": `trip_id,arrival_time,departure_time,stop_id,stop_sequence\n${tripId},06:00:00,06:00:00,A,1\n${tripId},06:10:00,06:10:00,B,2\n`,
		"calendar.txt": `service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\ndaily,1,1,1,1,1,1,1,${date},${date}\n`,
	});
	const server = createServer((request, response) => {
		if (request.url === "/static") response.end(archive);
		else handleRequest(request, response);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(async () => {
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
	});
	const url = `http://127.0.0.1:${server.address().port}`;
	const cacheDir = await mkdtemp(join(tmpdir(), "trax-plugin-publication-"));
	const network = {
		id: "plugin-publication",
		name: "Plugin publication",
		modes: ["rail"],
		feeds: [feedId, "nsw-trainlink"].map((id) => ({
			id,
			timeZone: zone,
			staticSource: { url: `${url}/static` },
			realtimeSources: [],
		})),
		plugins: typeof plugins === "function" ? plugins(url) : plugins,
	};
	const runtime = new TRAX(network, { cacheDir, disableTimers: true, progressLog() {}, logFunction() {} });
	t.after(() => runtime.clearIntervals());
	await runtime.loadGTFS(false, false);
	const trip = runtime
		.getAugmentedTrips()
		.flatMap((trip) => trip.instances)
		.find(
			(instance) => instance.feed_id === feedId && instance.trip_id === tripId && instance.serviceDate === date,
		);
	assert.ok(trip, "native fixture must expose its dated trip");
	return { runtime, instanceId: trip.instance_id };
}

test(
	"a manual TfNSW occupancy refresh survives an overlapping public realtime publication",
	{ timeout: 10_000 },
	async (t) => {
		const requested = deferred(),
			release = deferred(),
			candidateStarted = deferred();
		let waitingResponse;
		const { runtime, instanceId } = await fixture(
			t,
			(url) => [
				createTfnswRailPlugin({ anyTripOccupancy: { baseUrl: url, requestTimeoutMs: 5_000 } }),
				{
					id: "publication-marker",
					feedIds: [feedId],
					capabilities: [],
					afterRealtime() {
						candidateStarted.resolve();
					},
				},
			],
			(request, response) => {
				assert.equal(request.url, `/tripInstance/${date}/au2%3Ast%3A123/0`);
				waitingResponse = response;
				requested.resolve();
				release.promise.then(() => {
					response.setHeader("content-type", "application/json");
					response.end(
						JSON.stringify({
							header: { timestamp: Math.floor(Date.now() / 1000) },
							response: {
								tripInstance: { trip: { id: `au2:st:${tripId}` }, startDate: date },
								realtimePattern: [{ stopSequence: 1, departure: { occupancy: [1, 2] } }],
							},
						}),
					);
				});
			},
		);
		const api = runtime.getPluginApi("au-nsw-tfnsw-rail");
		assert.ok(api);
		const occupancy = api.refreshTripOccupancy(instanceId);
		await requested.promise;
		const refresh = runtime.refreshRealtime();
		try {
			// An unlocked runtime reaches candidate publication while HTTP is pending.
			// A serialized runtime starts that phase after the occupancy owner completes.
			const phase = await Promise.race([candidateStarted.promise.then(() => "candidate"), delay(30, "pending")]);
			if (phase === "candidate") await refresh;
		} finally {
			release.resolve();
		}
		assert.equal(await occupancy, 1, "the real AnyTrip response must apply one call");
		await refresh;
		assert.ok(waitingResponse);
		const published = runtime.getAugmentedTripInstance(instanceId);
		assert.equal(published.stopTimes[0].occupancy?.source, "anytrip-nsw");
		assert.deepEqual(published.stopTimes[0].occupancy?.statuses, [1, 2]);
	},
);

test(
	"a retained plugin API resolves trip details against the newly published context",
	{ timeout: 10_000 },
	async (t) => {
		let instanceId;
		const plugin = {
			id: "details-fixture",
			feedIds: [feedId],
			capabilities: [],
			afterRealtime(ctx) {
				ctx.augmented.instancesRec.get(instanceId).vehicle_details = { publication: 1 };
			},
			api: (ctx) => ({ getTripDetails: (id) => ctx.augmented.instancesRec.get(id)?.vehicle_details ?? null }),
		};
		const fixtureRuntime = await fixture(t, [plugin]);
		const runtime = fixtureRuntime.runtime;
		instanceId = fixtureRuntime.instanceId;
		const api = runtime.getPluginApi(plugin.id);
		assert.equal(api.getTripDetails(instanceId), null);
		await runtime.refreshRealtime();
		assert.deepEqual(runtime.getPluginApi(plugin.id).getTripDetails(instanceId), { publication: 1 });
		assert.deepEqual(
			api.getTripDetails(instanceId),
			{ publication: 1 },
			"a held API must not retain the previous ctx",
		);
	},
);

test("a queued manual refresh resolves its plugin owner after realtime publication", { timeout: 10_000 }, async (t) => {
	const candidateStarted = deferred(),
		releaseCandidate = deferred();
	t.after(() => releaseCandidate.resolve());
	const { runtime, instanceId } = await fixture(
		t,
		(url) => [
			createTfnswRailPlugin({ anyTripOccupancy: { baseUrl: url, requestTimeoutMs: 5_000 } }),
			{
				id: "publication-barrier",
				feedIds: [feedId],
				capabilities: [],
				async afterRealtime() {
					candidateStarted.resolve();
					await releaseCandidate.promise;
				},
			},
		],
		(_request, response) => {
			response.setHeader("content-type", "application/json");
			response.end(
				JSON.stringify({
					header: { timestamp: Math.floor(Date.now() / 1000) },
					response: {
						tripInstance: { trip: { id: `au2:st:${tripId}` }, startDate: date },
						realtimePattern: [{ stopSequence: 1, departure: { occupancy: [1, 2] } }],
					},
				}),
			);
		},
	);
	const api = runtime.getPluginApi("au-nsw-tfnsw-rail");
	const refresh = runtime.refreshRealtime();
	await candidateStarted.promise;
	const occupancy = api.refreshTripOccupancy(instanceId);
	releaseCandidate.resolve();
	await refresh;
	assert.equal(await occupancy, 1);
	assert.equal(runtime.getAugmentedTripInstance(instanceId).stopTimes[0].occupancy?.source, "anytrip-nsw");
});
