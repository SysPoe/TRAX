import chalk from "chalk";
import stripAnsi from "strip-ansi";
import fs from "fs";
export var LogLevel;
(function (LogLevel) {
    LogLevel[LogLevel["NONE"] = 0] = "NONE";
    LogLevel[LogLevel["ERROR"] = 1] = "ERROR";
    LogLevel[LogLevel["WARN"] = 2] = "WARN";
    LogLevel[LogLevel["INFO"] = 3] = "INFO";
    LogLevel[LogLevel["DEBUG"] = 4] = "DEBUG";
})(LogLevel || (LogLevel = {}));
class Logger {
    level;
    prefix;
    constructor(level = LogLevel.INFO, prefix = "TRAX") {
        this.level = level;
        this.prefix = prefix;
    }
    setLevel(level) {
        this.level = level;
    }
    writeLog(message) {
        const logFilePath = "./TRAX.log";
        if (!fs.existsSync(logFilePath))
            fs.writeFileSync(logFilePath, "");
        // Dangerous!!! Clear the log file if it exceeds 10 MB. Disable when debug is done.
        if (fs.statSync(logFilePath).size > 10 * 1024 * 1024)
            fs.truncateSync(logFilePath, 0);
        fs.writeFileSync(logFilePath, message + "\n", { flag: "a" });
    }
    debug(message, context) {
        if (this.level >= LogLevel.DEBUG) {
            const logMessage = this.formatLog("DEBUG", chalk.blue, message, context);
            this.writeLog(stripAnsi(logMessage));
            console.debug(logMessage);
        }
    }
    info(message, context) {
        if (this.level >= LogLevel.INFO) {
            const logMessage = this.formatLog("INFO", chalk.green, message, context);
            this.writeLog(stripAnsi(logMessage));
            console.log(logMessage);
        }
    }
    warn(message, context) {
        if (this.level >= LogLevel.WARN) {
            const logMessage = this.formatLog("WARN", chalk.yellow, message, context);
            this.writeLog(stripAnsi(logMessage));
            console.warn(logMessage);
        }
    }
    error(message, context) {
        if (this.level >= LogLevel.ERROR) {
            const logMessage = this.formatLog("ERROR", chalk.red, message, context);
            this.writeLog(stripAnsi(logMessage));
            console.error(logMessage);
        }
    }
    formatLog(level, color, message, context, colorize = true) {
        const timestamp = new Date().toISOString();
        const levelStr = colorize ? color(`[${level}]`.padStart(7)) : `[${level}]`.padStart(7);
        context = {}; // TODO proper fix
        let contextStr = "";
        if (context) {
            const contextParts = [];
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
