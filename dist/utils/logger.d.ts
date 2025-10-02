export declare enum LogLevel {
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
declare class Logger {
    private level;
    private prefix;
    constructor(level?: LogLevel, prefix?: string);
    setLevel(level: LogLevel): void;
    private writeLog;
    debug(message: string, context?: LogContext): void;
    info(message: string, context?: LogContext): void;
    warn(message: string, context?: LogContext): void;
    error(message: string, context?: LogContext): void;
    private formatLog;
}
declare const defaultLogger: Logger;
export default defaultLogger;
export { Logger };
