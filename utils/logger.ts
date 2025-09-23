import chalk from 'chalk';

export enum LogLevel {
  NONE = 0,
  ERROR = 1,
  WARN = 2,
  INFO = 3,
  DEBUG = 4
}

export type LogContext = {
  module?: string;
  function?: string;
  [key: string]: any;
};

class Logger {
  private level: LogLevel;
  private prefix: string;

  constructor(level: LogLevel = LogLevel.INFO, prefix: string = 'TRAX') {
    this.level = level;
    this.prefix = prefix;
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  debug(message: string, context?: LogContext): void {
    if (this.level >= LogLevel.DEBUG) {
      console.log(this.formatLog('DEBUG', chalk.blue, message, context));
    }
  }

  info(message: string, context?: LogContext): void {
    if (this.level >= LogLevel.INFO) {
      console.log(this.formatLog('INFO', chalk.green, message, context));
    }
  }

  warn(message: string, context?: LogContext): void {
    if (this.level >= LogLevel.WARN) {
      console.warn(this.formatLog('WARN', chalk.yellow, message, context));
    }
  }

  error(message: string, context?: LogContext): void {
    if (this.level >= LogLevel.ERROR) {
      console.error(this.formatLog('ERROR', chalk.red, message, context));
    }
  }

  private formatLog(
    level: string,
    color: (text: string) => string,
    message: string,
    context?: LogContext
  ): string {
    const timestamp = new Date().toISOString();
    const levelStr = color(`[${level}]`.padStart(7));

    let contextStr = '';
    if (context) {
      const contextParts: string[] = [];

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

    return `${chalk.gray(timestamp)} ${levelStr} ${chalk.magenta(`[${this.prefix}]`)}${context?.module ? chalk.gray(`[m:${context.module}]`) : ''}${context?.function ? chalk.gray(`[f:${context.function}]`) : ''} ${contextStr} ${message}`;
  }
}

// Create a default logger instance
const defaultLogger = new Logger(LogLevel.INFO, 'TRAX');

export default defaultLogger;
export { Logger };