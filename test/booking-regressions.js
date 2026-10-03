import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { _test as nsw, getTfnswRegionalBookingFormation } from "../dist/region-specific/AU/NSW/regional-booking.js";
import { parseVLineBookingPage } from "../dist/region-specific/AU/VIC/journey-planner.js";
import { _test as vline } from "../dist/region-specific/AU/VIC/enrichment.js";
import { serviceTimeToInstant } from "../dist/utils/time.js";
import { remainingBookingJourney } from "../dist/utils/bookingJourney.js";
import { getQrtBookingSeatMap } from "../dist/region-specific/AU/SEQ/qr-travel/seat-map.js";
import { getQrtBookingAvailability, qrtBookingState } from "../dist/region-specific/AU/SEQ/qr-travel/booking.js";

mock.method(Date, "now", () => Date.parse("2026-10-03T09:00:00Z"));

const trip = {
	feed_id: "nsw-trainlink", route_id: "ST21", trip_number: "ST21", instance_id: "booking-test",
	serviceDate: "20261003", vehicle_id: null, vehicle_model: null, passenger_cars: null,
	scheduled_passenger_cars: null, consist: null,
	stopTimes: [
		{ scheduled_stop_id: "200060", scheduled_departure_time: 20 * 3600 + 45 * 60 },
		{ scheduled_stop_id: "26400", scheduled_arrival_time: 28 * 3600 },
	],
};
const candidate = {
	origin: { id: "SYD", name: "Sydney" }, destination: { id: "ABX", name: "Albury" },
	legs: [{ origin: "SYD", destination: "ABX", startDate: "2026-10-03T20:42:00+10:00",
		endDate: "2026-10-04T05:08:00+11:00", isUnreservedService: false,
		service: { carrier: "NSW TrainLink", lineNumber: "21" } }],
	offers: { economy: [{ travelClass: "ECONOMY", travelClassDescription: "Economy",
		minimumAvailability: 12, price: 45, isAccommodationTypeSleeper: false }] },
};
const context = () => ({ pluginState: new Map(), config: { requestTimeoutMs: 1000 },
	gtfs: { getRoutes: () => [{ route_short_name: "21" }] } });
const options = { stationCodes: { "nsw-trainlink:26400": "ABX" } };

test("QRT retries an expired missing map in the foreground and clears failed requests", async () => {
	const ctx = context();
	const service = { serviceId: "Q301T", trip_number: "Q301", departureDate: "2026-10-04T11:00:00", stops: [
		{ placeCode: "BNE", placeName: "Brisbane", trainPosition: "NotArrived", plannedDeparture: "2026-10-04T11:00:00" },
		{ placeCode: "ROK", placeName: "Rockhampton", trainPosition: "NotArrived", plannedDeparture: null },
	] };
	assert.equal(await getQrtBookingSeatMap(service, ctx, { fetchMap: async () => null }), null);
	const state = ctx.pluginState.get("au-seq-qrt-seat-map");
	for (const entry of state.seatMaps.values()) entry.expiresAt = 0;
	await assert.rejects(getQrtBookingSeatMap(service, ctx, { fetchMap: async () => { throw new Error("provider outage"); } }), /provider outage/);
	assert.equal(state.inFlight.size, 0);
	assert.equal(await getQrtBookingSeatMap(service, ctx, { fetchMap: async () => null }), null);
});

