import { I as IMastraLogger, L as LoggerTransport, a as LogLevel, B as BaseLogMessage, M as MastraLogger } from '../logger-Bpa2oLL4.js';
export { R as RegisteredLogger, c as createCustomTransport } from '../logger-Bpa2oLL4.js';
import { MastraError } from '../error/index.js';
import 'stream';

declare class MultiLogger implements IMastraLogger {
    private loggers;
    constructor(loggers: IMastraLogger[]);
    debug(message: string, ...args: any[]): void;
    info(message: string, ...args: any[]): void;
    warn(message: string, ...args: any[]): void;
    error(message: string, ...args: any[]): void;
    trackException(error: MastraError): void;
    getTransports(): Map<string, LoggerTransport>;
    getLogs(transportId: string, params?: {
        fromDate?: Date;
        toDate?: Date;
        logLevel?: LogLevel;
        filters?: Record<string, any>;
        returnPaginationResults?: boolean;
        page?: number;
        perPage?: number;
    }): Promise<{
        logs: BaseLogMessage[];
        total: number;
        page: number;
        perPage: number;
        hasMore: boolean;
    }>;
    getLogsByRunId(args: {
        transportId: string;
        runId: string;
        fromDate?: Date;
        toDate?: Date;
        logLevel?: LogLevel;
        filters?: Record<string, any>;
        page?: number;
        perPage?: number;
    }): Promise<{
        logs: BaseLogMessage[];
        total: number;
        page: number;
        perPage: number;
        hasMore: boolean;
    }>;
}

declare const noopLogger: IMastraLogger;

declare const createLogger: (options: {
    name?: string;
    level?: LogLevel;
    transports?: Record<string, LoggerTransport>;
}) => ConsoleLogger;
declare class ConsoleLogger extends MastraLogger {
    constructor(options?: {
        name?: string;
        level?: LogLevel;
    });
    debug(message: string, ...args: any[]): void;
    info(message: string, ...args: any[]): void;
    warn(message: string, ...args: any[]): void;
    error(message: string, ...args: any[]): void;
    getLogs(_transportId: string, _params?: {
        fromDate?: Date;
        toDate?: Date;
        logLevel?: LogLevel;
        filters?: Record<string, any>;
        page?: number;
        perPage?: number;
    }): Promise<{
        logs: never[];
        total: number;
        page: number;
        perPage: number;
        hasMore: boolean;
    }>;
    getLogsByRunId(_args: {
        transportId: string;
        runId: string;
        fromDate?: Date;
        toDate?: Date;
        logLevel?: LogLevel;
        filters?: Record<string, any>;
        page?: number;
        perPage?: number;
    }): Promise<{
        logs: never[];
        total: number;
        page: number;
        perPage: number;
        hasMore: boolean;
    }>;
}

export { BaseLogMessage, ConsoleLogger, IMastraLogger, LogLevel, LoggerTransport, MastraLogger, MultiLogger, createLogger, noopLogger };
