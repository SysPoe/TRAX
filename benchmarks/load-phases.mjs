import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { GTFS } from "qdf-gtfs";

// Usage: node benchmarks/load-phases.mjs au|ca <baseline-dist/index.js>
// <candidate-dist/index.js> <existing-cache-dir> [runs]. A local HTTP source
// exercises cache misses without changing the feed or measuring Internet delay.
const scriptPath = fileURLToPath(import.meta.url);
const [, , operation, ...args] = process.argv;
const hashSource = (url) => crypto.createHash("md5").update(`${url}|{}`).digest("hex");
const round = (value) => Number(value.toFixed(3));

async function worker(modulePath, networkName, mode, cacheDir, baseUrl) {
	const { default: TRAX, AU_SEQ_NETWORK, createCaGthaNetwork, logger, LogLevel } = await import(
		pathToFileURL(modulePath)
	);
	logger.setLevel(LogLevel.NONE);
	const network = networkName === "au" ? AU_SEQ_NETWORK : createCaGthaNetwork();
	const localNetwork = {
		...network,
		feeds: network.feeds.map((feed) => ({
			...feed,
			staticSource: { ...feed.staticSource, url: `${baseUrl}/${feed.id}.zip`, fallbackUrls: [] },
		})),
	};
	let qdfLoadMs = 0;
	let nativeParseMs = 0;
	let sourceResults = [];
	const downloads = [];
	const originalLoadStatic = GTFS.prototype.loadStatic;
	const originalLoadFromBuffers = GTFS.prototype.loadFromBuffers;
	const originalDownload = GTFS.prototype.download;
	GTFS.prototype.loadStatic = async function (...params) {
		const start = performance.now();
		try {
			const results = await originalLoadStatic.apply(this, params);
			sourceResults = results.map(({ id, source }) => ({ id, source }));
			return results;
		} finally {
			qdfLoadMs += performance.now() - start;
		}
	};
	GTFS.prototype.loadFromBuffers = function (...params) {
		const start = performance.now();
		return Promise.resolve(originalLoadFromBuffers.apply(this, params)).finally(() => {
			nativeParseMs += performance.now() - start;
		});
	};
	GTFS.prototype.download = async function (...params) {
		const start = performance.now();
		const buffer = await originalDownload.apply(this, params);
		downloads.push({ bytes: buffer.length, elapsedMs: round(performance.now() - start) });
		return buffer;
	};
	const trax = new TRAX(localNetwork, {
		cacheDir,
		cacheMaxAgeMs: Number.MAX_SAFE_INTEGER,
		maxExtractedEntryBytes: 256 * 1024 * 1024,
		disableTimers: false,
		logFunction: () => {},
		progressLog: () => {},
	});
	global.gc();
	global.gc();
	const start = performance.now();
	await trax.loadGTFS(false, false);
	const elapsedMs = performance.now() - start;
	const expectedSource = mode === "cold" ? "network" : "fresh-cache";
	if (sourceResults.length !== localNetwork.feeds.length || sourceResults.some(({ source }) => source !== expectedSource)) {
		throw new Error(`Expected ${expectedSource} for every feed; received ${JSON.stringify(sourceResults)}`);
	}
	const beforeGc = process.memoryUsage();
	global.gc();
	global.gc();
	const retained = process.memoryUsage();
	const timer = trax.ctx.augmented.timer;
	const trips = trax.getAugmentedTrips();
	let instances = 0;
	for (const trip of trips) instances += trip.instances.length;
	const result = {
		network: networkName,
		mode,
		elapsedMs: round(elapsedMs),
		qdfLoadMs: round(qdfLoadMs),
		nativeParseMs: round(nativeParseMs),
		qdfOtherMs: round(qdfLoadMs - nativeParseMs),
		cacheBuildMs: round(timer.times.get("refreshStaticCache") ?? 0),
		stages: Object.fromEntries(
			[...timer.times].filter(([name]) => name.startsWith("refreshStaticCache:")).map(([name, ms]) => [name.slice(19), round(ms)]),
		),
		peakRssBytes: process.resourceUsage().maxRSS * 1024,
		heapBeforeGcBytes: beforeGc.heapUsed,
		retainedHeapBytes: retained.heapUsed,
		retainedRssBytes: retained.rss,
		downloads,
		sourceResults,
		counts: {
			rawTrips: trax.getRawTrips().length,
			augmentedTrips: trips.length,
			instances,
			stops: trax.getRawStops().length,
			stations: trax.getStations().length,
		},
	};
	trax.clearIntervals();
	console.log(`BENCHMARK ${JSON.stringify(result)}`);
}