test("QRT propagates an outage after an expired no-match, coalesces retries, and recovers", async () => {
	const ctx = context(), state = qrtBookingState(ctx);
	state.signer = { clientId: "fixture", keys: ["one", "two", "three", "four"] };
	state.signerExpiresAt = Number.MAX_SAFE_INTEGER;
	state.stations = [{ id: 1, code: "BNE", name: "Brisbane" }, { id: 2, code: "ROK", name: "Rockhampton" }];
	state.stationsExpiresAt = Number.MAX_SAFE_INTEGER;
	const service = { serviceId: "negative-cache-test", trip_number: "Q301", departureDate: "2099-10-04T11:00:00", stops: [
		{ placeCode: "BNE", placeName: "Brisbane", trainPosition: "NotArrived", plannedDeparture: "2099-10-04T11:00:00" },
		{ placeCode: "ROK", placeName: "Rockhampton", trainPosition: "NotArrived", plannedDeparture: "2099-10-04T16:00:00" },
	] };
	const original = globalThis.fetch;
	let searches = 0;
	try {
		globalThis.fetch = async () => new Response(JSON.stringify({ fields: { raiL_SERVICES: [] } }));
		assert.equal(await getQrtBookingAvailability(service, ctx), null);
		for (const entry of state.inventory.values()) entry.expiresAt = 0;
		globalThis.fetch = async () => { searches++; throw new Error("simulated QRT outage after no-match"); };
		await assert.rejects(Promise.all([getQrtBookingAvailability(service, ctx), getQrtBookingAvailability(service, ctx)]), /simulated QRT outage after no-match/);
		assert.equal(searches, 1);
		assert.equal(state.inFlight.size, 0);
		assert.equal([...state.inventory.values()][0].expiresAt, 0, "outage must not renew the successful no-match cache");
		globalThis.fetch = async () => new Response(JSON.stringify({ fields: { raiL_SERVICES: [{
			traiN_NAME: "Q301", traveL_DATE: "2099-10-04T00:00:00", departurE_TIME: service.departureDate,
			startregioncode: "BNE", endregioncode: "ROK", raiL_OPTIONS: [{
				servicE_OPTION_TYPE: 0, servicE_OPTION_NAME: "Economy Seat", availablE_QUANTITY: 7,
			}],
		}] } }));
		assert.equal((await getQrtBookingAvailability(service, ctx))?.fareClasses[0].minimumAvailability, 7);
	} finally { globalThis.fetch = original; }
});

test("NSW matches a small timetable discrepancy only for the same direct service occurrence", () => {
	assert.ok(nsw.matchesTrip(candidate, trip, "SYD", "ABX", trip.serviceDate, "21"));
	assert.equal(nsw.matchesTrip(candidate, trip, "SYD", "ABX", "20261004", "21"), null);
	assert.equal(nsw.matchesTrip(candidate, trip, "SYD", "ABX", trip.serviceDate, "22"), null);
	assert.equal(nsw.matchesTrip(candidate, trip, "SYD", "ABX", trip.serviceDate, null), null);
	assert.equal(nsw.matchesTrip({ ...candidate, legs: [candidate.legs[0], candidate.legs[0]] }, trip, "SYD", "ABX", trip.serviceDate, "21"), null);
	assert.equal(nsw.matchesTrip(candidate, { ...trip, stopTimes: [{ scheduled_departure_time: 19 * 3600 }] }, "SYD", "ABX", trip.serviceDate, "21"), null);
});

test("NSW discovers the deployed action and retries a changed deployment once", async () => {
	const original = globalThis.fetch;
	let deployment = 0, posts = 0;
	const actionIds = ["a".repeat(40), "b".repeat(40)];
	globalThis.fetch = async (url, init) => {
		if (init?.method === "POST") {
			posts++;
			if (posts === 1) { deployment = 1; return new Response("Action not found", { status: 404 }); }
			assert.equal(init.headers["next-action"], actionIds[1]);
			return new Response(`1:${JSON.stringify({ trips: [candidate] })}\n`);
		}
		if (init?.headers?.rsc) return new Response('1:{"stations":[{"id":"ABX","name":"Albury Station"}]}\n');
		if (String(url).includes("/_next/")) return new Response(`createServerReference)("${actionIds[deployment]}",callServer,void 0,findSourceMapURL,"getTrips")`);
		return new Response('<script src="/_next/static/chunks/booking.js"></script>');
	};
	try {
		const result = await getTfnswRegionalBookingFormation(trip, context(), options);
		assert.equal(result?.bookingAvailabilityStatus, "available");
		assert.equal(result?.bookingAvailability?.fareClasses[0].minimumAvailability, 12);
		assert.equal(posts, 2);
	} finally { globalThis.fetch = original; }
});

