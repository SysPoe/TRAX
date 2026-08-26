import assert from "node:assert/strict";
import test from "node:test";
import type { CacheContext } from "../src/cache/types.js";
import {
	getQrtBookingSeatMap,
	parseQrtSeatMap,
	qrtSeatMapRequest,
	selectQrtSeatMapFareOption,
	type QrtBookingSeatMap,
} from "../src/region-specific/AU/SEQ/qr-travel/seat-map.js";

/** 1x1 red JPEG. */
const JPEG_BYTES = Buffer.from(
	"/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwcJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPDs0NDT/wAALCAABAAEBAREA/8QAFAABAQAAAAAAAAAAAAAAAAAAAAv/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AmAA=",
	"base64",
);

const RAW_PAYLOAD = {
	success: true,
	fields: {
		railCars: [
			{
				id: 118,
				name: "C",
				no: "TTMC-RockhamptonQ301",
				series: "Tilt",
				sequence: "C",
				available: true,
				imageData: JPEG_BYTES.toString("base64"),
				imageID: 102,
				imageName: "TILT Seat Map_TBS_1150x171_Car C v.3",
				imagePath: null,
				imageType: "JPG",
				allowedRailServiceOptions: [{ id: 30467, name: "Economy Seat" }],
				seats: [
					{
						id: 3597,
						typeName: "Window",
						name: "1",
						number: 1,
						available: false,
						xcoord: "774",
						ycoord: "127",
						serviceTypeOptionId: "30467,30999",
					},
					{
						id: 3598,
						typeName: "Aisle",
						name: "2",
						number: 2,
						available: true,
						xcoord: 812,
						ycoord: 127,
						serviceTypeOptionId: null,
					},
					{ id: 0, name: "", xcoord: "1", ycoord: "2" },
				],
				carriageGeneralInformation: [
					{
						carriageInformationId: 6795848,
						carriageTypeId: 1,
						carriageQuestions: "Aisle and Door Widths",
						carriageAnswers: "Published answer text.",
						railCarId: 118,
						mainRailDepartureCarId: 0,
						railDepartureCarId: 1440317,
						managemmentLegId: 0,
						isDepartureLevel: true,
					},
					{ carriageInformationId: 2, carriageQuestions: "  ", carriageAnswers: "No question." },
				],
			},
			{ id: 119, name: "Cargo", sequence: null, series: null, available: false, seats: [] },
		],
		autoSeats: null,
		errors: null,
		warnings: null,
	},
};

function fakeContext(): CacheContext {
	return {
		pluginState: new Map(),
		config: { requestTimeoutMs: 5000 },
	} as unknown as CacheContext;
}

test("parseQrtSeatMap normalizes carriages, seats, and compatibility", () => {
	const diagrams: { hash: string; bytes: Uint8Array }[] = [];
	const carriages = parseQrtSeatMap(RAW_PAYLOAD, (imageData) => {
		if (typeof imageData !== "string" || !imageData) return null;
		const bytes = Buffer.from(imageData, "base64");
		const hash = `hash-${diagrams.length}`;
		diagrams.push({ hash, bytes });
		return hash;
	});

	assert.equal(carriages.length, 2);
	const carC = carriages[0];
	assert.equal(carC.name, "C");
	assert.equal(carC.series, "Tilt");
	assert.equal(carC.sequence, "C");
	assert.equal(carC.available, true);
	assert.deepEqual(carC.allowedServiceOptions, [{ id: "30467", name: "Economy Seat" }]);
	assert.equal(carC.diagramHash, "hash-0");
	assert.equal(carC.diagramContentType, "image/jpeg");
	assert.deepEqual(diagrams[0].bytes, JPEG_BYTES);

	assert.equal(carC.seats.length, 2);
	const window = carC.seats[0];
	assert.equal(window.id, "3597");
	assert.equal(window.x, 774);
	assert.equal(window.y, 127);
	assert.equal(window.available, false);
	assert.deepEqual(window.compatibleServiceTypeOptionIds, ["30467", "30999"]);
	const aisle = carC.seats[1];
	assert.equal(aisle.x, 812);
	assert.deepEqual(aisle.compatibleServiceTypeOptionIds, []);

	assert.deepEqual(carC.publishedInformation, [
		{ question: "Aisle and Door Widths", answer: "Published answer text." },
	]);

	const cargo = carriages[1];
	assert.equal(cargo.name, "Cargo");
	assert.equal(cargo.available, false);
	assert.equal(cargo.diagramHash, null);
	assert.deepEqual(cargo.seats, []);
});

test("parseQrtSeatMap keeps seats that lack diagram coordinates", () => {
	const carriages = parseQrtSeatMap(
		{ fields: { railCars: [{ id: 7, name: "A", seats: [{ id: 9, name: "10", available: true }] }] } },
		() => null,
	);
	assert.equal(carriages[0].seats.length, 1);
	assert.equal(carriages[0].seats[0].x, null);
	assert.equal(carriages[0].seats[0].y, null);
});

