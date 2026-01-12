// assembly/index.ts

/**
 * Topology Graph and SRT Interpolation in WebAssembly
 */

const adjacency = new Map<string, string[]>();
const srtMatrix = new Map<string, f64>(); // Key: "from|to"

/**
 * Reset all stored graph data.
 */
export function resetGraph(): void {
    let keys = adjacency.keys();
    for (let i = 0; i < keys.length; i++) {
        adjacency.delete(keys[i]);
    }

    let srtKeys = srtMatrix.keys();
    for (let i = 0; i < srtKeys.length; i++) {
        srtMatrix.delete(srtKeys[i]);
    }
}

/**
 * Add a directed edge to the adjacency graph.
 */
export function addAdjacency(from: string, to: string): void {
    if (!adjacency.has(from)) {
        adjacency.set(from, [to]);
    } else {
        let neighbors = adjacency.get(from);
        if (neighbors.indexOf(to) == -1) {
            neighbors.push(to);
        }
    }
}

/**
 * Add a segment run time (SRT) for a specific edge.
 */
export function addSRT(from: string, to: string, value: f64): void {
    srtMatrix.set(from + "|" + to, value);
}

/**
 * Retrieve the SRT between two stops (bi-directional check).
 * Returns -1.0 if not found.
 */
export function getSRT(from: string, to: string): f64 {
    let key = from + "|" + to;
    if (srtMatrix.has(key)) return srtMatrix.get(key);
    let revKey = to + "|" + from;
    if (srtMatrix.has(revKey)) return srtMatrix.get(revKey);
    return -1.0;
}

/**
 * Find the shortest path between two stops using BFS.
 * Returns an array of stop IDs or null if no path exists.
 */
export function findPath(start: string, end: string): string[] | null {
    if (start == end) return [start];
    if (!adjacency.has(start)) return null;

    let queue = new Array<string[]>();
    queue.push([start]);

    // Use a map to track visited nodes since AS doesn't have a built-in Set in all versions
    let visited = new Map<string, boolean>();
    visited.set(start, true);

    while (queue.length > 0) {
        let currentPath = queue.shift();
        let currentStop = currentPath[currentPath.length - 1];

        if (adjacency.has(currentStop)) {
            let neighbors = adjacency.get(currentStop);
            for (let i = 0, len = neighbors.length; i < len; i++) {
                let neighbor = neighbors[i];
                if (!visited.has(neighbor)) {
                    if (neighbor == end) {
                        let newPath = currentPath.slice();
                        newPath.push(neighbor);
                        return newPath;
                    }
                    visited.set(neighbor, true);
                    let newPath = currentPath.slice();
                    newPath.push(neighbor);
                    queue.push(newPath);
                }
            }
        }
    }

    return null;
}

/**
 * Interpolate times for stops between start and end based on EMU/SRT values.
 * Returns an array of UNIX timestamps (seconds).
 */
export function interpolateTimes(
    startDepartureTime: i32,
    endArrivalTime: i32,
    emus: f64[]
): i32[] {
    let totalTimeDiff = endArrivalTime - startDepartureTime;
    let totalEmu: f64 = 0;
    for (let i = 0; i < emus.length; i++) {
        totalEmu += emus[i];
    }

    let resultCount = emus.length - 1;
    if (resultCount < 0) return [];

    let result = new Array<i32>(resultCount);
    let accumulatedEmu: f64 = 0;

    for (let i = 0; i < resultCount; i++) {
        accumulatedEmu += emus[i];
        let offset = totalEmu > 0 ? (accumulatedEmu / totalEmu) * (totalTimeDiff as f64) : 0;
        result[i] = startDepartureTime + (Math.floor(offset) as i32);
    }

    return result;
}
