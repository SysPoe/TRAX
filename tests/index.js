import { findPath, addAdjacency, resetGraph, addSRT, getSRT, interpolateTimes } from "../build/release.js";

console.log("Testing Wasm Topology Graph...");

resetGraph();

// Build a small graph: A -> B -> C -> D, and B -> D (express)
addAdjacency("A", "B");
addAdjacency("B", "C");
addAdjacency("C", "D");
addAdjacency("B", "D");

addSRT("A", "B", 5.0);
addSRT("B", "C", 3.0);
addSRT("C", "D", 4.0);

console.log("SRT A|B:", getSRT("A", "B")); // 5.0
console.log("SRT B|A:", getSRT("B", "A")); // 5.0

// Path A to D
const path = findPath("A", "D");
console.log("Path A to D:", path); // Should be ["A", "B", "D"] if BFS finds shortest path in terms of segments

// Interpolation test
// Start 1000, End 1012, EMU values [3.0, 4.0] (B->C, C->D)
const interpolated = interpolateTimes(1000, 1012, [3.0, 4.0]);
console.log("Interpolated times:", interpolated); // Expected around 1000 + (3/7)*12 ~= 1005
