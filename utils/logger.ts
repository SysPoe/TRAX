import chalk from "chalk";
import stripAnsi from "strip-ansi";
import fs from "fs/promises";
import { ProgressInfo } from "qdf-gtfs";

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

	constructor(level: LogLevel = LogLevel.INFO, prefix: string = "TRAX") {
		this.level = level;
		this.prefix = prefix;
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
		if ((await fs.stat(logFilePath)).size > 10 * 1024 * 1024) await fs.truncate(logFilePath, 0);
		await fs.writeFile(logFilePath, message + "\n", { flag: "a" });
	}

	debug(message: string, context?: LogContext): void {
		if (this.level >= LogLevel.DEBUG) {
			const logMessage = this.formatLog("DEBUG", chalk.blue, message, context);
			this.writeLog(stripAnsi(logMessage));
			console.debug(logMessage);
		}
	}

	info(message: string, context?: LogContext): void {
		if (this.level >= LogLevel.INFO) {
			const logMessage = this.formatLog("INFO", chalk.green, message, context);
			this.writeLog(stripAnsi(logMessage));
			console.log(logMessage);
		}
	}

	warn(message: string, context?: LogContext): void {
		if (this.level >= LogLevel.WARN) {
			const logMessage = this.formatLog("WARN", chalk.yellow, message, context);
			this.writeLog(stripAnsi(logMessage));
			console.warn(logMessage);
		}
	}

	error(message: string, context?: LogContext): void {
		if (this.level >= LogLevel.ERROR) {
			const logMessage = this.formatLog("ERROR", chalk.red, message, context);
			this.writeLog(stripAnsi(logMessage));
			console.error(logMessage);
		}
	}

	progress(info: ProgressInfo): void {
		const { task, current, total, speed, eta } = info;

		const percent = total > 0 ? (current / total) * 100 : 0;

		if (total > 0) {
			const width = 20;
			const completed = Math.floor((percent / 100) * width);
			const bar = '='.repeat(completed) + '>'.repeat(completed < width ? 1 : 0) + ' '.repeat(width - completed - (completed < width ? 1 : 0));

			const sizeStr = `${this.formatBytes(current)}/${this.formatBytes(total)}`;
			const speedStr = `${this.formatBytes(speed ?? 0)}/s`;
			const etaStr = `ETA ${this.formatDuration(eta ?? 0)}`;

			process.stdout.write(`\x1b[0K\r[${bar}] ${percent.toFixed(1)}% | ${sizeStr} | ${speedStr} | ${etaStr} | ${task}`);
			if (percent >= 100) {
				process.stdout.write('\r\x1b[0K');
			}
		}
	}

	private formatBytes(bytes: number): string {
		if (bytes === 0) return '0 B';
		const k = 1024;
		const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
		const i = Math.floor(Math.log(bytes) / Math.log(k));
		return parseFloat((bytes / Math.pow(k, i)).toFixed(2)).toFixed(2) + ' ' + sizes[i];
	}

	private formatDuration(seconds: number): string {
		if (!isFinite(seconds) || seconds < 0) return "--:--";
		const h = Math.floor(seconds / 3600);
		const m = Math.floor((seconds % 3600) / 60);
		const s = Math.floor(seconds % 60);
		if (h > 0) {
			return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
		}
		return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
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

		context = {}; // TODO proper fix

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

		return `${colorize ? chalk.gray(timestamp) : timestamp} ${levelStr} ${prefixStr}${moduleStr}${functionStr} ${contextStr} ${message}`;
	}
}

// Create a default logger instance
const defaultLogger = new Logger(LogLevel.INFO, "TRAX");

export default defaultLogger;
export { Logger };
