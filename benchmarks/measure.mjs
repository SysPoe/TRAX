import { performance } from "node:perf_hooks";

export function forceGc() {
	if (typeof globalThis.gc !== "function") return;
	globalThis.gc();
	globalThis.gc();
}
export function memorySnapshot() {
	const memory = process.memoryUsage();
	return {
		heapUsedBytes: memory.heapUsed,
		rssBytes: memory.rss,
		externalBytes: memory.external,
		arrayBuffersBytes: memory.arrayBuffers,
	};
}

export function emitBenchmark(row) {
	console.log(`BENCHMARK ${JSON.stringify({ schemaVersion: 1, ...row })}`);
}

export async function measure(operation) {
	forceGc();
	const before = memorySnapshot();
	let peak = { ...before };
	const sample = () => {
		const current = memorySnapshot();
		if (current.heapUsedBytes > peak.heapUsedBytes) peak.heapUsedBytes = current.heapUsedBytes;
		if (current.rssBytes > peak.rssBytes) peak.rssBytes = current.rssBytes;
		if (current.externalBytes > peak.externalBytes) peak.externalBytes = current.externalBytes;
		if (current.arrayBuffersBytes > peak.arrayBuffersBytes) peak.arrayBuffersBytes = current.arrayBuffersBytes;
	};
	const sampler = setInterval(sample, 10);
	sampler.unref?.();
	const started = performance.now();
	let value;
	try {
		value = await operation();
	} finally {
		clearInterval(sampler);
	}
	const elapsedMs = performance.now() - started;
	const after = memorySnapshot();
	sample();
	return {
		value,
		metrics: {
			elapsedMs: Number(elapsedMs.toFixed(3)),
			heapUsedBeforeBytes: before.heapUsedBytes,
			heapUsedAfterBytes: after.heapUsedBytes,
			heapUsedPeakBytes: peak.heapUsedBytes,
			rssBeforeBytes: before.rssBytes,
			rssAfterBytes: after.rssBytes,
			rssPeakBytes: peak.rssBytes,
			externalBeforeBytes: before.externalBytes,
			externalAfterBytes: after.externalBytes,
			externalPeakBytes: peak.externalBytes,
			arrayBuffersBeforeBytes: before.arrayBuffersBytes,
			arrayBuffersAfterBytes: after.arrayBuffersBytes,
			arrayBuffersPeakBytes: peak.arrayBuffersBytes,
		},
	};
}
