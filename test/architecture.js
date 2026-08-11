import assert from "node:assert/strict";
import http from "node:http";
import TRAX, {
	NetworkRuntimeRegistry,
	createCaGthaNetwork,
	decodeTripInstanceId,
	encodePublicEntityId,
	decodePublicEntityId,
} from "../dist/index.js";
import {
	buildCisBoardingAssignments,
	collectCisStationCandidates,
	parseCisStationBoard,
	viaTrainKey,
} from "../dist/region-specific/CA/VIA/station-board.js";

const gthaWithFallbacks = createCaGthaNetwork(["primary", "secondary", "primary"]);
const goVehicles = gthaWithFallbacks.feeds
	.find((feed) => feed.id === "go")
	.realtimeSources.find((source) => source.id === "go-vehicles");
assert.match(goVehicles.source.url, /key=primary$/);
assert.deepEqual(goVehicles.source.fallbackUrls, [goVehicles.source.url.replace("primary", "secondary")]);
assert.deepEqual(gthaWithFallbacks.places.find((place) => place.id === "guelph").members, [
	{ feedId: "go", localId: "GL" },
	{ feedId: "via", localId: "70" },
]);

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

function feed(name, timezone) {
	return createZip({
		"agency.txt": `agency_id,agency_name,agency_url,agency_timezone\nagency,${name},https://example.test,${timezone}\n`,
		"routes.txt": "route_id,agency_id,route_short_name,route_long_name,route_type\nshared,agency,R,Shared Rail,2\n",
		"stops.txt": `stop_id,stop_name,stop_lat,stop_lon\nshared,${name} Station,-27.4,153.0\nend,${name} End,-27.5,153.1\n`,
		"trips.txt":
			"route_id,service_id,trip_id,trip_headsign,direction_id,shape_id\nshared,shared,shared,End,0,shared\n",
		"stop_times.txt":
			"trip_id,arrival_time,departure_time,stop_id,stop_sequence\nshared,25:30:00,25:30:00,shared,1\nshared,26:00:00,26:00:00,end,2\n",
		"calendar.txt":
			"service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nshared,1,1,1,1,1,1,1,20260101,20261231\n",
		"shapes.txt":
			"shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\nshared,-27.4,153.0,1\nshared,-27.5,153.1,2\n",
	});
}

const feeds = { "/a.zip": feed("Alpha", "Australia/Brisbane"), "/b.zip": feed("Beta", "America/Toronto") };
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
		],
	};
	const runtime = new TRAX(definition, { cacheDir: ".TRAXCACHE/test-synthetic" });
	await runtime.loadGTFS(false, false);
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
	assert.equal(runtime.metadata.feeds.find((value) => value.id === "beta").timeZone, "America/Toronto");

	const eagerInstanceCount = alphaTrip.instances.length;
	assert.ok(runtime.getAvailableServiceDates().includes("20261215"));
	assert.equal(alphaTrip.instances.length, eagerInstanceCount, "listing calendar dates must not build instances");
	assert.equal(runtime.getTripIdsByServiceDate("20261215").length, 2);
	const lazyAlpha = alphaTrip.instances.find((instance) => instance.serviceDate === "20261215");
	assert.ok(lazyAlpha, "a far service date should materialize on demand");
	const lazyAlphaId = lazyAlpha.instance_id;
	for (let day = 16; day <= 25; day++) runtime.getTripIdsByServiceDate(`202612${day}`);
	assert.equal(alphaTrip.instances.some((instance) => instance.serviceDate === "20261215"), false);
	assert.equal(runtime.getAugmentedTripInstance(lazyAlphaId)?.instance_id, lazyAlphaId);

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
	console.log("Architecture tests passed.");
} finally {
	server.close();
}
