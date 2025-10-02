export function timeDiff(t1: string, t2: string): string {
	// t1 and t2 are in 'HH:mm' format
	const [h1, m1] = t1.split(":").map(Number);
	const [h2, m2] = t2.split(":").map(Number);
	let total1 = h1 * 60 + m1;
	let total2 = h2 * 60 + m2;
	let diff = total1 - total2;
	if (diff < 0) diff += 24 * 60; // handle overnight
	const hours = Math.floor(diff / 60);
	const mins = diff % 60;
	return `${hours}h ${mins}m`;
}

export function secTimeDiff(t1: string, t2: string): number {
	// t1 and t2 are in 'HH:mm' format
	const [h1, m1] = t1.split(":").map(Number);
	const [h2, m2] = t2.split(":").map(Number);
	let total1 = h1 * 3600 + m1 * 60;
	let total2 = h2 * 3600 + m2 * 60;
	let diff = total1 - total2;
	if (diff < 0) diff += 24 * 3600; // handle overnight
	return diff;
}

export default { timeDiff, secTimeDiff };
