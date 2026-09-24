import type { CacheContext } from "../../../../cache/types.js";
import logger from "../../../../utils/logger.js";
import {
	QRT_RAIL_SEARCH_URL,
	bookingDate,
	qrtBookingState,
	qrtBookingStationsFor,
	qrtRailServices,
	qrtSearchRequest,
	signedQrtBookingFetch,
	type RailService,
} from "./booking.js";
import {
	fetchQrtSeatMapForCandidate,
	qrtSeatMapOccurrenceKey,
	qrtSeatMapSnapshotObservedAt,
	saveQrtSeatMapSnapshot,
	selectQrtSeatMapFareOption,
} from "./seat-map.js";

// Terminal pairs from Queensland Rail Travel's published timetable. Booking
// search decides which trains actually operate on each date, including changes.
const CORRIDORS = [
	["BNE", "BDB"],
	["BNE", "ROK"],
	["BNE", "CNS"],
	["BNE", "LRE"],
	["BNE", "CTL"],
	["TSV", "ISA"],
] as const;
const SEARCH_DAYS = 4;
const REQUEST_SPACING_MS = 5 * 60 * 1000;
const TICK_MS = 30 * 1000;
const CUTOFF_MS = 60 * 60 * 1000;

type Candidate = { service: RailService; departureAt: number; attemptedAt: number };
type Task =
	| { kind: "search"; key: string; origin: string; destination: string; date: string; score: number }
	| { kind: "map"; key: string; candidate: Candidate; score: number };
type Collector = {
	ctx: CacheContext;
	timer?: ReturnType<typeof setInterval>;
	running: boolean;
	lastRequestAt: number;
	turn: number;
	searches: Map<string, number>;
	candidates: Map<string, Candidate>;
};

const collectors = new Map<string, Collector>();

function noServiceOnDate(status: number, payload: unknown): boolean {
	if (status !== 404 || !payload || typeof payload !== "object") return false;
	const message = (payload as { errorMessage?: unknown }).errorMessage;
	return typeof message === "string" && /services not operating on the date requested/i.test(message);
}

function localDate(now: number, daysAhead: number): string {
	const parts = new Intl.DateTimeFormat("en-GB", {
		timeZone: "Australia/Brisbane",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).formatToParts(new Date(now + daysAhead * 24 * 60 * 60 * 1000));
	const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
	return `${part("year")}-${part("month")}-${part("day")}`;
}

function mapInterval(departureAt: number, now: number): number {
	const remaining = departureAt - now;
	if (remaining <= 2 * 60 * 60 * 1000) return 30 * 60 * 1000;
	if (remaining <= 6 * 60 * 60 * 1000) return 60 * 60 * 1000;
	if (remaining <= 24 * 60 * 60 * 1000) return 4 * 60 * 60 * 1000;
	return 12 * 60 * 60 * 1000;
}

/** Three map turns to one discovery turn, with urgency and overdue age within each lane. */
function chooseTask(collector: Collector, now: number): Task | null {
	const searches: Task[] = [];
	const maps: Task[] = [];
	for (let offset = 0; offset < SEARCH_DAYS; offset++) {
		const date = localDate(now, offset);
		for (const [from, to] of CORRIDORS) {
			for (const [origin, destination] of [
				[from, to],
				[to, from],
			]) {
				const key = `${origin}\0${destination}\0${date}`;
				const last = collector.searches.get(key) ?? 0;
				const interval = offset < 2 ? 6 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
				if (last + interval > now) continue;
				searches.push({
					kind: "search",
					key,
					origin,
					destination,
					date,
					score: (SEARCH_DAYS - offset) * 10 + Math.min(20, (now - last) / interval),
				});
			}
		}
	}
	for (const [key, candidate] of collector.candidates) {
		if (candidate.departureAt <= now + CUTOFF_MS) continue;
		const last = Math.max(candidate.attemptedAt, qrtSeatMapSnapshotObservedAt(collector.ctx, key));
		const interval = mapInterval(candidate.departureAt, now);
		if (last + interval > now) continue;
		maps.push({
			kind: "map",
			key,
			candidate,
			score:
				100 - Math.min(80, (candidate.departureAt - now) / 3_600_000) + Math.min(20, (now - last) / interval),
		});
	}
	const best = (tasks: Task[]) => tasks.sort((left, right) => right.score - left.score)[0] ?? null;
	const search = best(searches);
	const map = best(maps);
	return collector.turn % 4 === 3 ? (search ?? map) : (map ?? search);
}

async function search(collector: Collector, task: Extract<Task, { kind: "search" }>, now: number): Promise<void> {
	const ctx = collector.ctx;
	const booking = qrtBookingState(ctx);
	const stations = await qrtBookingStationsFor(ctx, booking);
	const origin = stations.find((station) => station.code === task.origin);
	const destination = stations.find((station) => station.code === task.destination);
	if (!origin || !destination) throw new Error(`QRT booking station missing for ${task.origin}-${task.destination}`);
	const response = await signedQrtBookingFetch(QRT_RAIL_SEARCH_URL, ctx, booking, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(qrtSearchRequest(origin, destination, bookingDate(`${task.date}T00:00:00`)!)),
	});
	const payload = (await response.json()) as { success?: boolean };
	if (noServiceOnDate(response.status, payload)) {
		collector.searches.set(task.key, now);
		return;
	}
	if (!response.ok) throw new Error(`QRT booking search HTTP ${response.status}`);
	if (payload.success === false) throw new Error("QRT booking search returned an error");
	const services = qrtRailServices(payload);
	for (const service of services) {
		if (!selectQrtSeatMapFareOption(service)) continue;
		const key = qrtSeatMapOccurrenceKey(
			String(service.traiN_NAME ?? ""),
			String(service.traveL_DATE ?? ""),
			String(service.departurE_TIME ?? ""),
			String(service.endregioncode ?? ""),
		);
		if (!key || key.split("\0")[1] !== task.date) continue;
		const departureAt = Date.parse(`${task.date}T${key.split("\0")[2]}:00+10:00`);
		if (!Number.isFinite(departureAt) || departureAt <= now + CUTOFF_MS) continue;
		const previous = collector.candidates.get(key);
		collector.candidates.set(key, { service, departureAt, attemptedAt: previous?.attemptedAt ?? 0 });
	}
	collector.searches.set(task.key, now);
}

