import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import TRAX, { AU_SEQ_NETWORK, getMtpDataset, MTP_FEED_ID, encodeTripInstanceId } from "../dist/index.js";

const data = getMtpDataset();
assert.equal(data.plans.length, 140);
assert.equal(new Set(data.plans.map((p) => p.id)).size, 140);
assert.ok(data.services.length > 2000);
assert.ok(data.plans.every((p) => /^[a-f0-9]{64}$/.test(p.sha256) && /^[a-f0-9]{64}$/.test(p.reviewSha256)));
const standalone = {
	...AU_SEQ_NETWORK,
	id: "mtp-test",
	feeds: AU_SEQ_NETWORK.feeds.filter((f) => f.id === MTP_FEED_ID),
	plugins: AU_SEQ_NETWORK.plugins.filter((p) => p.id === MTP_FEED_ID),
	places: [],
	corridor: { enabled: false },
};
const cacheDir = await mkdtemp(path.join(tmpdir(), "mtp-trax-test-"));
const runtime = new TRAX(standalone, { cacheDir, disableTimers: true, logFunction() {}, progressLog() {} });
await runtime.loadGTFS(false);
assert.equal(runtime.getRawTrips().length, data.services.length);
assert.equal(runtime.getSourceHealth().find((s) => s.feedId === MTP_FEED_ID)?.transport, "local");
let checked = 0;
for (const service of data.services) {
	assert.ok(
		service.calls.every((c, i) => c.departure >= c.arrival && (!i || c.arrival >= service.calls[i - 1].departure)),
	);
	let date = new Date(service.calendarStartDate);
	while (!service.days.includes((date.getUTCDay() + 6) % 7)) date = new Date(date.getTime() + 86400000);
	const serviceDate = date.toISOString().slice(0, 10).replaceAll("-", "");
	const instanceId = encodeTripInstanceId({
		networkId: "mtp-test",
		feedId: MTP_FEED_ID,
		kind: "trip",
		localId: service.id,
		serviceDate,
		realtimeStartTime: "",
	});
	const trip = runtime.getAugmentedTripInstance(instanceId);
	assert.ok(trip, `${service.runNumber} must materialize on its actual weekday`);
	assert.equal(trip.trip_number, service.runNumber);
	assert.equal(trip.nonRevenue, true);
	assert.equal(trip.plannedService?.status, "review");
	assert.equal(trip.stopTimes.length, service.calls.length);
	assert.ok(trip.stopTimes.every((c) => c.pickup_type === 1 && c.drop_off_type === 1 && !c.realtime));
	for (let i = 0; i < service.calls.length; i++) {
		const call = service.calls[i],
			stop = trip.stopTimes[i];
		assert.equal(stop.scheduled_arrival_time, call.arrival);
		assert.equal(stop.scheduled_arrival_date_offset, Math.floor(call.arrival / 86400));
		assert.equal(stop.scheduled_departure_time, call.departure);
	}
	checked++;
}
for (const [run, station, arrival, departure] of [
	["82P9", "GLT", 21 * 3600 + 25 * 60, 21 * 3600 + 55 * 60],
	["QJ12", "BDB", 22 * 3600 + 25 * 60, 22 * 3600 + 25 * 60],
]) {
	const ids = new Set(data.stations.filter((s) => s.code === station).map((s) => s.id));
	assert.ok(
		data.services.some(
			(s) =>
				s.runNumber === run &&
				s.calls.some((c) => ids.has(c.stationId) && c.arrival === arrival && c.departure === departure),
		),
		`Screenshot regression ${run} ${station}`,
	);
}
// Only directly adjacent, source-confirmed chart rows can add physical edges.
const plugin = standalone.plugins[0];
assert.equal(plugin.considerTopologyTrip({}, {}), false);
const matrix = {},
	adjacency = {};
plugin.enrichTrackGraph(matrix, adjacency, { config: runtime.config });
assert.ok(Object.keys(adjacency).length > 100);
for (const [from, neighbors] of Object.entries(adjacency))
	for (const to of neighbors) {
		assert.ok(adjacency[to].includes(from));
		assert.ok(matrix[from][to] > 0);
	}
const unknown = data.stations.find((s) => s.latitude === null);
assert.equal(runtime.getRawStops({ feed_id: MTP_FEED_ID, stop_id: unknown.id })[0].stop_lat, null);
console.log(
	`MTP corpus passed: ${checked} dated services, ${data.metrics.timingPoints} timing points, ${data.graphEdges.length} graph edges`,
);
