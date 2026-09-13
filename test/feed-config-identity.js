import assert from "node:assert/strict";
import {
	resolveConfig,
	materializeSameStationIdPlaces,
	getPlaceForStation,
} from "../dist/config.js";
import { loadStatic } from "../dist/gtfsInterfaceLayer.js";
import * as configModule from "../dist/config.js";

const quiet = { progressLog: () => {}, logFunction: () => {} };

function baseNetwork(overrides = {}) {
	return {
		id: "feed-identity-test",
		name: "Feed identity test",
		feeds: [{ id: "alpha", staticSource: { url: "https://example.test/a.zip" }, realtimeSources: [] }],
		modes: ["rail"],
		plugins: [],
		...overrides,
	};
}

function makeStop(feed_id, stop_id, extra = {}) {
	return {
		stop_id,
		stop_code: null,
		stop_name: `${stop_id} station`,
		stop_desc: null,
		stop_lat: -27.4,
		stop_lon: 153.0,
		zone_id: null,
		stop_url: null,
		location_type: null,
		parent_station: null,
		stop_timezone: null,
		wheelchair_boarding: null,
		level_id: null,
		platform_code: null,
		feed_id,
		...extra,
	};
}

// 1. Static fallbackUrls must be passed through for per-feed QDF fallback.
{
	const attempts = [];
	const fakeGtfs = {
		async loadStatic(feeds) {
			attempts.push(feeds.map((f) => ({ url: f.url, fallbackUrls: f.fallbackUrls ?? [] })));
			// Simulate QDF per-source fallback: primary failure is recovered
			// via fallbackUrls within the same call, without an outer retry.
			const withFallback = feeds.every(
				(f) => !f.url.includes("primary") || f.fallbackUrls?.some((u) => u.includes("fallback")),
			);
			if (!withFallback) {
				throw new Error("primary boom");
			}
			return feeds.map((f) => ({ id: f.id, source: "network" }));
		},
		actions: { mergeStops: () => {}, updateStop: () => {} },
	};
	const config = resolveConfig(
		baseNetwork({
			feeds: [
				{
					id: "alpha",
					staticSource: {
						url: "https://example.test/primary.zip",
						fallbackUrls: ["https://example.test/fallback.zip"],
					},
					realtimeSources: [],
				},
			],
		}),
		quiet,
	);
	const beforeUrls = JSON.stringify(config.network.feeds[0].staticSource);
	await loadStatic(fakeGtfs, config);
	assert.equal(
		attempts.length,
		1,
		`static fallback must ride a single per-feed call, not an outer reload (attempts=${attempts.length})`,
	);
	assert.ok(
		attempts[0].some((f) => f.url.includes("primary")),
		"static call must use the primary URL",
	);
	assert.ok(
		attempts[0].some((f) => f.fallbackUrls.some((u) => u.includes("fallback"))),
		"static call must pass fallback URLs through for QDF per-source retry",
	);
	assert.equal(
		JSON.stringify(config.network.feeds[0].staticSource),
		beforeUrls,
		"static fallback must not mutate the configured sources",
	);

	// All candidates failing must still surface the primary failure safely.
	const alwaysFail = {
		async loadStatic() {
			throw new Error("primary boom");
		},
		actions: { mergeStops: () => {}, updateStop: () => {} },
	};
	await assert.rejects(
		() =>
			loadStatic(alwaysFail, config),
		/primary boom/,
		"exhausted static fallbacks must surface the failure",
	);
}

// 2. Configured places must resolve member stations across feed-qualified
// identities instead of disappearing when no exact station row exists.
{
	const config = resolveConfig(
		baseNetwork({
			feeds: [
				{ id: "alpha", staticSource: { url: "https://example.test/a.zip" }, realtimeSources: [] },
				{ id: "beta", staticSource: { url: "https://example.test/b.zip" }, realtimeSources: [] },
			],
			places: [
				{
					id: "parent-only",
					name: "Parent Only",
					members: [
						{ feedId: "alpha", localId: "CENTRAL" },
						{ feedId: "beta", localId: "CENTRAL" },
					],
				},
			],
		}),
		quiet,
	);
	// No exact `CENTRAL` stop row exists: each feed only has platforms whose
	// parent_station is CENTRAL. Feed qualification matters: beta's platform
	// must not satisfy alpha's membership.
	const stops = [
		makeStop("alpha", "alpha-p1", { parent_station: "CENTRAL" }),
		makeStop("alpha", "alpha-p2", { parent_station: "CENTRAL" }),
		makeStop("beta", "beta-p1", { parent_station: "CENTRAL" }),
	];
	const materialized = materializeSameStationIdPlaces(config, stops);
	const place = materialized.places.find((p) => p.id === "parent-only");
	assert.ok(place, "configured place must survive when members exist only as parent stations");
	assert.equal(place.members.length, 2, "both feed-qualified members must be retained");
	assert.ok(
		getPlaceForStation(materialized, { feedId: "alpha", localId: "CENTRAL" }),
		"exact station identity must still resolve",
	);
	assert.equal(
		getPlaceForStation(materialized, { feedId: "alpha", localId: "alpha-p1" })?.id,
		"parent-only",
		"child platform must resolve to its parent station's configured place",
	);
	assert.equal(
		getPlaceForStation(materialized, { feedId: "beta", localId: "beta-p1" })?.id,
		"parent-only",
		"beta child platform must resolve within its own feed identity",
	);
	assert.equal(
		getPlaceForStation(materialized, { feedId: "beta", localId: "alpha-p1" }),
		null,
		"feed qualification must not leak across feeds",
	);
}

