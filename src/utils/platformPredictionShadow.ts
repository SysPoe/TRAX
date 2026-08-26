import { DatabaseSync } from "node:sqlite";

const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const PREDICTION_LOOKAHEAD_MS = 12 * 60 * 60 * 1000;
const PENDING_GRACE_MS = 6 * 60 * 60 * 1000;
const MINIMUM_SAMPLES = 3;

export type PlatformPredictionEvent = {
	eventKey: string;
	feedId: string;
	routeId: string;
	routeLabel: string;
	directionId: number | null;
	serviceId: string;
	stopId: string;
	dayOfWeek: number;
	scheduledAt: number;
	availablePlatform: boolean;
	reportedPlatform: string | null;
	observedAt: number | null;
};

export type PlatformAccuracyByRoute = {
	feedId: string;
	routeId: string;
	routeLabel: string;
	correct: number;
	total: number;
	accuracyPercent: number;
};

export type PlatformAccuracyByService = {
	feedId: string;
	serviceId: string;
	correct: number;
	total: number;
	accuracyPercent: number;
};

export type PlatformAccuracyByServiceDay = PlatformAccuracyByService & {
	dayOfWeek: string;
};

export type PlatformPredictionDiagnostics = {
	minimumSamples: number;
	retentionDays: number;
	observations: number;
	pending: number;
	evaluated: number;
	lastEvaluatedAt: string | null;
	byRoute: PlatformAccuracyByRoute[];
	byServiceId: PlatformAccuracyByService[];
	byServiceIdAndDay: PlatformAccuracyByServiceDay[];
};

type PredictionRow = { platform: string; sample_count: number };
type PendingRow = {
	route_prediction: string | null;
	service_prediction: string | null;
	service_day_prediction: string | null;
};

const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function normalizedPlatform(value: string | null): string | null {
	const platform = value?.trim();
	return platform && platform !== "-" && platform !== "?" && platform !== "—" ? platform : null;
}

function accuracyPercent(correct: number, total: number): number {
	return total === 0 ? 0 : Math.round((correct / total) * 1000) / 10;
}

/** Persist, predict, and score platform assignments without changing passenger-facing trip data. */
export class PlatformPredictionShadow {
	private readonly db: DatabaseSync;

	constructor(databasePath: string) {
		this.db = new DatabaseSync(databasePath);
		this.db.exec(`
			PRAGMA journal_mode = WAL;
			PRAGMA synchronous = NORMAL;
			CREATE TABLE IF NOT EXISTS platform_observations (
				event_key TEXT PRIMARY KEY,
				feed_id TEXT NOT NULL,
				route_id TEXT NOT NULL,
				route_label TEXT NOT NULL,
				direction_id INTEGER,
				service_id TEXT NOT NULL,
				stop_id TEXT NOT NULL,
				day_of_week INTEGER NOT NULL,
				scheduled_at INTEGER NOT NULL,
				platform TEXT NOT NULL,
				observed_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS platform_observations_route
				ON platform_observations(feed_id, route_id, direction_id, stop_id, scheduled_at);
			CREATE INDEX IF NOT EXISTS platform_observations_service
				ON platform_observations(feed_id, service_id, stop_id, scheduled_at);
			CREATE INDEX IF NOT EXISTS platform_observations_service_day
				ON platform_observations(feed_id, service_id, stop_id, day_of_week, scheduled_at);

			CREATE TABLE IF NOT EXISTS platform_pending_predictions (
				event_key TEXT PRIMARY KEY,
				feed_id TEXT NOT NULL,
				route_id TEXT NOT NULL,
				route_label TEXT NOT NULL,
				direction_id INTEGER,
				service_id TEXT NOT NULL,
				stop_id TEXT NOT NULL,
				day_of_week INTEGER NOT NULL,
				scheduled_at INTEGER NOT NULL,
				route_prediction TEXT,
				service_prediction TEXT,
				service_day_prediction TEXT,
				created_at INTEGER NOT NULL
			);

			CREATE TABLE IF NOT EXISTS platform_prediction_outcomes (
				event_key TEXT PRIMARY KEY,
				feed_id TEXT NOT NULL,
				route_id TEXT NOT NULL,
				route_label TEXT NOT NULL,
				direction_id INTEGER,
				service_id TEXT NOT NULL,
				stop_id TEXT NOT NULL,
				day_of_week INTEGER NOT NULL,
				scheduled_at INTEGER NOT NULL,
				route_prediction TEXT,
				service_prediction TEXT,
				service_day_prediction TEXT,
				actual_platform TEXT NOT NULL,
				observed_at INTEGER NOT NULL
			);
		`);
	}

