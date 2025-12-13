import fs from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function loadDataFile(filePath: string): string {
    const path = getDataFilePath(filePath);
    return fs.readFileSync(path, "utf-8");
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
        promises.push(fs.promises.access(p).then(() => actual.push(p)).catch(() => { }));
    await Promise.all(promises);
    if (actual.length > 0)
        return fs.promises.readFile(actual[0], "utf-8");
    throw new Error(`Data file not found: ${filePath}`);
}

export function getDataFilePath(filePath: string): string {
    const candidates = [
        filePath,
        path.join(__dirname, "data", filePath),
        path.join(__dirname, "..", "data", filePath),
        path.join(__dirname, "..", "..", "data", filePath),
    ];
    for (const p of candidates)
        if (fs.existsSync(p)) return p;
    throw new Error(`Data file not found: ${filePath}`);
}

export default {
    loadDataFile,
    getDataFilePath,
};