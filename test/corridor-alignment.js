import assert from "node:assert/strict";
import { _test } from "../dist/utils/corridor/alignShape.js";

function betterState(a, b) {
	if (Math.abs(a.cost - b.cost) > 1) return a.cost < b.cost ? a : b;
	if (a.matchedCount !== b.matchedCount) return a.matchedCount > b.matchedCount ? a : b;
	return a.cost <= b.cost ? a : b;
}

// Reference transition loop retains every candidate allocation and its tie order.
function referenceSolve(anchors, shape, config, orientation, options) {
	let states = [{ last: null, cost: 0, matchedCount: 0, previous: null, choice: null }];
	for (let index = 0; index < anchors.length; index++) {
		const candidates = _test.makeCandidates(
			anchors[index],
			index,
			shape,
			config,
			anchors.length,
			orientation,
			options,
		);
		const next = new Map();
		for (const state of states) {
			const skipped = {
				last: state.last,
				cost: state.cost + 300,
				matchedCount: state.matchedCount,
				previous: state,
				choice: null,
			};
			const skippedKey = state.last?.key ?? "none";
			next.set(skippedKey, next.has(skippedKey) ? betterState(next.get(skippedKey), skipped) : skipped);
			for (const candidate of candidates) {
				if (state.last && candidate.routeProgress <= state.last.routeProgress + 2) continue;
				const resolved = {
					last: candidate,
					cost: state.cost + candidate.cost,
					matchedCount: state.matchedCount + 1,
					previous: state,
					choice: candidate,
				};
				next.set(
					candidate.key,
					next.has(candidate.key) ? betterState(next.get(candidate.key), resolved) : resolved,
				);
			}
		}
		states = [...next.values()];
	}
	return states.reduce(betterState);
}

let seed = 0x51a7;
const random = () => {
	seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
	return seed / 2 ** 32;
};
const config = {
	geometry: { exactShapeMembershipMaxMeters: 250, compatibleShapeMaxMeters: 150, endpointSnapMaxMeters: 300 },
};
for (let fixture = 0; fixture < 100; fixture++) {
	const shape = {
		lengthMeters: 10_000,
		nativeDistanceScale: 1,
		scheduledStations: new Set(),
		projections: new Map(),
	};
	for (let station = 0; station < 12; station++) {
		shape.projections.set(
			`station-${station}`,
			Array.from({ length: Math.floor(random() * 4) }, () => {
				const segmentIndex = Math.floor(random() * 20);
				return {
					segmentIndex,
					segmentFraction: 0,
					distanceAlongMeters: segmentIndex * 500,
					lateralDistanceMeters: fixture === 0 ? NaN : Math.floor(random() * 400) / 2,
					nativeShapeDistance: null,
					coordinateSource: "parent",
				};
			}),
		);
	}
	const anchors = Array.from({ length: Math.floor(random() * 35) + 1 }, (_, index) => ({
		id: `anchor-${index}`,
		stationId: `station-${Math.floor(random() * 12)}`,
		sequence: index,
	}));
	for (const orientation of ["forward", "reverse"]) {
		const options = { useNativeShapeDistance: false };
		assert.deepEqual(
			_test.solveOrientation(anchors, shape, config, orientation, options),
			referenceSolve(anchors, shape, config, orientation, options),
		);
	}
}
console.log("Corridor alignment transition parity passed for 200 seeded cases.");
