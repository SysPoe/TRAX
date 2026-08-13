import { createHmac } from "node:crypto";
import { parse } from "node-html-parser";
import type { VLineJourneyPlannerOptions, VLineJourneyPlannerService } from "./types.js";

const DEFAULT_BASE = "https://api-jp.vline.com.au/Service";

function text(element: ReturnType<typeof parse>, tag: string): string | null {
	const node = element.querySelector(tag.toLowerCase()) ?? element.querySelector(tag) ?? element.querySelector(`a\\:${tag}`);
	if (!node || node.getAttribute("i:nil") === "true") return null;
	const value = node.text.trim();
	return value || null;
}

export function vlineAccessToken(callerId: string, applicationSignature: string, methodName: string): string {
	return createHmac("sha1", applicationSignature).update(callerId + methodName).digest("hex");
}

export function parseVLinePlatformServices(xml: string): VLineJourneyPlannerService[] {
	const document = parse(xml.replace(/(<\/?)[a-zA-Z]+:/g, "$1").replace(/\s+[a-zA-Z]+:([\w-]+)=/g, " $1="), { lowerCaseTagName: false });
	const fault = document.querySelector("fault");
	if (fault) throw new Error(document.querySelector("reason")?.text.trim() || "V/Line Journey Planner returned a fault");
	return document.querySelectorAll("platformservice").map((service): VLineJourneyPlannerService => {
		const direction = text(service, "Direction");
		const count = Number.parseInt(text(service, "ConsistCount") ?? "", 10);
		const vehicles = text(service, "ConsistVehicles")
			?.split(/[,;|\s-]+/)
			.map((value) => value.trim())
			.filter(Boolean) ?? null;
		return {
			origin: text(service, "Origin"),
			destination: text(service, "Destination"),
			scheduledDepartureTime: text(service, "ScheduledDepartureTime") ?? "",
			scheduledDestinationArrivalTime: text(service, "ScheduledDestinationArrivalTime"),
			tdn: text(service, "ServiceIdentifier") ?? "",
			platform: text(service, "Platform"),
			direction: direction === "U" ? "Up" : direction === "D" ? "Down" : null,
			consistSubtype: text(service, "ConsistSubType"),
			consistCount: Number.isFinite(count) && count > 0 ? count : null,
			consistVehicles: vehicles?.length ? vehicles : null,
			isLiveConsistInfo: text(service, "IsLiveConsistInfo")?.toLowerCase() === "true",
			serviceStatus: text(service, "ServiceStatus"),
		};
	}).filter((service) => service.tdn && service.scheduledDepartureTime);
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
