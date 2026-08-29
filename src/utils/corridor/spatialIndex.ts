import { latitudeDistanceMeters, longitudeDistanceMeters } from "./geometry.js";

export interface SpatialPoint<T = string> {
	id: T;
	lat: number;
	lon: number;
}

/**
 * A small latitude and longitude grid for local shape projection. It returns
 * candidates from an expanded box and does not make geographic accuracy claims.
 */
export class CoordinateGridIndex<T = string> {
	private readonly cells = new Map<string, SpatialPoint<T>[]>();
	private readonly cellSizeDegrees: number;

	constructor(cellSizeMeters = 250) {
		this.cellSizeDegrees = cellSizeMeters / 111_320;
	}

	add(point: SpatialPoint<T>): void {
		if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon)) return;
		const key = this.key(point.lat, point.lon);
		const cell = this.cells.get(key) ?? [];
		cell.push(point);
		this.cells.set(key, cell);
	}

	queryBounds(minLat: number, maxLat: number, minLon: number, maxLon: number): SpatialPoint<T>[] {
		const results: SpatialPoint<T>[] = [];
		const seen = new Set<T>();
		const minX = Math.floor(minLon / this.cellSizeDegrees);
		const maxX = Math.floor(maxLon / this.cellSizeDegrees);
		const minY = Math.floor(minLat / this.cellSizeDegrees);
		const maxY = Math.floor(maxLat / this.cellSizeDegrees);
		for (let y = minY; y <= maxY; y++) {
			for (let x = minX; x <= maxX; x++) {
				for (const point of this.cells.get(`${x}:${y}`) ?? []) {
					if (seen.has(point.id)) continue;
					seen.add(point.id);
					if (point.lat >= minLat && point.lat <= maxLat && point.lon >= minLon && point.lon <= maxLon) {
						results.push(point);
					}
				}
			}
		}
		return results;
	}

	querySegment(
		a: { lat: number; lon: number },
		b: { lat: number; lon: number },
		expandedMeters: number,
	): SpatialPoint<T>[] {
		return this.querySegmentCoordinates(a.lat, a.lon, b.lat, b.lon, expandedMeters);
	}

	querySegmentCoordinates(
		aLat: number,
		aLon: number,
		bLat: number,
		bLon: number,
		expandedMeters: number,
	): SpatialPoint<T>[] {
		const latitude = (aLat + bLat) / 2;
		const latExpansion = expandedMeters / 111_320;
		const lonScale = Math.max(0.01, Math.cos((latitude * Math.PI) / 180));
		const lonExpansion = expandedMeters / (111_320 * lonScale);
		return this.queryBounds(
			Math.min(aLat, bLat) - latExpansion,
			Math.max(aLat, bLat) + latExpansion,
			Math.min(aLon, bLon) - lonExpansion,
			Math.max(aLon, bLon) + lonExpansion,
		);
	}

	private key(lat: number, lon: number): string {
		return `${Math.floor(lon / this.cellSizeDegrees)}:${Math.floor(lat / this.cellSizeDegrees)}`;
	}
}

export const _test = { latitudeDistanceMeters, longitudeDistanceMeters };
