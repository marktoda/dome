import { MastraError } from './error/index.cjs';
import { Transform } from 'stream';

declare const RegisteredLogger: {
    readonly AGENT: "AGENT";
    readonly AUTH: "AUTH";
    readonly NETWORK: "NETWORK";
    readonly WORKFLOW: "WORKFLOW";
    readonly LLM: "LLM";
    readonly TTS: "TTS";
    readonly VOICE: "VOICE";
    readonly VECTOR: "VECTOR";
    readonly BUNDLER: "BUNDLER";
    readonly DEPLOYER: "DEPLOYER";
    readonly MEMORY: "MEMORY";
    readonly STORAGE: "STORAGE";
    readonly EMBEDDINGS: "EMBEDDINGS";
    readonly MCP_SERVER: "MCP_SERVER";
};
type RegisteredLogger = (typeof RegisteredLogger)[keyof typeof RegisteredLogger];
declare const LogLevel: {
    readonly DEBUG: "debug";
    readonly INFO: "info";
    readonly WARN: "warn";
    readonly ERROR: "error";
    readonly NONE: "silent";
};
type LogLevel = (typeof LogLevel)[keyof typeof LogLevel];

interface BaseLogMessage {
    runId?: string;
    msg: string;
    level: LogLevel;
    time: Date;
    pid: number;
    hostname: string;
    name: string;
}
declare abstract class LoggerTransport extends Transform {
    constructor(opts?: any);
    getLogsByRunId(_args: {
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
    getLogs(_args?: {
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
}
declare const createCustomTransport: (stream: Transform, getLogs?: LoggerTransport["getLogs"], getLogsByRunId?: LoggerTransport["getLogsByRunId"]) => LoggerTransport;

interface IMastraLogger {
    debug(message: string, ...args: any[]): void;
    info(message: string, ...args: any[]): void;
    warn(message: string, ...args: any[]): void;
    error(message: string, ...args: any[]): void;
    trackException(error: MastraError): void;
    getTransports(): Map<string, LoggerTransport>;
    getLogs(_transportId: string, _params?: {
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
        logs: BaseLogMessage[];
        total: number;
        page: number;
        perPage: number;
        hasMore: boolean;
    }>;
}
declare abstract class MastraLogger implements IMastraLogger {
    protected name: string;
    protected level: LogLevel;
    protected transports: Map<string, LoggerTransport>;
    constructor(options?: {
        name?: string;
        level?: LogLevel;
        transports?: Record<string, LoggerTransport>;
    });
    abstract debug(message: string, ...args: any[]): void;
    abstract info(message: string, ...args: any[]): void;
    abstract warn(message: string, ...args: any[]): void;
    abstract error(message: string, ...args: any[]): void;
    getTransports(): Map<string, LoggerTransport>;
    trackException(_error: MastraError): void;
    getLogs(transportId: string, params?: {
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
    getLogsByRunId({ transportId, runId, fromDate, toDate, logLevel, filters, page, perPage, }: {
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

export { type BaseLogMessage as B, type IMastraLogger as I, LoggerTransport as L, MastraLogger as M, RegisteredLogger as R, LogLevel as a, createCustomTransport as c };
