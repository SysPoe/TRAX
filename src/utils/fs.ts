import fs from "fs";
import { fileURLToPath } from "url";
import path from "path";

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

export function loadDataFileAsync(filePath: string): Promise<string> {
	return new Promise((res, rej) => {
		const candidates = [
			filePath,
			path.join(__dirname, "data", filePath),
			path.join(__dirname, "..", "data", filePath),
			path.join(__dirname, "..", "..", "data", filePath),
		];
		let resolved = false;
		const promises: Promise<unknown>[] = [];
		for (const p of candidates)
			promises.push(
				fs.promises
					.access(p)
					.then(() => {
						resolved = true;
						fs.promises.readFile(p, "utf-8").then(res).catch(rej);
					})
					.catch(() => {}),
			);
		Promise.all(promises).then(() => {
			if (!resolved) rej(`Data file not found: ${filePath}`);
		});
	});
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

export function getCacheFilePath(filePath: string, cacheDir: string): string {
	// Create cache directory if it doesn't exist
	if (!fs.existsSync(cacheDir)) {
		fs.mkdirSync(cacheDir, { recursive: true });
	}
	// Create filePath parent dir if it doesn't exist
	if (!fs.existsSync(path.join(cacheDir, filePath, ".."))) {
		fs.mkdirSync(path.join(cacheDir, filePath, ".."), {
			recursive: true,
		});
	}
	return path.join(cacheDir, filePath);
}

export function loadCacheFile(filePath: string, cacheDir: string): string {
	const path = getCacheFilePath(filePath, cacheDir);
	return fs.readFileSync(path, "utf-8");
}

export function loadCacheFileAsync(filePath: string, cacheDir: string): Promise<string> {
	const path = getCacheFilePath(filePath, cacheDir);
	return fs.promises.readFile(path, "utf-8");
}

export function cacheFileExists(filePath: string, cacheDir: string): boolean {
	const path = getCacheFilePath(filePath, cacheDir);
	return fs.existsSync(path);
}

export function writeCacheFile(filePath: string, data: string, cacheDir: string): void {
	const fullPath = getCacheFilePath(filePath, cacheDir);
	fs.writeFileSync(fullPath, data, "utf-8");
}

export default {
	loadDataFile,
	getDataFilePath,
	loadDataFileAsync,
	getCacheFilePath,
	loadCacheFile,
	loadCacheFileAsync,
	cacheFileExists,
	writeCacheFile,
};
