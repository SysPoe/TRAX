import { parse } from "node-html-parser";
import type { CacheContext } from "../../../../cache/types.js";
import { getPluginState } from "../../../../plugins/types.js";
import type {
	VehicleFormationUnit,
	VehiclePublishedProfile,
	VehiclePublishedSection,
} from "../../../../utils/vehicleModel.js";
import { cacheFileExists, loadCacheFile, writeCacheFileAtomic } from "../../../../utils/fs.js";
import type { QRTTravelTrip } from "./types.js";

const CONTENT_URL = "https://www.queenslandrailtravel.com.au/SPWebApp/api/ContentQuery/GetItems";
const PROFILE_SOURCE_URL = "https://www.queenslandrailtravel.com.au/Railexperiences/ourtrains";
const CACHE_FILE = "region-specific/seq/qrt-published-formations.json";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const STATE_ID = "au-seq-qrt-published-formations";

const CONTENT_QUERY = {
	WebUrl: "/",
	ListName: "Dynamic train tiles",
	ViewFields: ["Title", "ShowOnPage", "qrt_trainLogo", "qrt_colour", "qrt_HtmlContent", "qrt_ordernumber"],
	Filters: [{ Field: "ShowOnPage", Operand: "Eq", FieldType: "Lookup", LookupId: true, Values: [30] }],
	OrderByClauses: [{ Field: "qrt_ordernumber", Direction: "Asc" }],
};

export type PublishedFormation = {
	matchName: string;
	profile: VehiclePublishedProfile;
	units: VehicleFormationUnit[];
	observedAt: string;
};

type PublishedCache = {
	fetchedAt: number;
	formations: PublishedFormation[];
};

type PublishedState = {
	cache: PublishedCache | null;
	inFlight: Promise<PublishedCache | null> | null;
};

type HeadingSegment = { heading: string; body: string };