async function runChild(modulePath, networkName, mode, cacheDir, baseUrl) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [
			"--expose-gc", scriptPath, "--worker", modulePath, networkName, mode, cacheDir, baseUrl,
		], { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
		child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
		child.on("error", reject);
		child.on("close", (code) => {
			if (code !== 0) return reject(new Error(`Benchmark worker exited ${code}: ${stderr || stdout}`));
			const line = stdout.split("\n").find((part) => part.startsWith("BENCHMARK "));
			if (!line) return reject(new Error(`Benchmark worker returned no result: ${stdout}`));
			resolve(JSON.parse(line.slice(10)));
		});
	});
}

async function benchmark(networkName, baselineModule, candidateModule, sourceCache, runsText = "2") {
	if (!["au", "ca"].includes(networkName)) throw new Error("Network must be au or ca");
	const runs = Number(runsText);
	if (!Number.isInteger(runs) || runs < 1 || runs > 10) throw new Error("Runs must be 1 to 10");
	const { AU_SEQ_NETWORK, createCaGthaNetwork } = await import(pathToFileURL(candidateModule));
	const network = networkName === "au" ? AU_SEQ_NETWORK : createCaGthaNetwork();
	const archives = new Map();
	const archiveNames = new Set();
	for (const feed of network.feeds) {
		const name = hashSource(feed.staticSource.url);
		const archive = path.join(sourceCache, name);
		if (!fs.existsSync(archive)) throw new Error(`Missing cached archive for ${feed.id}: ${archive}`);
		archives.set(`/${feed.id}.zip`, archive);
		archiveNames.add(name);
	}
	const server = http.createServer((request, response) => {
		const archive = archives.get(request.url);
		if (!archive) { response.writeHead(404).end(); return; }
		response.writeHead(200, { "content-type": "application/zip", "content-length": fs.statSync(archive).size });
		fs.createReadStream(archive).pipe(response);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const baseUrl = `http://127.0.0.1:${server.address().port}`;
	const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), `trax-load-${networkName}-`));
	try {
		for (let run = 1; run <= runs; run++) {
			for (const mode of ["warm", "cold"]) {
				const revisions = run % 2 === 1
					? [["before", baselineModule], ["after", candidateModule]]
					: [["after", candidateModule], ["before", baselineModule]];
				for (const [revision, modulePath] of revisions) {
					const cacheDir = path.join(outputDir, `${revision}-${mode}-${run}`);
					fs.mkdirSync(cacheDir);
					for (const entry of fs.readdirSync(sourceCache, { withFileTypes: true })) {
						if (archiveNames.has(entry.name)) continue;
						fs.cpSync(path.join(sourceCache, entry.name), path.join(cacheDir, entry.name), { recursive: true });
					}
					const qrtPlaces = path.join(cacheDir, "qrt-places.json");
					if (fs.existsSync(qrtPlaces)) {
						const cached = JSON.parse(fs.readFileSync(qrtPlaces, "utf8"));
						cached.lastUpdated = Date.now();
						fs.writeFileSync(qrtPlaces, JSON.stringify(cached));
					}
					if (mode === "warm") {
						for (const feed of network.feeds) {
							fs.copyFileSync(archives.get(`/${feed.id}.zip`), path.join(cacheDir, hashSource(`${baseUrl}/${feed.id}.zip`)));
						}
					}
					const result = await runChild(modulePath, networkName, mode, cacheDir, baseUrl);
					console.log(`BENCHMARK ${JSON.stringify({ revision, run, ...result })}`);
				}
			}
		}
		console.error(`Benchmark caches: ${outputDir}`);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
}

try {
	if (operation === "--worker") await worker(...args);
	else await benchmark(operation, ...args);
} catch (error) {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
}
