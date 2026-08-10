/**
 * SEQ diagram benchmarks: static topology rebuild vs full cache, optional realtime refresh.
 *
 * Usage: npm run test:seq-diagram
 */
import TRAX, { AU_SEQ_NETWORK, buildSeqDiagramTopology } from "../dist/index.js";

const QR_SAMPLE = "37326341-QR 25_26-42695-1760";

async function main() {
	console.log("SEQ diagram benchmark (Translink static + optional RT)\n");

	const opts = { disableTimers: true };

	// 1) Full static load (includes augment + applySeqDiagram inside refreshStaticCache)
	const trax = new TRAX(AU_SEQ_NETWORK, opts);
	let t0 = performance.now();
	await trax.loadGTFS(false, false);
	let t1 = performance.now();
	console.log(`Full static load (considered trips only): ${((t1 - t0) / 1000).toFixed(2)}s`);

	const summary = trax.getSeqDiagramSummary();
	console.log("Diagram summary:", summary);

	const gtfs = trax.utils.getGtfs();
	const trips = trax.getRawTrips();
	console.log(`Considered trips: ${trips.length}`);

	// 2) Topology-only (single getStopTimes scan + graph) — repeatable cost without full augment
	t0 = performance.now();
	const top = buildSeqDiagramTopology(gtfs, trips);
	t1 = performance.now();
	console.log(`buildSeqDiagramTopology only: ${(t1 - t0).toFixed(1)}ms`);
	console.log(`  tripEnds=${top.tripCount} prevLinks=${top.linkedPrevCount} uniqueBlocks=${new Set(top.blockIdByTripId.values()).size}`);

	// 3) Sample QR chain from augmented instances
	const aug = trax.getAugmentedTrips({ feedId: "translink-seq", localId: QR_SAMPLE })[0];
	if (aug) {
		const inst = aug.instances[0];
		if (inst) {
			console.log("\nSample instance", QR_SAMPLE, "serviceDate", inst.serviceDate);
			console.log("  seq_diagram_prev_trip_id:", inst.seq_diagram_prev_trip_id);
			console.log("  seq_diagram_next_trip_id:", inst.seq_diagram_next_trip_id);
			console.log("  seq_diagram_block_id:", inst.seq_diagram_block_id);
			console.log("  next link broken (RT)?", inst.seq_diagram_next_link_broken);
		}
	} else {
		console.log("\n(Sample trip not in feed window — skip instance demo)");
	}

	// 4) Realtime path (network): refresh + seq diagram neighbourhood update
	let traxRt;
	try {
		traxRt = new TRAX(AU_SEQ_NETWORK, { ...opts, disableTimers: false });
		t0 = performance.now();
		await traxRt.loadGTFS(true, false);
		t1 = performance.now();
		console.log(`\nFull load + realtime: ${((t1 - t0) / 1000).toFixed(2)}s`);
		console.log("Diagram summary (after RT):", traxRt.getSeqDiagramSummary());

		t0 = performance.now();
		await traxRt.refreshRealtime();
		t1 = performance.now();
		console.log(`refreshRealtime (incl. seqDiagram batch): ${((t1 - t0) / 1000).toFixed(2)}s`);
		traxRt.logTimings("Realtime + seq diagram timings", true);
	} catch (e) {
		console.log("\n(Realtime benchmark skipped:", e.message ?? e, ")");
	}

	trax.clearIntervals();
	if (traxRt) traxRt.clearIntervals();
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
