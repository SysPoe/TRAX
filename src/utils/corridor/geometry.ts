const METERS_PER_DEGREE_LATITUDE = 111_320;

/** Convert a latitude difference to metres. */
export function latitudeDistanceMeters(deltaLatitude: number): number {
	return Math.abs(deltaLatitude) * METERS_PER_DEGREE_LATITUDE;
}

/** Convert a longitude difference to metres at a latitude. */
export function longitudeDistanceMeters(deltaLongitude: number, latitude: number): number {
	return Math.abs(deltaLongitude) * METERS_PER_DEGREE_LATITUDE * Math.cos((latitude * Math.PI) / 180);
}

/** Return the approximate distance between two WGS84 coordinates. */
export function coordinateDistanceMeters(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
	const latitude = (a.lat + b.lat) / 2;
	const north = (b.lat - a.lat) * METERS_PER_DEGREE_LATITUDE;
	const east = (b.lon - a.lon) * METERS_PER_DEGREE_LATITUDE * Math.cos((latitude * Math.PI) / 180);
	return Math.hypot(north, east);
}

/** Measure each leg of a coordinate polyline and its total length. */
export function cumulativePolylineDistance(points: readonly { lat: number; lon: number }[]): {
	legMeters: number[];
	cumulativeMeters: number[];
	lengthMeters: number;
} {
	const legMeters: number[] = [];
	const cumulativeMeters = [0];
	for (let index = 1; index < points.length; index++) {
		const distance = coordinateDistanceMeters(points[index - 1], points[index]);
		legMeters.push(distance);
		cumulativeMeters.push(cumulativeMeters[index - 1] + distance);
	}
	return {
		legMeters,
		cumulativeMeters,
		lengthMeters: cumulativeMeters.at(-1) ?? 0,
	};
}

/** Normalize a station name for alias matching. */
export function normalizeStationName(value: string): string {
	return value
		.toLocaleLowerCase()
		.replace(/\brailway\b/g, " ")
		.replace(/\bstation\b/g, " ")
		.replace(/[().,&]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}
