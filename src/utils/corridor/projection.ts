import { coordinateDistanceMeters } from "./geometry.js";

export interface SegmentProjection {
	segmentFraction: number;
	lateralDistanceMeters: number;
}

export function projectCoordinatesOnSegment(
	pointLat: number,
	pointLon: number,
	aLat: number,
	aLon: number,
	bLat: number,
	bLon: number,
): SegmentProjection {
	const latitude = (pointLat + aLat + bLat) / 3;
	const longitudeScale = Math.max(0.01, Math.cos((latitude * Math.PI) / 180));
	const scale = 111_320;
	const px = (pointLon - aLon) * scale * longitudeScale;
	const py = (pointLat - aLat) * scale;
	const bx = (bLon - aLon) * scale * longitudeScale;
	const by = (bLat - aLat) * scale;
	const denominator = bx * bx + by * by;
	if (denominator <= Number.EPSILON) {
		return { segmentFraction: 0, lateralDistanceMeters: Math.hypot(px, py) };
	}
	const fraction = Math.max(0, Math.min(1, (px * bx + py * by) / denominator));
	const projectedX = bx * fraction;
	const projectedY = by * fraction;
	return {
		segmentFraction: fraction,
		lateralDistanceMeters: Math.hypot(px - projectedX, py - projectedY),
	};
}

/** Project one coordinate onto a segment in a local equirectangular plane. */
export function projectPointOnSegment(
	point: { lat: number; lon: number },
	a: { lat: number; lon: number },
	b: { lat: number; lon: number },
): SegmentProjection {
	return projectCoordinatesOnSegment(point.lat, point.lon, a.lat, a.lon, b.lat, b.lon);
}

/** Project a coordinate onto every segment and retain the closest positions. */
export function projectPointOnPolyline(
	point: { lat: number; lon: number },
	polyline: readonly { lat: number; lon: number }[],
	cumulativeMeters: readonly number[],
	maxResults = 3,
): Array<SegmentProjection & { segmentIndex: number; distanceAlongMeters: number }> {
	const candidates: Array<SegmentProjection & { segmentIndex: number; distanceAlongMeters: number }> = [];
	for (let segmentIndex = 0; segmentIndex < polyline.length - 1; segmentIndex++) {
		const start = polyline[segmentIndex];
		const end = polyline[segmentIndex + 1];
		const projection = projectPointOnSegment(point, start, end);
		const segmentLength = coordinateDistanceMeters(start, end);
		candidates.push({
			...projection,
			segmentIndex,
			distanceAlongMeters: cumulativeMeters[segmentIndex] + projection.segmentFraction * segmentLength,
		});
	}
	candidates.sort((a, b) => a.lateralDistanceMeters - b.lateralDistanceMeters);
	return candidates.slice(0, maxResults);
}

export const _test = { projectPointOnSegment, projectPointOnPolyline };