	update(events: readonly PlatformPredictionEvent[], now = Date.now()): void {
		const cutoff = now - RETENTION_MS;
		const routePrediction = this.db.prepare(`
			SELECT platform, COUNT(*) AS sample_count
			FROM platform_observations
			WHERE feed_id = ? AND route_id = ? AND direction_id IS ? AND stop_id = ? AND scheduled_at >= ?
			GROUP BY platform
			ORDER BY sample_count DESC, MAX(observed_at) DESC, platform ASC
			LIMIT 1
		`);
		const servicePrediction = this.db.prepare(`
			SELECT platform, COUNT(*) AS sample_count
			FROM platform_observations
			WHERE feed_id = ? AND service_id = ? AND stop_id = ? AND scheduled_at >= ?
			GROUP BY platform
			ORDER BY sample_count DESC, MAX(observed_at) DESC, platform ASC
			LIMIT 1
		`);
		const serviceDayPrediction = this.db.prepare(`
			SELECT platform, COUNT(*) AS sample_count
			FROM platform_observations
			WHERE feed_id = ? AND service_id = ? AND stop_id = ? AND day_of_week = ? AND scheduled_at >= ?
			GROUP BY platform
			ORDER BY sample_count DESC, MAX(observed_at) DESC, platform ASC
			LIMIT 1
		`);
		const pendingForEvent = this.db.prepare(
			"SELECT route_prediction, service_prediction, service_day_prediction FROM platform_pending_predictions WHERE event_key = ?",
		);
		const outcomeExists = this.db.prepare(
			"SELECT 1 AS present FROM platform_prediction_outcomes WHERE event_key = ?",
		);
		const upsertObservation = this.db.prepare(`
			INSERT INTO platform_observations (
				event_key, feed_id, route_id, route_label, direction_id, service_id, stop_id,
				day_of_week, scheduled_at, platform, observed_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(event_key) DO UPDATE SET
				feed_id = excluded.feed_id,
				route_id = excluded.route_id,
				route_label = excluded.route_label,
				direction_id = excluded.direction_id,
				service_id = excluded.service_id,
				stop_id = excluded.stop_id,
				day_of_week = excluded.day_of_week,
				scheduled_at = excluded.scheduled_at,
				platform = excluded.platform,
				observed_at = MAX(platform_observations.observed_at, excluded.observed_at)
		`);
		const insertOutcome = this.db.prepare(`
			INSERT INTO platform_prediction_outcomes (
				event_key, feed_id, route_id, route_label, direction_id, service_id, stop_id,
				day_of_week, scheduled_at, route_prediction, service_prediction,
				service_day_prediction, actual_platform, observed_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(event_key) DO UPDATE SET
				actual_platform = excluded.actual_platform,
				observed_at = MAX(platform_prediction_outcomes.observed_at, excluded.observed_at)
		`);
		const insertPending = this.db.prepare(`
			INSERT OR IGNORE INTO platform_pending_predictions (
				event_key, feed_id, route_id, route_label, direction_id, service_id, stop_id,
				day_of_week, scheduled_at, route_prediction, service_prediction,
				service_day_prediction, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
		const deletePending = this.db.prepare("DELETE FROM platform_pending_predictions WHERE event_key = ?");

		const pick = (row: PredictionRow | undefined) =>
			row && Number(row.sample_count) >= MINIMUM_SAMPLES ? normalizedPlatform(row.platform) : null;

		this.db.exec("BEGIN IMMEDIATE");
		try {
			this.db.prepare("DELETE FROM platform_observations WHERE scheduled_at < ?").run(cutoff);
			this.db.prepare("DELETE FROM platform_prediction_outcomes WHERE scheduled_at < ?").run(cutoff);
			this.db
				.prepare("DELETE FROM platform_pending_predictions WHERE scheduled_at < ?")
				.run(now - PENDING_GRACE_MS);

			for (const event of events) {
				const actual = normalizedPlatform(event.reportedPlatform);
				if (!actual) continue;
				const observedAt = event.observedAt ?? now;
				upsertObservation.run(
					event.eventKey,
					event.feedId,
					event.routeId,
					event.routeLabel,
					event.directionId,
					event.serviceId,
					event.stopId,
					event.dayOfWeek,
					event.scheduledAt,
					actual,
					observedAt,
				);

				const pending = pendingForEvent.get(event.eventKey) as PendingRow | undefined;
				if (pending) {
					insertOutcome.run(
						event.eventKey,
						event.feedId,
						event.routeId,
						event.routeLabel,
						event.directionId,
						event.serviceId,
						event.stopId,
						event.dayOfWeek,
						event.scheduledAt,
						pending.route_prediction,
						pending.service_prediction,
						pending.service_day_prediction,
						actual,
						observedAt,
					);
					deletePending.run(event.eventKey);
				} else if (outcomeExists.get(event.eventKey)) {
					this.db
						.prepare(
							"UPDATE platform_prediction_outcomes SET actual_platform = ?, observed_at = MAX(observed_at, ?) WHERE event_key = ?",
						)
						.run(actual, observedAt, event.eventKey);
				}
			}

			for (const event of events) {
				if (
					event.availablePlatform ||
					normalizedPlatform(event.reportedPlatform) ||
					event.scheduledAt <= now ||
					event.scheduledAt > now + PREDICTION_LOOKAHEAD_MS ||
					pendingForEvent.get(event.eventKey) ||
					outcomeExists.get(event.eventKey)
				)
					continue;

				const byRoute = pick(
					routePrediction.get(event.feedId, event.routeId, event.directionId, event.stopId, cutoff) as
						PredictionRow | undefined,
				);
				const byService = pick(
					servicePrediction.get(event.feedId, event.serviceId, event.stopId, cutoff) as
						PredictionRow | undefined,
				);
				const byServiceDay = pick(
					serviceDayPrediction.get(event.feedId, event.serviceId, event.stopId, event.dayOfWeek, cutoff) as
						PredictionRow | undefined,
				);
				if (!byRoute && !byService && !byServiceDay) continue;

				insertPending.run(
					event.eventKey,
					event.feedId,
					event.routeId,
					event.routeLabel,
					event.directionId,
					event.serviceId,
					event.stopId,
					event.dayOfWeek,
					event.scheduledAt,
					byRoute,
					byService,
					byServiceDay,
					now,
				);
			}
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	diagnostics(): PlatformPredictionDiagnostics {
		const count = (table: string) =>
			Number((this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count);
		const byRoute = this.db
			.prepare(
				`
				SELECT feed_id, route_id, route_label,
					SUM(CASE WHEN route_prediction = actual_platform THEN 1 ELSE 0 END) AS correct,
					COUNT(route_prediction) AS total
				FROM platform_prediction_outcomes
				WHERE route_prediction IS NOT NULL
				GROUP BY feed_id, route_id, route_label
				ORDER BY route_label, feed_id, route_id
			`,
			)
			.all() as Array<{ feed_id: string; route_id: string; route_label: string; correct: number; total: number }>;
		const byServiceId = this.db
			.prepare(
				`
				SELECT feed_id, service_id,
					SUM(CASE WHEN service_prediction = actual_platform THEN 1 ELSE 0 END) AS correct,
					COUNT(service_prediction) AS total
				FROM platform_prediction_outcomes
				WHERE service_prediction IS NOT NULL
				GROUP BY feed_id, service_id
				ORDER BY service_id, feed_id
			`,
			)
			.all() as Array<{ feed_id: string; service_id: string; correct: number; total: number }>;
		const byServiceDay = this.db
			.prepare(
				`
				SELECT feed_id, service_id, day_of_week,
					SUM(CASE WHEN service_day_prediction = actual_platform THEN 1 ELSE 0 END) AS correct,
					COUNT(service_day_prediction) AS total
				FROM platform_prediction_outcomes
				WHERE service_day_prediction IS NOT NULL
				GROUP BY feed_id, service_id, day_of_week
				ORDER BY service_id, day_of_week, feed_id
			`,
			)
			.all() as Array<{
			feed_id: string;
			service_id: string;
			day_of_week: number;
			correct: number;
			total: number;
		}>;
		const latest = this.db
			.prepare("SELECT MAX(observed_at) AS observed_at FROM platform_prediction_outcomes")
			.get() as {
			observed_at: number | null;
		};

		return {
			minimumSamples: MINIMUM_SAMPLES,
			retentionDays: RETENTION_MS / (24 * 60 * 60 * 1000),
			observations: count("platform_observations"),
			pending: count("platform_pending_predictions"),
			evaluated: count("platform_prediction_outcomes"),
			lastEvaluatedAt: latest.observed_at == null ? null : new Date(Number(latest.observed_at)).toISOString(),
			byRoute: byRoute.map((row) => ({
				feedId: row.feed_id,
				routeId: row.route_id,
				routeLabel: row.route_label,
				correct: Number(row.correct),
				total: Number(row.total),
				accuracyPercent: accuracyPercent(Number(row.correct), Number(row.total)),
			})),
			byServiceId: byServiceId.map((row) => ({
				feedId: row.feed_id,
				serviceId: row.service_id,
				correct: Number(row.correct),
				total: Number(row.total),
				accuracyPercent: accuracyPercent(Number(row.correct), Number(row.total)),
			})),
			byServiceIdAndDay: byServiceDay.map((row) => ({
				feedId: row.feed_id,
				serviceId: row.service_id,
				dayOfWeek: dayNames[Number(row.day_of_week)] ?? String(row.day_of_week),
				correct: Number(row.correct),
				total: Number(row.total),
				accuracyPercent: accuracyPercent(Number(row.correct), Number(row.total)),
			})),
		};
	}

	close(): void {
		this.db.close();
	}
}
