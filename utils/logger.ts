import chalk from "chalk";
import stripAnsi from "strip-ansi";
import fs from "fs";
import { ProgressInfo } from "qdf-gtfs";
import cliProgress from "cli-progress";
import { WriteStream } from "fs";

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
	private stream: WriteStream;

	constructor(level: LogLevel = LogLevel.INFO, prefix: string = "TRAX") {
		this.level = level;
		this.prefix = prefix;
		this.bars = new Map();
		if (fs.existsSync("./TRAX.log")) fs.rmSync("./TRAX.log");
		this.stream = fs.createWriteStream("./TRAX.log", { flags: "a" });
	}

	setLevel(level: LogLevel): void {
		this.level = level;
	}

	private writeLog(message: string): void {
		this.stream.write(message + "\n");
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
		const unit = info.unit ?? "bytes";

		// Initialize multibar if needed
		if (!this.multibar) {
			this.multibar = new cliProgress.MultiBar(
				{
					clearOnComplete: true,
					hideCursor: true,
					format: "[{bar}] {percentage}% | {value_formatted}/{total_formatted} | {speed_formatted} | ETA {eta_formatted} | {task}",
					autopadding: true,
				},
				cliProgress.Presets.shades_classic,
			);
		}

		// Create bar if not exists
		let bar = this.bars.get(task);
		const formatValue = (val: number) => (unit === "bytes" ? this.formatBytes(val) : val.toLocaleString());
		const formatSpeed = (val: number) => (unit === "bytes" ? `${this.formatBytes(val)}/s` : `${val.toFixed(1)}/s`);

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
		const isDone = total <= 0 || current >= total;
		if (isDone) {
			bar.stop();
			this.multibar.remove(bar);
			this.bars.delete(task);
			if (this.bars.size === 0) {
				this.clearProgressBars();
			}
		}
	}

	private clearProgressBars(): void {
		if (this.multibar) {
			this.multibar.stop();
			this.multibar = undefined;
		}
		this.bars.forEach((b) => b.stop());
		this.bars.clear();
		// Ensure the cursor ends up on a clean line so subsequent logs appear at the bottom
		console.log("");
	}

	private formatBytes(bytes: number): string {
		if (bytes === 0) return "0 B";
		const k = 1024;
		const sizes = ["B", "KB", "MB", "GB", "TB"];
		const i = Math.floor(Math.log(bytes) / Math.log(k));
		return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
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
