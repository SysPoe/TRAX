import chalk from "chalk";
import stripAnsi from "strip-ansi";
import fs from "fs";

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

	private writeLog(message: string): void {
		const logFilePath = "./TRAX.log";
		if (!fs.existsSync(logFilePath)) fs.writeFileSync(logFilePath, "");
		// Dangerous!!! Clear the log file if it exceeds 10 MB. Disable when debug is done.
		if (fs.statSync(logFilePath).size > 10 * 1024 * 1024) fs.truncateSync(logFilePath, 0);
		fs.writeFileSync(logFilePath, message + "\n", { flag: "a" });
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