// 3. Config boundaries must reject duplicate IDs, empty URLs, invalid kinds.
{
	// Duplicate realtime source IDs across feeds.
	assert.throws(
		() =>
			resolveConfig(
				baseNetwork({
					feeds: [
						{
							id: "alpha",
							staticSource: { url: "https://example.test/a.zip" },
							realtimeSources: [
								{ id: "dup", targetFeedId: "alpha", kind: "vehicles", source: { url: "https://example.test/v1" } },
							],
						},
						{
							id: "beta",
							staticSource: { url: "https://example.test/b.zip" },
							realtimeSources: [
								{ id: "dup", targetFeedId: "beta", kind: "vehicles", source: { url: "https://example.test/v2" } },
							],
						},
					],
				}),
				quiet,
			),
		/duplicate.*dup/i,
		"duplicate realtime source IDs must be rejected",
	);

	// Duplicate source IDs within one feed.
	assert.throws(
		() =>
			resolveConfig(
				baseNetwork({
					feeds: [
						{
							id: "alpha",
							staticSource: { url: "https://example.test/a.zip" },
							realtimeSources: [
								{ id: "dup", targetFeedId: "alpha", kind: "vehicles", source: { url: "https://example.test/v1" } },
								{ id: "dup", targetFeedId: "alpha", kind: "alerts", source: { url: "https://example.test/a1" } },
							],
						},
					],
				}),
				quiet,
			),
		/duplicate/i,
		"duplicate source IDs within a feed must be rejected",
	);

	// Empty static URL.
	assert.throws(
		() =>
			resolveConfig(
				baseNetwork({
					feeds: [{ id: "alpha", staticSource: { url: "   " }, realtimeSources: [] }],
				}),
				quiet,
			),
		/url/i,
		"empty static URLs must be rejected",
	);

	// Empty realtime URL.
	assert.throws(
		() =>
			resolveConfig(
				baseNetwork({
					feeds: [
						{
							id: "alpha",
							staticSource: { url: "https://example.test/a.zip" },
							realtimeSources: [{ id: "rt", targetFeedId: "alpha", kind: "vehicles", source: { url: "" } }],
						},
					],
				}),
				quiet,
			),
		/url/i,
		"empty realtime URLs must be rejected",
	);

	// Empty fallback URL.
	assert.throws(
		() =>
			resolveConfig(
				baseNetwork({
					feeds: [
						{
							id: "alpha",
							staticSource: { url: "https://example.test/a.zip", fallbackUrls: ["https://example.test/ok.zip", " "] },
							realtimeSources: [],
						},
					],
				}),
				quiet,
			),
		/url/i,
		"empty fallback URLs must be rejected",
	);

	// Invalid realtime kind.
	assert.throws(
		() =>
			resolveConfig(
				baseNetwork({
					feeds: [
						{
							id: "alpha",
							staticSource: { url: "https://example.test/a.zip" },
							realtimeSources: [
								{ id: "rt", targetFeedId: "alpha", kind: "not-a-kind", source: { url: "https://example.test/x" } },
							],
						},
					],
				}),
				quiet,
			),
		/kind/i,
		"invalid realtime source kinds must be rejected",
	);
}

