/** Return intermediate stop times, weighted by the run time of each segment. */
export function interpolateTimes(start: number, end: number, weights: readonly number[]): number[] {
	const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
	const result: number[] = [];
	let accumulatedWeight = 0;
	for (let i = 0; i < weights.length - 1; i++) {
		accumulatedWeight += weights[i];
		const offset = totalWeight > 0 ? (accumulatedWeight / totalWeight) * (end - start) : 0;
		result.push(start + Math.floor(offset));
	}
	return result;
}
