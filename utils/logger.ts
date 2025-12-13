import chalk from "chalk";
import stripAnsi from "strip-ansi";
import fs from "fs/promises";
import { ProgressInfo } from "qdf-gtfs";
import cliProgress from "cli-progress";

export enum LogLevel {
	NONE = 0,
	ERROR = 1,
	WARN = 2,
	INFO = 3,
	DEBUG = 4,
}

export type LogContext = {
	module?: string;
	function?: string;
	[key: string]: any;
};

class Logger {
	private level: LogLevel;
	private prefix: string;
	private multibar: cliProgress.MultiBar | undefined;
	private bars: Map<string, cliProgress.SingleBar>;

	constructor(level: LogLevel = LogLevel.INFO, prefix: string = "TRAX") {
		this.level = level;
		this.prefix = prefix;
		this.bars = new Map();
	}

	setLevel(level: LogLevel): void {
		this.level = level;
	}

	private async writeLog(message: string): Promise<void> {
		const logFilePath = "./TRAX.log";
		try {
			await fs.access(logFilePath);
		} catch {
			await fs.writeFile(logFilePath, "");
		}
		// TODO Dangerous!!! Clear the log file if it exceeds 10 MB. Disable when debug is done.
		try {
			if ((await fs.stat(logFilePath)).size > 10 * 1024 * 1024) await fs.truncate(logFilePath, 0);
			await fs.writeFile(logFilePath, message + "\n", { flag: "a" });
		} catch (e) {
			// Ignore logging errors to avoid recursion or crash
		}
	}

	private print(message: string, method: "log" | "warn" | "error" | "debug" = "log"): void {
		// If multibar is active, use its log method to avoid breaking layout
		if (this.multibar) {
			this.multibar.log(message + "\n");
		} else {
			console[method](message);
		}
	}

	debug(message: string, context?: LogContext): void {
		if (this.level >= LogLevel.DEBUG) {
			const logMessage = this.formatLog("DEBUG", chalk.blue, message, context);
			this.writeLog(stripAnsi(logMessage));
			this.print(logMessage, "debug");
		}
	}

	info(message: string, context?: LogContext): void {
		if (this.level >= LogLevel.INFO) {
			const logMessage = this.formatLog("INFO", chalk.green, message, context);
			this.writeLog(stripAnsi(logMessage));
			this.print(logMessage, "log");
		}
	}

	warn(message: string, context?: LogContext): void {
		if (this.level >= LogLevel.WARN) {
			const logMessage = this.formatLog("WARN", chalk.yellow, message, context);
			this.writeLog(stripAnsi(logMessage));
			this.print(logMessage, "warn");
		}
	}

	error(message: string, context?: LogContext): void {
		if (this.level >= LogLevel.ERROR) {
			const logMessage = this.formatLog("ERROR", chalk.red, message, context);
			this.writeLog(stripAnsi(logMessage));
			this.print(logMessage, "error");
		}
	}

	progress(info: ProgressInfo & { unit?: "bytes" | "items" }): void {
		const { task, current, total, speed } = info;
		const unit = info.unit || "bytes";

		// Initialize multibar if needed
		if (!this.multibar) {
			this.multibar = new cliProgress.MultiBar(
				{
					clearOnComplete: false,
					hideCursor: true,
					format:
						"[{bar}] {percentage}% | {value_formatted}/{total_formatted} | {speed_formatted} | ETA {eta_formatted} | {task}",
					autopadding: true,
				},
				cliProgress.Presets.shades_classic,
			);
		}

		// Create bar if not exists
		let bar = this.bars.get(task);
		const formatValue = (val: number) => (unit === "bytes" ? this.formatBytes(val) : val.toLocaleString());
		const formatSpeed = (val: number) =>
			unit === "bytes" ? `${this.formatBytes(val)}/s` : `${val.toFixed(1)}/s`;

		if (!bar) {
			bar = this.multibar.create(total, current, {
				task,
				value_formatted: formatValue(current),
				total_formatted: formatValue(total),
				speed_formatted: formatSpeed(speed ?? 0),
			});
			this.bars.set(task, bar);
		} else {
			bar.update(current, {
				task, // Update task just in case
				value_formatted: formatValue(current),
				total_formatted: formatValue(total),
				speed_formatted: formatSpeed(speed ?? 0),
			});
		}

		// Cleanup if finished
		if (current >= total && total > 0) {
			bar.stop();
			this.bars.delete(task);
			if (this.bars.size === 0) {
				this.multibar.stop();
				this.multibar = undefined;
			}
		}
	}

	private formatBytes(bytes: number): string {
		if (bytes === 0) return "0 B";
		const k = 1024;
		const sizes = ["B", "KB", "MB", "GB", "TB"];
		const i = Math.floor(Math.log(bytes) / Math.log(k));
		return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
	}

	// formatDuration is handled by cli-progress (eta_formatted) usually, but we keep the helper if needed internally
	private formatDuration(seconds: number): string {
		if (!isFinite(seconds) || seconds < 0) return "--:--";
		const h = Math.floor(seconds / 3600);
		const m = Math.floor((seconds % 3600) / 60);
		const s = Math.floor(seconds % 60);
		if (h > 0) {
			return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s
				.toString()
				.padStart(2, "0")}`;
		}
		return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
	}

	private formatLog(
		level: string,
		color: (text: string) => string,
		message: string,
		context?: LogContext,
		colorize: boolean = true,
	): string {
		const timestamp = new Date().toISOString();
		const levelStr = colorize ? color(`[${level}]`.padStart(7)) : `[${level}]`.padStart(7);

		// context = {}; // Removed the override that was clearing context

		let contextStr = "";
		if (context) {
			const contextParts: string[] = [];

			// Add any additional context properties
			Object.keys(context).forEach((key) => {
				if (key !== "module" && key !== "function") {
					contextParts.push(`${key}:${context[key]}`);
				}
			});

			if (contextParts.length > 0) {
				contextStr = ` [${contextParts.join(", ")}]`;
			}
		}

		const prefixStr = colorize ? chalk.magenta(`[${this.prefix}]`) : `[${this.prefix}]`;
		const moduleStr = context?.module
			? colorize
				? chalk.gray(`[m:${context.module}]`)
				: `[m:${context.module}]`
			: "";
		const functionStr = context?.function
			? colorize
				? chalk.gray(`[f:${context.function}]`)
				: `[f:${context.function}]`
			: "";

		return `${
			colorize ? chalk.gray(timestamp) : timestamp
		} ${levelStr} ${prefixStr}${moduleStr}${functionStr} ${contextStr} ${message}`;
	}
}

// Create a default logger instance
const defaultLogger = new Logger(LogLevel.INFO, "TRAX");

export default defaultLogger;
export { Logger };
