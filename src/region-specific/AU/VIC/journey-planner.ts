import { createHmac } from "node:crypto";
import { parse } from "node-html-parser";
import type {
	VLineBookingAvailability,
	VLineJourneyPlannerOptions,
	VLineJourneyPlannerService,
} from "./types.js";

const DEFAULT_BASE = "https://api-jp.vline.com.au/Service";

function text(element: ReturnType<typeof parse>, tag: string): string | null {
	const node = element.querySelector(tag.toLowerCase()) ?? element.querySelector(tag) ?? element.querySelector(`a\\:${tag}`);
	if (!node || node.getAttribute("i:nil") === "true") return null;
	const value = node.text.trim();
	return value || null;
}

function number(element: ReturnType<typeof parse>, tag: string): number | null {
	const value = Number.parseInt(text(element, tag) ?? "", 10);
	return Number.isFinite(value) && value >= 0 ? value : null;
}

function boolean(element: ReturnType<typeof parse>, tag: string): boolean {
	return text(element, tag)?.toLowerCase() === "true";
}

function list(element: ReturnType<typeof parse>, tag: string, separator = /[,;|\s-]+/): string[] {
	return text(element, tag)?.split(separator).map((value) => value.trim()).filter(Boolean) ?? [];
}

function parseService(element: ReturnType<typeof parse>, journeyLeg: boolean): VLineJourneyPlannerService {
	const direction = text(element, journeyLeg ? "ServiceDirection" : "Direction");
	return {
		origin: text(element, "Origin"),
		destination: text(element, "Destination"),
		scheduledDepartureTime: text(element, journeyLeg ? "DepartureTime" : "ScheduledDepartureTime") ?? "",
		scheduledDestinationArrivalTime: text(element, journeyLeg ? "ArrivalTime" : "ScheduledDestinationArrivalTime"),
		tdn: text(element, "ServiceIdentifier") ?? "",
		platform: text(element, "Platform"),
		direction: direction === "U" || direction?.toLowerCase() === "up" ? "Up"
			: direction === "D" || direction?.toLowerCase() === "down" ? "Down" : null,
		consistSubtype: text(element, "ConsistSubType"),
		consistCount: number(element, "ConsistCount"),
		consistVehicles: list(element, "ConsistVehicles").length ? list(element, "ConsistVehicles") : null,
		isLiveConsistInfo: boolean(element, "IsLiveConsistInfo"),
		serviceStatus: text(element, "ServiceStatus"),
		consistDescription: text(element, "ConsistDescription"),
		accessibleSpaces: number(element, "DesignatedAccessibilitySpaceCount"),
		bicycleSpaces: number(element, "DesignatedBikeSpaceCount"),
		reservationAvailable: boolean(element, "ReservationAvailable"),
		reservationRequired: boolean(element, "ReservationRequired"),
		reservedCarriages: list(element, "CarList", /[,;|\s]+/),
		reservedSeatsAvailable: number(element, "EconomyClassSeatsAvailable"),
		unreservedTicketsAvailable: number(element, "UnreservedSeatsAvailable"),
		canBookInJourneyPlanner: boolean(element, "CanBookInJourneyPlanner"),
	};
}

export function vlineAccessToken(callerId: string, applicationSignature: string, methodName: string): string {
	return createHmac("sha1", applicationSignature).update(callerId + methodName).digest("hex");
}

export function parseVLinePlatformServices(xml: string): VLineJourneyPlannerService[] {
	const document = parse(xml.replace(/(<\/?)[a-zA-Z]+:/g, "$1").replace(/\s+[a-zA-Z]+:([\w-]+)=/g, " $1="), { lowerCaseTagName: false });
	const fault = document.querySelector("fault");
	if (fault) throw new Error(document.querySelector("reason")?.text.trim() || "V/Line Journey Planner returned a fault");
	return document.querySelectorAll("platformservice").map((service) => parseService(service, false))
		.filter((service) => service.tdn && service.scheduledDepartureTime);
}

export function parseVLineJourneys(xml: string): VLineJourneyPlannerService[] {
	const document = parse(xml.replace(/(<\/?)[a-zA-Z]+:/g, "$1").replace(/\s+[a-zA-Z]+:([\w-]+)=/g, " $1="), { lowerCaseTagName: false });
	const fault = document.querySelector("fault");
	if (fault) throw new Error(document.querySelector("reason")?.text.trim() || "V/Line Journey Planner returned a fault");
	return document.querySelectorAll("leg").map((leg) => parseService(leg, true))
		.filter((service) => service.tdn && service.scheduledDepartureTime);
}

export async function getVLinePlatformDepartures(
	options: VLineJourneyPlannerOptions,
	location: string,
	direction = "B",
	minutes = 180,
	timeoutMs = 15_000,
): Promise<VLineJourneyPlannerService[]> {
	const method = "JP_GETPLATFORMDEPARTURES";
	const url = new URL(`${options.baseUrl ?? DEFAULT_BASE}/VLinePlatformServices.svc/web/GetPlatformDepartures`);
	url.searchParams.set("LocationName", location);
	url.searchParams.set("Direction", direction);
	url.searchParams.set("minutes", String(minutes));
	url.searchParams.set("CallerID", options.callerId);
	url.searchParams.set("AccessToken", vlineAccessToken(options.callerId, options.applicationSignature, method));
	const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/xml" } });
	if (!response.ok) throw new Error(`V/Line Journey Planner HTTP ${response.status}`);
	return parseVLinePlatformServices(await response.text());
}

