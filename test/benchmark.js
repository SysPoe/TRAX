import TRAXClass, { logger, LogLevel } from "../dist/index.js";

async function main() {
	console.log("\n=== TRAX Performance Benchmark (SEQ) ===\n");

	logger.setLevel(LogLevel.INFO);

	const testConfigs = [
		{ disableTimers: true, label: "Optimized (timers disabled)" },
		{ disableTimers: false, label: "Default (timers enabled)" },
	];

	const results = [];

	for (const config of testConfigs) {
		console.log(`\nRunning: ${config.label}...`);
		const TRAX = new TRAXClass({ disableTimers: config.disableTimers });

		const start = Date.now();
		await TRAX.loadGTFS(false, false);
		const end = Date.now();

		const time = (end - start) / 1000;
		results.push({ label: config.label, time });

		console.log(`Completed in: ${time.toFixed(2)}s\n`);

		TRAX.clearIntervals();
	}

	console.log("\n=== Results ===");
	console.log(`${results[0].label}: ${results[0].time.toFixed(2)}s`);
	console.log(`${results[1].label}: ${results[1].time.toFixed(2)}s`);

	const improvement = ((results[1].time - results[0].time) / results[1].time) * 100;
	console.log(`\nSpeed improvement: ${improvement.toFixed(1)}% faster with optimizations`);
	console.log(`Time saved: ${(results[1].time - results[0].time).toFixed(2)}s`);
}

main().catch(console.error);
