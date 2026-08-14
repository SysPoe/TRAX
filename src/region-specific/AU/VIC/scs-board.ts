import { parse } from "node-html-parser";
import type { VLineScsBoardRow } from "./types.js";

const clean = (value: string | null | undefined) => value?.replace(/\s+/g, " ").trim() ?? "";

function parseDepartingIn(value: string): number | null {
	if (!value) return null;
	const hours = /(?:^|\s)(\d+)\s*h\b/i.exec(value)?.[1];
	const minutes = /(?:^|\s)(\d+)\s*m(?:in)?\b/i.exec(value)?.[1];
	if (!hours && !minutes) return /^now$/i.test(value) ? 0 : null;
	return (Number(hours ?? 0) * 60 + Number(minutes ?? 0)) * 60;
}

function platform(value: string) {
	if (/\b(?:coach\s*)?bay\b/i.test(value) || Number(/\d+/.exec(value)?.[0]) > 16) return null;
	return value.replace(/^\s*Platform\s*/i, "").trim() || null;
}

function normalRow(element: ReturnType<typeof parse>, boardGroup: string | null): VLineScsBoardRow | null {
	const time = clean(element.querySelector(".departure-time")?.text);
	const destination = clean(element.querySelector(".destination-name")?.text);
	const platformValue = platform(clean(element.querySelector(".platform")?.text));
	if (!/^\d{1,2}:\d{2}$/.test(time) || !destination || !platformValue) return null;
	const departingIn = clean(element.querySelector(".departing-in")?.text) || null;
	return {
		time: time.padStart(5, "0"), destination, boardGroup, coachesFrom: null,
		platform: platformValue, boardingKind: "platform",
		departingIn, departingInSeconds: parseDepartingIn(departingIn ?? ""),
		cancelled: /service cancelled/i.test(element.text),
	};
}

export function parseVLineScsBoard(html: string): VLineScsBoardRow[] {
	const document = parse(html);
	const rows: VLineScsBoardRow[] = [];
	const seen = new Set<string>();
	for (const module of document.querySelectorAll("tr.rowModule")) {
		const main = module.querySelector("table.main-module");
		if (!main) continue;
		const boardGroup = clean(main.querySelector(".mdeparture-destination")?.text) || null;
		const cancellation = clean(main.querySelector(".mcocancalation")?.text);
		const mainPlatform = platform(clean(main.querySelector(".mPlatform")?.text));
		const time = clean(main.querySelector(".mdepartuertime")?.text);
		const destination = clean(main.querySelector(".mtowardsdes")?.text).replace(/^towards\s+/i, "");
		const coachesFrom = clean(/\bcoaches?\s+from\s+(.+)$/i.exec(cancellation)?.[1]) || null;
		if (mainPlatform && !/replaced by coaches/i.test(cancellation) && /^\d{1,2}:\d{2}$/.test(time) && destination) {
			const departingIn = clean(main.querySelector(".mDepMin")?.text) || null;
			const row: VLineScsBoardRow = {
				time: time.padStart(5, "0"), destination, boardGroup, coachesFrom,
				platform: mainPlatform, boardingKind: "platform",
				departingIn, departingInSeconds: parseDepartingIn(departingIn ?? ""),
				cancelled: /service cancelled/i.test(main.text),
			};
			const key = `${row.time}\0${row.destination}`;
			if (!seen.has(key)) { rows.push(row); seen.add(key); }
		}
		for (const child of module.querySelectorAll("table.sub-module.shownormal")) {
			const row = normalRow(child, boardGroup);
			if (!row) continue;
			const key = `${row.time}\0${row.destination}`;
			if (!seen.has(key)) { rows.push(row); seen.add(key); }
		}
	}
	return rows;
}

export async function getVLineScsBoard(
	url = "https://www.vline.com.au/scs-departures",
	timeoutMs = 15_000,
): Promise<VLineScsBoardRow[]> {
	const response = await fetch(url, {
		signal: AbortSignal.timeout(timeoutMs),
		headers: { accept: "text/html", "user-agent": "TRAX/0.1 (+official V/Line departure-board integration)" },
	});
	if (!response.ok) throw new Error(`V/Line Southern Cross board HTTP ${response.status}`);
	return parseVLineScsBoard(await response.text());
}
