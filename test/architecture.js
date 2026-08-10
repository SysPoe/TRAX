import assert from "node:assert/strict";
import http from "node:http";
import TRAX, {
	NetworkRuntimeRegistry,
	decodeTripInstanceId,
	encodePublicEntityId,
	decodePublicEntityId,
} from "../dist/index.js";

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
	const localParts = [], centralParts = [];
	let localOffset = 0;
	for (const [filename, contents] of Object.entries(files)) {
		const name = Buffer.from(filename), body = Buffer.from(contents), checksum = crc32(body);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(checksum, 14);
		local.writeUInt32LE(body.length, 18); local.writeUInt32LE(body.length, 22); local.writeUInt16LE(name.length, 26);
		localParts.push(local, name, body);
		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
		central.writeUInt32LE(checksum, 16); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(body.length, 24);
		central.writeUInt16LE(name.length, 28); central.writeUInt32LE(localOffset, 42); centralParts.push(central, name);
		localOffset += local.length + name.length + body.length;
	}
	const directory = Buffer.concat(centralParts), end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
	end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(localOffset, 16);
	return Buffer.concat([...localParts, directory, end]);
}

function feed(name, timezone) {
	return createZip({
		"agency.txt": `agency_id,agency_name,agency_url,agency_timezone\nagency,${name},https://example.test,${timezone}\n`,
		"routes.txt": "route_id,agency_id,route_short_name,route_long_name,route_type\nshared,agency,R,Shared Rail,2\n",
		"stops.txt": `stop_id,stop_name,stop_lat,stop_lon\nshared,${name} Station,-27.4,153.0\nend,${name} End,-27.5,153.1\n`,
		"trips.txt": "route_id,service_id,trip_id,trip_headsign,direction_id,shape_id\nshared,shared,shared,End,0,shared\n",
		"stop_times.txt": "trip_id,arrival_time,departure_time,stop_id,stop_sequence\nshared,25:30:00,25:30:00,shared,1\nshared,26:00:00,26:00:00,end,2\n",
		"calendar.txt": "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nshared,1,1,1,1,1,1,1,20260101,20261231\n",
		"shapes.txt": "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\nshared,-27.4,153.0,1\nshared,-27.5,153.1,2\n",
	});
}

const feeds = { "/a.zip": feed("Alpha", "Australia/Brisbane"), "/b.zip": feed("Beta", "America/Toronto") };
const server = http.createServer((request, response) => {
	const body = feeds[request.url];
	if (!body) { response.writeHead(404).end(); return; }
	response.writeHead(200, { "content-type": "application/zip" }); response.end(body);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

try {
	const definition = {
		id: "synthetic", name: "Synthetic multi-feed", modes: ["rail"], plugins: [],
		feeds: [
			{ id: "alpha", staticSource: { url: `${origin}/a.zip` }, realtimeSources: [] },
			{ id: "beta", staticSource: { url: `${origin}/b.zip` }, realtimeSources: [] },
		],
	};
	const runtime = new TRAX(definition, { cacheDir: ".TRAXCACHE/test-synthetic" });
	await runtime.loadGTFS(false, false);
	assert.equal(runtime.getRawTrips({ trip_id: "shared" }).length, 2);
	assert.equal(runtime.getAugmentedStops({ feedId: "alpha", localId: "shared" })[0].stop_name, "Alpha Station");
	assert.equal(runtime.getAugmentedStops({ feedId: "beta", localId: "shared" })[0].stop_name, "Beta Station");
	const alphaTrip = runtime.getAugmentedTrips({ feedId: "alpha", localId: "shared" })[0];
	const betaTrip = runtime.getAugmentedTrips({ feedId: "beta", localId: "shared" })[0];
	assert.ok(alphaTrip && betaTrip);
	assert.notEqual(alphaTrip.instances[0].instance_id, betaTrip.instances[0].instance_id);
	assert.equal(decodeTripInstanceId(alphaTrip.instances[0].instance_id).feedId, "alpha");
	assert.equal(alphaTrip.instances[0].stopTimes[0].scheduled_departure_time, 91_800);
	assert.equal(runtime.metadata.feeds.find((value) => value.id === "beta").timeZone, "America/Toronto");

	const publicId = encodePublicEntityId({ networkId: "synthetic", feedId: "alpha", kind: "station", localId: "shared" });
	assert.deepEqual(decodePublicEntityId(publicId), { networkId: "synthetic", feedId: "alpha", kind: "station", localId: "shared" });

	const registry = new NetworkRuntimeRegistry();
	const other = registry.register({ ...definition, id: "other", feeds: [definition.feeds[0]] }, { cacheDir: ".TRAXCACHE/test-other" });
	await other.loadGTFS(false, false);
	assert.equal(other.getRawTrips().length, 1);
	assert.equal(runtime.getRawTrips().length, 2);
	assert.notEqual(other.getAugmentedTrips({ feedId: "alpha", localId: "shared" })[0].instances[0].instance_id, alphaTrip.instances[0].instance_id);

	const winter = runtime.utils.time.parseTimeWithConfig("2026-01-15T12:00:00", "America/Toronto");
	const summer = runtime.utils.time.parseTimeWithConfig("2026-07-15T12:00:00", "America/Toronto");
	assert.equal(new Date(winter).toISOString(), "2026-01-15T17:00:00.000Z");
	assert.equal(new Date(summer).toISOString(), "2026-07-15T16:00:00.000Z");
	assert.equal(runtime.utils.time.serviceTimeToInstant("20260805", 91_800, "Australia/Brisbane"), "2026-08-05T15:30:00.000Z");
	runtime.clearIntervals(); other.clearIntervals();
	console.log("Architecture tests passed.");
} finally {
	server.close();
}
