type CLI_ORIGIN = 'mastra-cloud' | 'oss';
declare class PosthogAnalytics {
    private sessionId;
    private client?;
    private distinctId;
    private version;
    constructor({ version, apiKey, host, }: {
        version: string;
        apiKey: string;
        host: string;
    });
    private writeCliConfig;
    private initializePostHog;
    private isTelemetryEnabled;
    private getDistinctId;
    private getSystemProperties;
    private captureSessionStart;
    trackCommand(options: {
        command: string;
        args?: Record<string, unknown>;
        durationMs?: number;
        status?: 'success' | 'error';
        error?: string;
        origin?: CLI_ORIGIN;
    }): void;
    trackCommandExecution<T>({ command, args, execution, origin, }: {
        command: string;
        args: Record<string, unknown>;
        execution: () => Promise<T>;
        origin?: CLI_ORIGIN;
    }): Promise<T>;
    shutdown(): Promise<void>;
}

export { type CLI_ORIGIN, PosthogAnalytics };
