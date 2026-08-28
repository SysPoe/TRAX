import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import TRAX, { AU_SEQ_NETWORK, LogLevel } from "../dist/index.js";
import { refreshRealtimeCache } from "../dist/cache/refreshCaches.js";
import { createRealtimeFixture } from "./realtime-fixture.mjs";
import { emitBenchmark, measure } from "./measure.mjs";

const CACHE_MAX_AGE_MS = Number.MAX_SAFE_INTEGER;
const cacheDir = path.resolve(process.env.TRAX_BENCHMARK_CACHE_DIR ?? ".TRAXCACHE/au-seq");

function staticCachePath(url) {
	const sourceKey = `${url}|{}`;
	return path.join(cacheDir, crypto.createHash("md5").update(sourceKey).digest("hex"));
}

function requireStaticCache() {
	const missing = AU_SEQ_NETWORK.feeds
		.map((feed) => staticCachePath(feed.staticSource.url))
		.filter((file) => !fs.existsSync(file));
	if (missing.length === 0) return;
	throw new Error(
		`Deterministic TRAX benchmark needs the cached static archive in ${cacheDir}. Missing: ${missing.join(", ")}. Set TRAX_BENCHMARK_ALLOW_NETWORK=1 to opt into a network fallback.`,
	);
}

function runtimeOptions() {
	return {
		cacheDir,
		cacheMaxAgeMs: CACHE_MAX_AGE_MS,
		disableTimers: true,
		logFunction: () => {},
		progressLog: () => {},
	};
}

async function runStaticAndQueries() {
	const allowNetwork = process.env.TRAX_BENCHMARK_ALLOW_NETWORK === "1";
	if (!allowNetwork) requireStaticCache();

	const trax = new TRAX(AU_SEQ_NETWORK, runtimeOptions());
	const staticResult = await measure(() => trax.loadGTFS(false, false));
	const staticCounts = {
		trips: trax.getRawTrips().length,
		stops: trax.getRawStops().length,
		stations: trax.getStations().length,
		availableServiceDates: trax.getAvailableServiceDates().length,
	};
	emitBenchmark({
		repository: "TRAX",
		category: allowNetwork ? "network-dependent" : "deterministic-local",
		benchmark: "full-static-load-realtime-disabled",
		...staticResult.metrics,
		details: {
			cacheDir,
			staticSource: allowNetwork ? "cache-or-network" : "fresh-cache-required",
			...staticCounts,
		},
	});

	const feedId = AU_SEQ_NETWORK.feeds[0].id;
	const stations = trax
		.getStations()
		.filter((station) => station.feed_id === feedId)
		.map((station) => ({
			station,
			tripCount: trax.getTripIdsByStop({ feedId, localId: station.stop_id }).size,
		}))
		.filter(({ tripCount }) => tripCount > 0)
		.sort((a, b) => a.tripCount - b.tripCount);
	if (stations.length === 0) throw new Error("TRAX benchmark found no station with trips");
	const small = stations[0];
	const busy = stations.at(-1);
	const today = trax.today();
	const availableDates = trax.getAvailableServiceDates();
	const preferredDate = process.env.TRAX_BENCHMARK_SERVICE_DATE ?? "20260828";
	const serviceDate =
		availableDates.includes(preferredDate)
			? preferredDate
			: availableDates.find((date) => date >= today) ?? availableDates.at(-1);
	if (!serviceDate) throw new Error("TRAX benchmark found no service date");

	for (const [label, selected] of [
		["departure-query-busy-station", busy],
		["departure-query-small-station", small],
	]) {
		const result = await measure(() =>
			trax.utils.departures.getDeparturesForStop(selected.station, serviceDate, "05:00:00", "23:59:59"),
		);
		emitBenchmark({
			repository: "TRAX",
			category: "deterministic-local",
			benchmark: label,
			...result.metrics,
			details: {
				feedId,
				stationId: selected.station.stop_id,
				stationName: selected.station.stop_name,
				indexedTripCount: selected.tripCount,
				serviceDate,
				resultCount: result.value.length,
			},
		});
	}

	const allTrips = await measure(() => trax.getAugmentedTrips());
	emitBenchmark({
		repository: "TRAX",
		category: "deterministic-local",
		benchmark: "get-augmented-trips-all",
		...allTrips.metrics,
		details: { resultCount: allTrips.value.length },
	});

	const firstInstanceId = allTrips.value.find((trip) => trip.instances[0])?.instances[0]?.instance_id;
	if (!firstInstanceId) throw new Error("TRAX benchmark found no augmented trip instance");
	const instance = await measure(() => trax.getAugmentedTripInstance(firstInstanceId));
	emitBenchmark({
		repository: "TRAX",
		category: "deterministic-local",
		benchmark: "get-augmented-trip-instance-one",
		...instance.metrics,
		details: {
			instanceId: firstInstanceId,
			found: Boolean(instance.value),
			stopTimeCount: instance.value?.stopTimes.length ?? 0,
		},
	});

	trax.clearIntervals();
}

async function runRealtimeCacheSweep() {
	for (const changedTripCount of [0, 1, 10, 100]) {
		const fixture = await createRealtimeFixture(changedTripCount);
		const result = await measure(() => refreshRealtimeCache(fixture.gtfs, fixture.config, fixture.ctx));
		emitBenchmark({
			repository: "TRAX",
			category: "deterministic-local",
			benchmark: "refresh-realtime-cache",
			...result.metrics,
			details: {
				changedTripIds: changedTripCount,
				staticTripCount: fixture.rows.trips.length,
				updateCount: fixture.updates.length,
				augmentedTripCount: fixture.ctx.augmented.trips.length,
			},
		});
	}
}

async function main() {
	console.log(`TRAX benchmark core (cache=${cacheDir})`);
	await runStaticAndQueries();
	await runRealtimeCacheSweep();
}

try {
	const { logger } = await import("../dist/index.js");
	logger.setLevel(LogLevel.NONE);
	await main();
} catch (error) {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
}