test("NSW errors remain errors and retry immediately instead of poisoning the missing cache", async () => {
	const original = globalThis.fetch, ctx = context();
	let fail = true;
	globalThis.fetch = async (_url, init) => {
		if (fail) throw new Error("simulated provider outage");
		return new Response(init?.method === "POST" ? `1:${JSON.stringify({ trips: [candidate] })}`
			: '1:{"stations":[{"id":"ABX","name":"Albury Station"}]}');
	};
	try {
		assert.equal((await getTfnswRegionalBookingFormation(trip, ctx, { ...options, actionId: "test" }))?.bookingAvailabilityStatus, "error");
		fail = false;
		assert.equal((await getTfnswRegionalBookingFormation(trip, ctx, { ...options, actionId: "test" }))?.bookingAvailabilityStatus, "available");
	} finally { globalThis.fetch = original; }
});

test("V/Line rejects a repeated run number on the wrong day", () => {
	const html = '<input id="leg_hdnServiceCode" value="8387"><input id="leg_hdnServiceOriginDateTime" value="3/10/2026 9:37:00 PM"><span id="leg_spnReservedSeatsTrain"><span class="description">104 seats available</span></span>';
	const expected = { tdn: "8387", scheduledDepartureTime: "2026-10-04T21:37:00", journeyUrl: "https://www.vline.com.au", observedAt: "2026-10-03T09:00:00Z" };
	assert.equal(parseVLineBookingPage(html, expected), null);
	assert.equal(parseVLineBookingPage(html, { ...expected, scheduledDepartureTime: "2026-10-03T21:37:00" })?.reservedSeatsAvailable, 104);
});

test("GTFS service seconds use local noon minus twelve hours on DST changes", () => {
	assert.equal(serviceTimeToInstant("20261004", 7 * 3600 + 7 * 60, "Australia/Melbourne"), "2026-10-03T20:07:00.000Z");
	assert.equal(serviceTimeToInstant("20260405", 7 * 3600 + 7 * 60, "Australia/Melbourne"), "2026-04-04T21:07:00.000Z");
	assert.equal(serviceTimeToInstant("20261004", 25 * 3600, "Australia/Melbourne"), "2026-10-04T14:00:00.000Z");
});

test("NSW matches an overnight pickup across both DST clock changes", () => {
	for (const [serviceDate, departure] of [["20261003", "2026-10-04T05:00:00+11:00"], ["20260404", "2026-04-05T03:00:00+10:00"]]) {
		const overnight = { ...trip, serviceDate, stopTimes: [{ scheduled_departure_time: 28 * 3600 }] };
		const bookingTrip = { ...candidate, legs: [{ ...candidate.legs[0], startDate: departure }] };
		assert.ok(nsw.matchesTrip(bookingTrip, overnight, "SYD", "ABX", serviceDate, "21"), departure);
	}
});

test("V/Line uses the actual local occurrence for overnight bookings and midnight rollover", () => {
	for (const [serviceDate, seconds, expected] of [
		["20261003", 28 * 3600, "2026-10-04T05:00:00"],
		["20260404", 28 * 3600, "2026-04-05T03:00:00"],
		["20261004", 30 * 60, "2026-10-03T23:30:00"],
		["20260405", 30 * 60, "2026-04-05T01:30:00"],
		["20261004", 25 * 3600, "2026-10-05T01:00:00"],
	]) {
		const scheduledDepartureTime = vline.scheduledLocalDateTime({ ...trip, serviceDate }, seconds);
		assert.equal(scheduledDepartureTime, expected);
		const html = `<input id="leg_hdnServiceCode" value="8387"><input id="leg_hdnServiceOriginDateTime" value="${expected}"><span id="leg_spnReservedSeatsTrain"><span class="description">104 seats available</span></span>`;
		assert.equal(parseVLineBookingPage(html, { tdn: "8387", scheduledDepartureTime, journeyUrl: "https://www.vline.com.au", observedAt: "2026-10-03T09:00:00Z" })?.reservedSeatsAvailable, 104);
	}
});

