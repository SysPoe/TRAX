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

/**
 * Filter and sort departure indices based on timestamps.
 * Returns an array of original indices.
 */
export function filterAndSortDepartures(
  timestamps: f64[],
  originalIndices: i32[],
  windowStart: f64,
  windowEnd: f64
): i32[] {
  let filteredIndices = new Array<i32>();
  let filteredTimestamps = new Array<f64>();

  for (let i = 0, len = timestamps.length; i < len; i++) {
    let ts = timestamps[i];
    if (ts >= windowStart && ts <= windowEnd) {
      filteredIndices.push(originalIndices[i]);
      filteredTimestamps.push(ts);
    }
  }

  // Sort the filtered results based on timestamps
  if (filteredIndices.length > 1) {
    quickSort(filteredIndices, filteredTimestamps, 0, filteredIndices.length - 1);
  }

  return filteredIndices;
}

function quickSort(indices: i32[], timestamps: f64[], left: i32, right: i32): void {
  if (left < right) {
    let pivotIndex = partition(indices, timestamps, left, right);
    quickSort(indices, timestamps, left, pivotIndex - 1);
    quickSort(indices, timestamps, pivotIndex + 1, right);
  }
}

function partition(indices: i32[], timestamps: f64[], left: i32, right: i32): i32 {
  let pivot = timestamps[right];
  let i = left - 1;
  for (let j = left; j < right; j++) {
    if (timestamps[j] < pivot) {
      i++;
      swap(indices, i, j);
      swapF64(timestamps, i, j);
    }
  }
  swap(indices, i + 1, right);
  swapF64(timestamps, i + 1, right);
  return i + 1;
}

function swap(arr: i32[], i: i32, j: i32): void {
  let temp = arr[i];
  arr[i] = arr[j];
  arr[j] = temp;
}

function swapF64(arr: f64[], i: i32, j: i32): void {
  let temp = arr[i];
  arr[i] = arr[j];
  arr[j] = temp;
}
