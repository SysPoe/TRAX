import TRAXClass, { logger, LogLevel, PRESETS } from "../dist/index.js";
import { config } from "dotenv";
import { existsSync } from "node:fs";

if (existsSync(".env")) {
	config();
}

async function main() {
	console.log("\n=== TRAX Performance Benchmark (CA/GTHA) ===\n");

	const testConfigs = [
		{ disableTimers: false, label: "Default (timers enabled)" },
		{ disableTimers: true, label: "Optimized (timers disabled)" },
	];

	const results = [];

	for (const testConfig of testConfigs) {
		console.log(`\nRunning: ${testConfig.label}...`);

		const TRAX = new TRAXClass({
			...PRESETS["CA/GTHA"](process.env.METROLINX_KEY),
			disableTimers: testConfig.disableTimers,
		});
		logger.setLevel(LogLevel.INFO);

		const start = Date.now();
		await TRAX.loadGTFS(true, false);
		const end = Date.now();

		const time = (end - start) / 1000;
		results.push({ label: testConfig.label, time });

		console.log(`Completed in: ${time.toFixed(2)}s`);

		TRAX.clearIntervals();
	}

	console.log("\n=== Results ===");
	console.log(`${results[0].label}: ${results[0].time.toFixed(2)}s`);
	console.log(`${results[1].label}: ${results[1].time.toFixed(2)}s`);

	const improvement = ((results[0].time - results[1].time) / results[0].time) * 100;
	console.log(`\nSpeed improvement: ${improvement.toFixed(1)}% faster with optimizations`);
	console.log(`Time saved: ${(results[0].time - results[1].time).toFixed(2)}s`);

	if (results[1].time < 30) {
		console.log(`\nTarget achieved: < 30s augmentation time`);
	} else {
		console.log(`\nTarget NOT achieved: ${results[1].time.toFixed(2)}s > 30s`);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
