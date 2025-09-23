import chalk from 'chalk';
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
    constructor(level = LogLevel.INFO, prefix = 'TRAX') {
        this.level = level;
        this.prefix = prefix;
    }
    setLevel(level) {
        this.level = level;
    }
    debug(message, context) {
        if (this.level >= LogLevel.DEBUG) {
            console.log(this.formatLog('DEBUG', chalk.blue, message, context));
        }
    }
    info(message, context) {
        if (this.level >= LogLevel.INFO) {
            console.log(this.formatLog('INFO', chalk.green, message, context));
        }
    }
    warn(message, context) {
        if (this.level >= LogLevel.WARN) {
            console.warn(this.formatLog('WARN', chalk.yellow, message, context));
        }
    }
    error(message, context) {
        if (this.level >= LogLevel.ERROR) {
            console.error(this.formatLog('ERROR', chalk.red, message, context));
        }
    }
    formatLog(level, color, message, context) {
        const timestamp = new Date().toISOString();
        const levelStr = color(`[${level}]`.padStart(7));
        let contextStr = '';
        if (context) {
            const contextParts = [];
            if (context.module)
                contextParts.push(`module:${context.module}`);
            if (context.function)
                contextParts.push(`fn:${context.function}`);
            // Add any additional context properties
            Object.keys(context).forEach(key => {
                if (key !== 'module' && key !== 'function') {
                    contextParts.push(`${key}:${context[key]}`);
                }
            });
            if (contextParts.length > 0) {
                contextStr = ` [${contextParts.join(', ')}]`;
            }
        }
        return `${chalk.gray(timestamp)} ${levelStr} ${chalk.magenta(`[${this.prefix}]`)}${contextStr} ${message}`;
    }
}
// Create a default logger instance
const defaultLogger = new Logger(LogLevel.INFO, 'TRAX');
export default defaultLogger;
export { Logger };
