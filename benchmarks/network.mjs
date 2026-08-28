import TRAX, { AU_SEQ_NETWORK, LogLevel } from "../dist/index.js";
import { emitBenchmark, measure } from "./measure.mjs";

const cacheDir = process.env.TRAX_BENCHMARK_CACHE_DIR ?? ".TRAXCACHE/au-seq";

async function main() {
	const trax = new TRAX(AU_SEQ_NETWORK, {
		cacheDir,
		cacheMaxAgeMs: Number.MAX_SAFE_INTEGER,
		disableTimers: true,
		logFunction: () => {},
		progressLog: () => {},
	});

	const fullLoad = await measure(() => trax.loadGTFS(true, false));
	emitBenchmark({
		repository: "TRAX",
		category: "network-dependent",
		benchmark: "full-load-realtime-enabled",
		...fullLoad.metrics,
		details: { cacheDir, realtimeEnabled: true },
	});

	const refresh = await measure(() => trax.refreshRealtime());
	emitBenchmark({
		repository: "TRAX",
		category: "network-dependent",
		benchmark: "standalone-realtime-refresh",
		...refresh.metrics,
		details: { cacheDir },
	});
	trax.clearIntervals();
}
try {
	const { logger } = await import("../dist/index.js");
	logger.setLevel(LogLevel.NONE);
	await main();
} catch (error) {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
}