async function collectMap(collector: Collector, task: Extract<Task, { kind: "map" }>, now: number): Promise<void> {
	const { candidate } = task;
	candidate.attemptedAt = now;
	const map = await fetchQrtSeatMapForCandidate(candidate.service, task.key, collector.ctx);
	if (map) saveQrtSeatMapSnapshot(collector.ctx, candidate.service, map);
}

async function tick(collector: Collector): Promise<void> {
	const now = Date.now();
	if (collector.running || now - collector.lastRequestAt < REQUEST_SPACING_MS) return;
	const task = chooseTask(collector, now);
	if (!task) return;
	collector.running = true;
	collector.lastRequestAt = now;
	collector.turn++;
	try {
		if (task.kind === "search") await search(collector, task, now);
		else await collectMap(collector, task, now);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const target =
			task.kind === "search" ? `${task.origin}-${task.destination} ${task.date}` : task.key.replaceAll("\0", "/");
		logger.warn(`QRT booking collection ${task.kind} ${target} failed: ${message}`, {
			module: "qrt-booking-collector",
			function: "tick",
		});
		if (task.kind === "search") collector.searches.set(task.key, now - 5 * 60 * 60 * 1000);
	} finally {
		collector.running = false;
		for (const [key, candidate] of collector.candidates) {
			if (candidate.departureAt < now - 24 * 60 * 60 * 1000) collector.candidates.delete(key);
		}
		const oldestDate = localDate(now, -1);
		for (const key of collector.searches.keys()) {
			if (key.split("\0")[2] < oldestDate) collector.searches.delete(key);
		}
	}
}

/** One background collector per QRT cache directory; static reloads update its context. */
export function startQrtBookingCollector(ctx: CacheContext): void {
	const cacheDir = ctx.config.cacheDir;
	if (typeof cacheDir !== "string") return;
	const existing = collectors.get(cacheDir);
	if (existing) {
		existing.ctx = ctx;
		return;
	}
	const collector: Collector = {
		ctx,
		running: false,
		lastRequestAt: 0,
		turn: 0,
		searches: new Map(),
		candidates: new Map(),
	};
	collector.timer = setInterval(() => void tick(collector), TICK_MS);
	collector.timer.unref();
	collectors.set(cacheDir, collector);
	void tick(collector);
}

export const _test = { chooseTask, mapInterval, noServiceOnDate };