export async function getVLineJourneys(
	options: VLineJourneyPlannerOptions,
	location: string,
	destination: string,
	hasPrevious = true,
	timeoutMs = 15_000,
): Promise<VLineJourneyPlannerService[]> {
	const method = "JP_GETNEXTPREVIOUS5JOURNEYS";
	const url = new URL(`${options.baseUrl ?? DEFAULT_BASE}/VLineServices.svc/web/GetNextPrevious5Journeys`);
	url.searchParams.set("LocationName", location);
	url.searchParams.set("DestinationName", destination);
	url.searchParams.set("hasPrevious", String(hasPrevious));
	url.searchParams.set("CallerID", options.callerId);
	url.searchParams.set("AccessToken", vlineAccessToken(options.callerId, options.applicationSignature, method));
	const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/xml" } });
	if (!response.ok) throw new Error(`V/Line Journey Planner HTTP ${response.status}`);
	return parseVLineJourneys(await response.text());
}

function describedCount(element: ReturnType<typeof parse>, selector: string, unit: string): number | null {
	const value = element.querySelector(selector)?.text.match(new RegExp(`(\\d+)\\s+${unit}`, "i"))?.[1];
	return value ? Number.parseInt(value, 10) : null;
}

export function parseVLineBookingPage(
	html: string,
	expected: { tdn: string; scheduledDepartureTime: string; journeyUrl: string; observedAt: string },
): VLineBookingAvailability | null {
	const document = parse(html);
	// The live page contains invalid table markup that node-html-parser reparents out of
	// its journey card. Kentico generates a stable control-id prefix for every leg, so
	// resolve the related fields by that prefix instead of relying on DOM ancestry.
	const serviceInput = document.querySelectorAll("input").find((candidate) =>
		candidate.getAttribute("id")?.endsWith("hdnServiceCode") && candidate.getAttribute("value") === expected.tdn,
	);
	if (!serviceInput) return null;
	const serviceInputId = serviceInput.getAttribute("id")!;
	const prefix = serviceInputId.slice(0, -"hdnServiceCode".length);
	const control = (suffix: string) => document.querySelectorAll(`[id="${prefix}${suffix}"]`)[0] ?? null;
	let ancestor = serviceInput.parentNode;
	while (ancestor && !("classList" in ancestor && ancestor.classList.contains("view-consist-panel"))) ancestor = ancestor.parentNode;
	const panel = ancestor && "querySelector" in ancestor ? ancestor : null;
	const carList = control("hdnCarList")?.getAttribute("value")?.trim() ?? "";
	const reservedCarriages = carList
		.split(/[,;|\s]+/).map((value) => value.trim()).filter(Boolean);
	const reservedRow = control("spnReservedSeatsTrain") ?? panel?.querySelector(".economy-seats") ?? null;
	const unreservedRow = control("spnUnreservedSeats") ?? panel?.querySelector(".unreserved-seats") ?? null;
	const reservedSeatsAvailable = reservedRow ? describedCount(reservedRow, ".description", "seats?") : null;
	const unreservedTicketsAvailable = unreservedRow ? describedCount(unreservedRow, ".description", "tickets?") : null;
	const reservationAvailable = Boolean(reservedRow) || reservedCarriages.length > 0;
	return {
		tdn: expected.tdn,
		reservedCarriages,
		reservedSeatsAvailable,
		unreservedTicketsAvailable,
		reservationAvailable,
		reservationRequired: false,
		seatMapAvailable: Boolean(control("lnbTrainSeats") ?? panel?.querySelector(".viewseats")),
		journeyUrl: expected.journeyUrl,
		observedAt: expected.observedAt,
	};
}

export async function getVLineWebBookingAvailability(
	origin: string,
	destination: string,
	serviceDate: string,
	tdn: string,
	scheduledDepartureTime: string,
	timeoutMs = 15_000,
): Promise<VLineBookingAvailability | null> {
	const url = new URL("https://www.vline.com.au/plan-trip-buy-tickets");
	url.searchParams.set("from", origin);
	url.searchParams.set("to", destination);
	url.searchParams.set("date", `${serviceDate.slice(6, 8)}/${serviceDate.slice(4, 6)}/${serviceDate.slice(0, 4)}`);
	url.searchParams.set("journeypref", "Fastest");
	url.searchParams.set("tformat", "24");
	url.searchParams.set("otimes", "");
	url.searchParams.set("rtimes", "");
	const response = await fetch(url, {
		signal: AbortSignal.timeout(timeoutMs),
		headers: { accept: "text/html", "user-agent": "TRAX/0.1 (+https://github.com/SysPoe/TRAX)" },
	});
	if (!response.ok) throw new Error(`V/Line Journey Planner web HTTP ${response.status}`);
	const observedAt = new Date().toISOString();
	return parseVLineBookingPage(await response.text(), { tdn, scheduledDepartureTime, journeyUrl: url.toString(), observedAt });
}