function text(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function splitByHeading(html: string, level: 3 | 4): { prefix: string; segments: HeadingSegment[] } {
	const expression = new RegExp(`<h${level}\\b[^>]*>([\\s\\S]*?)<\\/h${level}>`, "gi");
	const matches = [...html.matchAll(expression)];
	return {
		prefix: html.slice(0, matches[0]?.index ?? html.length),
		segments: matches.map((match, index) => ({
			heading: parse(match[1]).innerText.replace(/\s+/g, " ").trim(),
			body: html.slice((match.index ?? 0) + match[0].length, matches[index + 1]?.index ?? html.length),
		})),
	};
}

function removeAccessibilityText(value: string): string {
	return value
		.replace(/For (?:additional )?information on accessible (?:facilities|travel)[\s\S]*$/i, "")
		.replace(/For information on accessibility[\s\S]*$/i, "")
		.trim();
}

function textBlocks(html: string): string[] {
	const root = parse(html.replace(/<br\b[^>]*>|<\/(?:p|li|div|h[1-6])\s*>/gi, "\n"));
	root.querySelectorAll("style,script,img").forEach((element) => element.remove());
	return root.innerText
		.split(/\n+/)
		.map((line) => removeAccessibilityText(line.replace(/\s+/g, " ").trim()))
		.filter((line) => line.length > 0 && !/^For (?:additional )?information on accessible/i.test(line));
}

function excludedHeading(heading: string): boolean {
	return /accessib|assistance animal|travelling with (?:a )?carer/i.test(heading);
}

function sectionsForBody(body: string): VehiclePublishedSection[] {
	const split = splitByHeading(body, 4);
	const sections: VehiclePublishedSection[] = [];
	const overview = textBlocks(split.prefix);
	if (overview.length) sections.push({ title: "Overview", details: overview });
	for (const segment of split.segments) {
		if (!segment.heading || excludedHeading(segment.heading)) continue;
		const details = textBlocks(segment.body);
		if (details.length) sections.push({ title: segment.heading, details });
	}
	return sections;
}

function unitSeats(sections: readonly VehiclePublishedSection[]): number | null {
	const description = sections.flatMap((section) => section.details).join(" ");
	const twinAndSingle = /contains\s+(\d+)\s+Twin Sleepers?\s+and\s+(\d+)\s+Single Sleepers?/i.exec(description);
	if (twinAndSingle) return Number(twinAndSingle[1]) * 2 + Number(twinAndSingle[2]);
	const direct = /contains\s+(\d+)\s+(?:Economy\s+|Business\s+)?(?:Seats?|RailBeds?|Single Sleepers?)/i.exec(
		description,
	);
	if (direct) return Number(direct[1]);
	const lounge = /There are\s+(\d+)\s+seats/i.exec(description);
	if (lounge) return Number(lounge[1]);
	const tables = /There are\s+(\d+)\s+tables[\s\S]*?seating(?: up to)?\s+(\d+)/i.exec(description);
	if (tables) return Number(tables[1]) * Number(tables[2]);
	return null;
}

function unitKind(title: string, sections: readonly VehiclePublishedSection[]): VehicleFormationUnit["diagramKind"] {
	const description = `${title} ${sections.map((section) => section.title).join(" ")}`;
	if (/Sleeper|RailBed/i.test(description)) return "sleeper";
	if (/Cafe|Restaurant|Rest|Lounge/i.test(description)) return "diner";
	return "coach";
}

function profileMatchName(title: string): string {
	return title
		.split(" - ")[0]
		.replace(/^The\s+/i, "")
		.trim();
}

function parsePublishedItem(value: unknown, observedAt: string): PublishedFormation | null {
	const item = record(value);
	const title = text(item?.Title);
	const html = text(item?.qrt_HtmlContent);
	if (!title || !html) return null;
	const accentColor = text(item?.qrt_colour);
	const logoHtml = text(item?.qrt_trainLogo);
	const logoSrc = logoHtml ? (parse(logoHtml).querySelector("img")?.getAttribute("src") ?? null) : null;
	const split = splitByHeading(html, 3);
	const units: VehicleFormationUnit[] = [];
	let profileSections: VehiclePublishedSection[] = [];
	for (const segment of split.segments) {
		if (!segment.heading || /^Tour our train$/i.test(segment.heading)) continue;
		const sections = sectionsForBody(segment.body);
		if (/^Train Consist$/i.test(segment.heading)) {
			profileSections = sections.map((section) =>
				section.title === "Overview" ? { ...section, title: "Train consist" } : section,
			);
			continue;
		}
		const carriage = /^Carriage\s+(.+)$/i.exec(segment.heading);
		units.push({
			id: carriage?.[1]?.trim() ?? null,
			diagramKind: unitKind(segment.heading, sections),
			type: sections.find((section) => section.title !== "Overview")?.title ?? null,
			manufacturer: null,
			model: segment.heading,
			seats: unitSeats(sections),
			bicycles: null,
			accessible: null,
			wifi: null,
			powerOutlets: null,
			accentColor,
			publishedSections: sections,
		});
	}
	return {
		matchName: profileMatchName(title),
		profile: {
			title,
			logoUrl: logoSrc ? new URL(logoSrc, PROFILE_SOURCE_URL).href : null,
			accentColor,
			sections: profileSections,
			sourceUrl: PROFILE_SOURCE_URL,
		},
		units,
		observedAt,
	};
}

export function parseQrtPublishedFormations(
	payload: unknown,
	observedAt = new Date().toISOString(),
): PublishedFormation[] {
	let items = payload;
	if (typeof items === "string") {
		try {
			items = JSON.parse(items);
		} catch {
			return [];
		}
	}
	return Array.isArray(items)
		? items
				.map((item) => parsePublishedItem(item, observedAt))
				.filter((item): item is PublishedFormation => item !== null)
		: [];
}

function loadDiskCache(ctx: CacheContext): PublishedCache | null {
	try {
		if (!cacheFileExists(CACHE_FILE, ctx.config.cacheDir)) return null;
		const cache = JSON.parse(loadCacheFile(CACHE_FILE, ctx.config.cacheDir)) as PublishedCache;
		return Number.isFinite(cache.fetchedAt) && Array.isArray(cache.formations) ? cache : null;
	} catch {
		return null;
	}
}

function stateFor(ctx: CacheContext): PublishedState {
	return getPluginState(ctx, STATE_ID, () => ({ cache: loadDiskCache(ctx), inFlight: null }));
}

async function refreshProfiles(ctx: CacheContext, stale: PublishedCache | null): Promise<PublishedCache | null> {
	try {
		const response = await fetch(CONTENT_URL, {
			method: "POST",
			signal: AbortSignal.timeout(ctx.config.requestTimeoutMs),
			headers: { accept: "application/json", "content-type": "application/json" },
			body: JSON.stringify(CONTENT_QUERY),
		});
		if (!response.ok) throw new Error(`QRT published profile HTTP ${response.status}`);
		const fetchedAt = Date.now();
		const formations = parseQrtPublishedFormations(await response.json(), new Date(fetchedAt).toISOString());
		if (!formations.length) throw new Error("QRT published profile response was empty");
		const cache = { fetchedAt, formations };
		try {
			writeCacheFileAtomic(CACHE_FILE, JSON.stringify(cache), ctx.config.cacheDir);
		} catch {
			// A read-only cache directory must not suppress live profile data.
		}
		return cache;
	} catch {
		return stale;
	}
}

async function allProfiles(ctx: CacheContext): Promise<PublishedFormation[]> {
	const state = stateFor(ctx);
	if (state.cache && Date.now() - state.cache.fetchedAt < CACHE_TTL_MS) return state.cache.formations;
	if (!state.inFlight) {
		state.inFlight = refreshProfiles(ctx, state.cache).then((cache) => {
			state.cache = cache;
			state.inFlight = null;
			return cache;
		});
	}
	return (await state.inFlight)?.formations ?? [];
}

function normalizeName(value: string): string {
	return value
		.toLowerCase()
		.replace(/^the\s+/, "")
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

export function matchQrtPublishedFormation(
	service: Pick<QRTTravelTrip, "line" | "serviceName">,
	formations: readonly PublishedFormation[],
): PublishedFormation | null {
	const serviceName = normalizeName(`${service.line} ${service.serviceName}`);
	const matches = formations.filter((formation) => serviceName.includes(normalizeName(formation.matchName)));
	return matches.length === 1 ? matches[0] : null;
}

export async function getQrtPublishedFormation(
	service: Pick<QRTTravelTrip, "line" | "serviceName">,
	ctx: CacheContext,
): Promise<PublishedFormation | null> {
	return matchQrtPublishedFormation(service, await allProfiles(ctx));
}
