import fs from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { TRAX_CONFIG } from "../config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function hasDataFile(filePath: string): boolean {
	try {
		getDataFilePath(filePath);
		return true;
	} catch {
		return false;
	}
}

export function loadDataFile(filePath: string): string {
	const path = getDataFilePath(filePath);
	return fs.readFileSync(path, "utf-8");
}

export function writeDataFile(filePath: string, data: string): void {
	const fullPath = getDataFilePath(filePath);
	fs.writeFileSync(fullPath, data, "utf-8");
}

export async function loadDataFileAsync(filePath: string): Promise<string> {
	const candidates = [
		filePath,
		path.join(__dirname, "data", filePath),
		path.join(__dirname, "..", "data", filePath),
		path.join(__dirname, "..", "..", "data", filePath),
	];
	const actual: string[] = [];
	const promises: Promise<any>[] = [];
	for (const p of candidates)
		promises.push(
			fs.promises
				.access(p)
				.then(() => actual.push(p))
				.catch(() => {}),
		);
	await Promise.all(promises);
	if (actual.length > 0) return fs.promises.readFile(actual[0], "utf-8");
	throw new Error(`Data file not found: ${filePath}`);
}

export function getDataFilePath(filePath: string): string {
	const candidates = [
		path.join(__dirname, "..", "..", "data", filePath),
		path.join(__dirname, "..", "data", filePath),
		path.join(__dirname, "data", filePath),
		filePath,
	];
	for (const p of candidates)
		if (fs.existsSync(p)) {
			return p;
		}
	throw new Error(`Data file not found: ${filePath}`);
}

export function getCacheFilePath(filePath: string): string {
	return path.join(TRAX_CONFIG.cacheDir, filePath);
}

export function loadCacheFile(filePath: string): string {
	const path = getCacheFilePath(filePath);
	return fs.readFileSync(path, "utf-8");
}

export function loadCacheFileAsync(filePath: string): Promise<string> {
	const path = getCacheFilePath(filePath);
	return fs.promises.readFile(path, "utf-8");
}

export function cacheFileExists(filePath: string): boolean {
	const path = getCacheFilePath(filePath);
	return fs.existsSync(path);
}

export function writeCacheFile(filePath: string, data: string): void {
	const fullPath = getCacheFilePath(filePath);
	fs.writeFileSync(fullPath, data, "utf-8");
}

export default {
	loadDataFile,
	getDataFilePath,
	writeDataFile,
	loadDataFileAsync,
	getCacheFilePath,
	loadCacheFile,
	loadCacheFileAsync,
	cacheFileExists,
	writeCacheFile,
};
