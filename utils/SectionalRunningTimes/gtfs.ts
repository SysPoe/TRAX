// Sectional Running Times data for QR's rail network

import { getStations } from "../stations.js";
import logger from "../logger.js";
import { CacheContext } from "../../cache.js";
import { loadDataFile } from "../fs.js";

let rawSRT = loadDataFile("SRT_gtfs.csv");

export type SRTMatrix = {
	[from: string]: {
		[to: string]: number;
	};
};

function parseSRTtoMatrix(srtString: string, ctx?: CacheContext): SRTMatrix {
	const stations = getStations(ctx);

	const lines = srtString.trim().split("\n");
	const startIdx = lines[0].startsWith("From,To,EMU") ? 1 : 0;
	const matrix: SRTMatrix = {};

	for (let i = startIdx; i < lines.length; i++) {
		let [from, to, emu] = lines[i].split(",");

		if (from === "Exhibition") from = "place_exhsta";
		else
			from =
				stations.find((v) => v.stop_name?.toLowerCase().trim().startsWith(from.toLowerCase().trim()))
					?.stop_id ?? "";

		if (to === "Exhibition") to = "place_exhsta";
		else
			to =
				stations.find((v) => v.stop_name?.toLowerCase().trim().startsWith(to.toLowerCase().trim()))?.stop_id ??
				"";

		if (!from || from.length === 0) {
			logger.warn(`Invalid SRT from: ${lines[i]}`, {
				module: "srt",
				function: "parseSRTtoMatrix",
			});
			continue;
		}
		if (!to || to.length === 0) {
			logger.warn(`Invalid SRT to: ${lines[i]}`, {
				module: "srt",
				function: "parseSRTtoMatrix",
			});
			continue;
		}

		if (!matrix[from]) matrix[from] = {};
		matrix[from][to] = Number(emu);
	}
	return matrix;
}

let _matrix: SRTMatrix;

function getSRTMatrix(ctx?: CacheContext): SRTMatrix {
	if (!_matrix) {
		_matrix = parseSRTtoMatrix(rawSRT, ctx);
	}
	return _matrix;
}

export function getSRT(from: string, to: string, ctx?: CacheContext): number | undefined {
	let matrix = getSRTMatrix(ctx);
	if ((from == "place_exhsta" && to == "place_bowsta") || (from == "place_bowsta" && to == "place_exhsta")) return 3; // Exhibition to Bowen Hills is 3 minutes, but not in the SRT data
	return matrix[from]?.[to] || matrix[to]?.[from];
}
