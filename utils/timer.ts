import { logger, LogLevel } from "../index.js";

export class Timer {
	private times: Map<string, number> = new Map();
	private activeTimers: Map<string, number> = new Map();
	private counts: Map<string, number> = new Map();
	private minTimes: Map<string, number> = new Map();
	private maxTimes: Map<string, number> = new Map();

	public start(category: string) {
		this.activeTimers.set(category, performance.now());
		this.counts.set(category, (this.counts.get(category) ?? 0) + 1);
	}

	public stop(category: string) {
		const start = this.activeTimers.get(category);
		if (start !== undefined) {
			const elapsed = performance.now() - start;
			this.times.set(category, (this.times.get(category) ?? 0) + elapsed);

			const currentMin = this.minTimes.get(category) ?? Infinity;
			if (elapsed < currentMin) this.minTimes.set(category, elapsed);

			const currentMax = this.maxTimes.get(category) ?? 0;
			if (elapsed > currentMax) this.maxTimes.set(category, elapsed);

			this.activeTimers.delete(category);
		}
	}

	public log(label: string) {
		if (logger.getLevel() < LogLevel.DEBUG) return;
		console.log(`\n--- Detailed Timing Report: ${label} ---`);

		const sorted = Array.from(this.times.entries()).sort((a, b) => b[1] - a[1]);
		for (const [category, total] of sorted) {
			const count = this.counts.get(category) ?? 0;
			const avg = total / count;
			const min = this.minTimes.get(category) ?? 0;
			const max = this.maxTimes.get(category) ?? 0;

			const depth = category.split(":").length - 1;
			const indent = "  ".repeat(depth);
			const displayName = indent + (depth > 0 ? "└ " : "") + category.split(":").pop();

			console.log(
				`${displayName.padEnd(45)} | ${total.toFixed(2).padStart(10)}ms | x${count.toString().padEnd(6)} | avg: ${avg.toFixed(3).padStart(8)}ms | [${min.toFixed(2)}, ${max.toFixed(2)}]`,
			);
		}
		console.log("-".repeat(110) + "\n");
	}

	public clear() {
		this.times.clear();
		this.activeTimers.clear();
		this.counts.clear();
		this.minTimes.clear();
		this.maxTimes.clear();
	}
}

export const globalTimer = new Timer();
