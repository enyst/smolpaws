export declare enum LogLevel {
    DEBUG = 10,
    INFO = 20,
    WARN = 30,
    ERROR = 40,
    CRITICAL = 50
}
export interface Logger {
    readonly name: string;
    debug(message: string, ...args: readonly unknown[]): void;
    info(message: string, ...args: readonly unknown[]): void;
    warn(message: string, ...args: readonly unknown[]): void;
    error(message: string, ...args: readonly unknown[]): void;
}
export interface LoggingOptions {
    readonly level?: LogLevel;
}
export declare function setupLogging(options?: LoggingOptions): void;
export declare function disableLogger(name: string, level?: LogLevel): void;
export declare function isEnabledFor(name: string, level: LogLevel): boolean;
export declare function getLogger(name: string): Logger;