test("selectQrtSeatMapFareOption prefers the cheapest regular seat product", () => {
	const service = {
		raiL_OPTIONS: [
			{ servicE_OPTION_TYPE: 1, servicE_OPTION_NAME: "Vehicle Space", servicE_OPTION_ID: 900, adulT_PRICE: 5 },
			{ servicE_OPTION_TYPE: 0, servicE_OPTION_NAME: "Business Seat", servicE_OPTION_ID: 301, adulT_PRICE: 200 },
			{ servicE_OPTION_TYPE: 0, servicE_OPTION_NAME: "Economy Seat", servicE_OPTION_ID: 30467, adulT_PRICE: 89 },
		],
	};
	assert.equal(selectQrtSeatMapFareOption(service)?.servicE_OPTION_ID, 30467);
});

test("qrtSeatMapRequest mirrors the InteractiveSeatMap body shape", () => {
	const service = { serviceid: 4046, traveL_DATE: "2026-08-31T00:00:00", raiL_ROUTE_ID: 302 };
	const option = { servicE_OPTION_ID: 30467 };
	assert.deepEqual(qrtSeatMapRequest(service, option), {
		Service: {
			ServiceId: 4046,
			TravelDate: "2026-08-31",
			RailRouteID: 302,
			Options: [{ ServiceOptionID: 30467, Passengers: [{ PassengerId: 1 }] }],
		},
	});
});

test("getQrtBookingSeatMap serves fresh, then stale-while-revalidate, results", async () => {
	const ctx = fakeContext();
	const trip = {
		serviceId: "PPS-123",
		departureDate: "2026-08-31T07:05:00",
		stops: [
			{
				placeCode: "ROM",
				placeName: "Roma Street",
				plannedDeparture: "2026-08-31T07:05:00",
				trainPosition: "NotArrived",
			},
			{
				placeCode: "BDB",
				placeName: "Bundaberg",
				plannedDeparture: "2026-08-31T13:00:00",
				trainPosition: "NotArrived",
			},
		],
	} as never;
	const first: QrtBookingSeatMap = {
		serviceId: "PPS-123",
		travelDate: "2026-08-31",
		selectedFare: null,
		source: "Queensland Rail Travel booking",
		asOf: "2026-08-26T00:00:00.000Z",
		carriages: [],
	};
	const second = { ...first, asOf: "2026-08-26T01:00:00.000Z" };
	let fetched = 0;
	let resolveFetch: ((map: QrtBookingSeatMap | null) => void) | null = null;
	const fetchMap = () =>
		new Promise<QrtBookingSeatMap | null>((resolve) => {
			fetched += 1;
			if (fetched === 1) return resolve(first);
			resolveFetch = resolve;
		});

	assert.equal(await getQrtBookingSeatMap(trip, ctx, { fetchMap }), first);
	assert.equal(await getQrtBookingSeatMap(trip, ctx, { fetchMap }), first);
	assert.equal(fetched, 1);

	// Expire the cached entry; the stale map must return immediately.
	const state = ctx.pluginState.get("au-seq-qrt-seat-map") as {
		seatMaps: Map<string, { expiresAt: number }>;
	};
	for (const entry of state.seatMaps.values()) entry.expiresAt = 0;

	assert.equal(await getQrtBookingSeatMap(trip, ctx, { fetchMap }), first);
	assert.equal(fetched, 2);
	assert.equal(await getQrtBookingSeatMap(trip, ctx, { fetchMap }), first);
	assert.equal(fetched, 2, "background refresh is deduplicated");

	resolveFetch?.(second);
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(await getQrtBookingSeatMap(trip, ctx, { fetchMap }), second);
	assert.equal(fetched, 2);
});

test("getQrtBookingSeatMap keeps the last map when a refresh fails", async () => {
	const ctx = fakeContext();
	const trip = {
		serviceId: "PPS-456",
		departureDate: "2026-08-31T07:05:00",
		stops: [
			{
				placeCode: "ROM",
				placeName: "Roma Street",
				plannedDeparture: "2026-08-31T07:05:00",
				trainPosition: "NotArrived",
			},
			{
				placeCode: "BDB",
				placeName: "Bundaberg",
				plannedDeparture: "2026-08-31T13:00:00",
				trainPosition: "NotArrived",
			},
		],
	} as never;
	const map = {
		serviceId: "PPS-456",
		travelDate: "2026-08-31",
		selectedFare: null,
		source: "Queensland Rail Travel booking",
		asOf: "2026-08-26T00:00:00.000Z",
		carriages: [],
	} as QrtBookingSeatMap;
	let fetched = 0;
	const fetchMap = async () => {
		fetched += 1;
		if (fetched === 1) return map;
		throw new Error("provider down");
	};

	assert.equal(await getQrtBookingSeatMap(trip, ctx, { fetchMap }), map);
	const state = ctx.pluginState.get("au-seq-qrt-seat-map") as {
		seatMaps: Map<string, { expiresAt: number }>;
	};
	for (const entry of state.seatMaps.values()) entry.expiresAt = 0;

	assert.equal(await getQrtBookingSeatMap(trip, ctx, { fetchMap }), map);
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(await getQrtBookingSeatMap(trip, ctx, { fetchMap }), map);
});