test("a departed train checks a future pickup and rejects drop-off-only calls", () => {
	const calls = [
		{ scheduled_departure_time: 17 * 3600, scheduled_stop_id: "origin" },
		{ scheduled_departure_time: 19 * 3600 + 30 * 60, pickup_type: 1, scheduled_stop_id: "drop-only" },
		{ scheduled_departure_time: 20 * 3600, scheduled_stop_id: "boarding" },
		{ scheduled_arrival_time: 22 * 3600, scheduled_stop_id: "destination" },
	];
	assert.deepEqual(remainingBookingJourney({ ...trip, stopTimes: calls }, "Australia/Sydney")?.stopTimes, calls.slice(2));
	assert.deepEqual(remainingBookingJourney({ ...trip, stopTimes: calls.map((call, i) => ({ ...call, actual_departure_time: i === 0 ? 25 * 3600 : call.scheduled_departure_time })) }, "Australia/Sydney")?.stopTimes.map((call) => call.scheduled_stop_id), ["boarding", "destination"]);
	assert.equal(remainingBookingJourney({ ...trip, stopTimes: calls }, "Australia/Sydney", Date.parse("2026-10-03T13:00:00Z")), null);
});

test("NSW checks a later pickup when the provider omits the next station", async () => {
	const original = globalThis.fetch;
	let searches = 0;
	globalThis.fetch = async (_url, init) => {
		if (init?.method !== "POST") return new Response('1:{"stations":[{"id":"CSI","name":"Casino Station"}]}');
		searches++;
		const [query] = JSON.parse(init.body);
		const returned = query.origin === "KPS" ? [{ ...candidate, origin: { id: "KPS", name: "Kempsey Station" }, destination: { id: "CSI", name: "Casino Station" },
			legs: [{ ...candidate.legs[0], startDate: "2026-10-03T21:30:00+10:00", service: { carrier: "NSW TrainLink", lineNumber: "31" } }] }] : [];
		return new Response(`1:${JSON.stringify({ trips: returned })}`);
	};
	try {
		const calls = [
			{ scheduled_stop_id: "passed", scheduled_departure_time: 17 * 3600 },
			{ scheduled_stop_id: "next", scheduled_departure_time: 20 * 3600 },
			{ scheduled_stop_id: "later", scheduled_departure_time: 21.5 * 3600 },
			{ scheduled_stop_id: "end", scheduled_arrival_time: 25 * 3600 },
		];
		const r = await getTfnswRegionalBookingFormation({ ...trip, stopTimes: calls }, { ...context(), gtfs: { getRoutes: () => [{ route_short_name: "31" }] } },
			{ actionId: "test", stationCodes: { "nsw-trainlink:next": "KDL", "nsw-trainlink:later": "KPS", "nsw-trainlink:end": "CSI" } });
		assert.equal(r?.bookingAvailabilityStatus, "available");
		assert.equal(r?.bookingAvailability?.journey.origin, "Kempsey Station");
		assert.equal(searches, 2);
	} finally { globalThis.fetch = original; }
});

test("empty search, sold-out fares and malformed responses have distinct outcomes", async () => {
	const original = globalThis.fetch;
	let body = "1:{\"trips\":[]}";
	globalThis.fetch = async (_url, init) => new Response(init?.method === "POST" ? body
		: '1:{"stations":[{"id":"ABX","name":"Albury Station"}]}');
	try {
		const lookup = () => getTfnswRegionalBookingFormation(trip, context(), { ...options, actionId: "test" });
		assert.equal((await lookup())?.bookingAvailabilityStatus, "no-match");
		body = `1:${JSON.stringify({ trips: [{ ...candidate, offers: { economy: [{ ...candidate.offers.economy[0], minimumAvailability: 0 }] } }] })}`;
		const soldOut = await lookup();
		assert.equal(soldOut?.bookingAvailabilityStatus, "sold-out");
		assert.equal(soldOut?.bookingAvailability?.reservationAvailable, false);
		body = `1:${JSON.stringify({ trips: [{ ...candidate, offers: { FIRST: [], SECOND: [], SLEEPER: [] } }] })}`;
		assert.equal((await lookup())?.bookingAvailabilityStatus, "sold-out");
		body = `1:${JSON.stringify({ trips: [{ ...candidate, offers: { FIRST: "unexpected provider schema" } }] })}`;
		assert.equal((await lookup())?.bookingAvailabilityStatus, "error");
		body = '<html>Upstream failure</html>';
		assert.equal((await lookup())?.bookingAvailabilityStatus, "error");
	} finally { globalThis.fetch = original; }
});