// 4. stop_timezone must follow GTFS trip-time semantics, not blind per-stop use.
{
	assert.equal(
		typeof configModule.resolveStopDisplayTimeZone,
		"function",
		"stop display timezone helper must exist",
	);
	assert.equal(
		typeof configModule.getTripTimeZone,
		"function",
		"trip-time timezone helper must exist",
	);
	const { resolveStopDisplayTimeZone, getTripTimeZone } = configModule;
	const feedTimeZone = "Australia/Brisbane";

	// Trip times always use the feed (agency) timezone, never stop_timezone.
	assert.equal(
		getTripTimeZone({ feedTimeZones: new Map([["alpha", feedTimeZone]]), network: { id: "t" } }, "alpha", {
			stop_timezone: "America/Toronto",
		}),
		feedTimeZone,
		"trip-timezone must ignore stop_timezone per GTFS trip-time semantics",
	);

	// A child stop inherits its parent station's timezone; its own value is ignored.
	const parent = makeStop("alpha", "CENTRAL", { stop_timezone: "America/Toronto" });
	const child = makeStop("alpha", "CENTRAL-p1", {
		parent_station: "CENTRAL",
		stop_timezone: "Pacific/Auckland",
	});
	assert.equal(
		resolveStopDisplayTimeZone(child, parent, feedTimeZone),
		"America/Toronto",
		"child must inherit parent stop_timezone instead of applying its own blindly",
	);
	// Parentless stops use their own stop_timezone, falling back to the feed zone.
	const lone = makeStop("alpha", "LONE", { stop_timezone: "America/Toronto" });
	assert.equal(resolveStopDisplayTimeZone(lone, null, feedTimeZone), "America/Toronto");
	assert.equal(
		resolveStopDisplayTimeZone(makeStop("alpha", "PLAIN"), null, feedTimeZone),
		feedTimeZone,
		"missing stop_timezone must fall back to the feed timezone",
	);
	// Invalid zones must never break trip-time math.
	assert.equal(resolveStopDisplayTimeZone(lone, null, feedTimeZone), "America/Toronto");
	assert.equal(
		resolveStopDisplayTimeZone(makeStop("alpha", "BAD", { stop_timezone: "Not/AZone" }), null, feedTimeZone),
		feedTimeZone,
		"invalid stop_timezone must fall back to the feed timezone",
	);
}

// 5. Derived normalized-ID collisions must not abort the whole static refresh.
{
	const config = resolveConfig(
		baseNetwork({
			feeds: [
				{ id: "alpha", staticSource: { url: "https://example.test/a.zip" }, realtimeSources: [] },
				{ id: "beta", staticSource: { url: "https://example.test/b.zip" }, realtimeSources: [] },
			],
			sameStationIdPlaces: [
				{ feedIds: ["alpha", "beta"], canonicalFeedId: "alpha", placeIdPrefix: "derived-", maxDistanceMeters: 100 },
			],
		}),
		quiet,
	);
	// "A B" and "A/B" normalize to the same derived ID "derived-a-b".
	const stops = [
		makeStop("alpha", "A B"),
		makeStop("alpha", "A/B"),
		makeStop("beta", "A B"),
		makeStop("beta", "A/B"),
	];
	let materialized = null;
	assert.doesNotThrow(
		() => {
			materialized = materializeSameStationIdPlaces(config, stops);
		},
		"normalized-ID collision must not abort the static refresh",
	);
	assert.ok(materialized, "materialization must still produce a config");
	const derived = materialized.places.filter((p) => p.id === "derived-a-b");
	assert.equal(derived.length, 1, "colliding normalized IDs must yield one surviving derived place, not a throw");
	assert.equal(derived[0].members.length, 2, "surviving derived place must still group its first station");
}

// 6. Static fallback retries must not reload healthy feeds.
{
	const attempts = [];
	const qdfLikeGtfs = {
		async loadStatic(feeds) {
			attempts.push(feeds.map((f) => ({ id: f.id, url: f.url, fallbackUrls: f.fallbackUrls ?? [] })));
			// Simulate QDF per-source fallback: a feed whose primary fails but
			// carries a fallback succeeds without a second outer call.
			for (const f of feeds) {
				if (f.url.includes("alpha-primary") && !f.fallbackUrls.some((u) => u.includes("alpha-fallback"))) {
					throw new Error("alpha primary boom");
				}
			}
			return feeds.map((f) => ({ id: f.id, source: "network" }));
		},
		actions: { mergeStops: () => {}, updateStop: () => {} },
	};
	const config = resolveConfig(
		baseNetwork({
			feeds: [
				{
					id: "alpha",
					staticSource: {
						url: "https://example.test/alpha-primary.zip",
						fallbackUrls: ["https://example.test/alpha-fallback.zip"],
					},
					realtimeSources: [],
				},
				{
					id: "beta",
					staticSource: { url: "https://example.test/beta-primary.zip" },
					realtimeSources: [],
				},
			],
		}),
		quiet,
	);
	await loadStatic(qdfLikeGtfs, config);
	assert.equal(
		attempts.length,
		1,
		`static fallback must ride a single loadStatic with per-feed fallbacks, not reload healthy feeds (attempts=${attempts.length})`,
	);
	const alphaAttempt = attempts[0].find((f) => f.id === "alpha");
	assert.ok(
		alphaAttempt.fallbackUrls.some((u) => u.includes("alpha-fallback")),
		"alpha fallback URL must be passed through so QDF can try it without a second outer call",
	);
	const betaUrls = attempts.flatMap((a) => a.filter((f) => f.id === "beta").map((f) => f.url));
	assert.equal(betaUrls.length, 1, "healthy beta feed must be loaded exactly once");
}

console.log("Feed/config identity tests passed.");
