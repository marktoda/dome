import * as _opentelemetry_api from '@opentelemetry/api';
import { Tracer, Span, BaggageEntry, Context } from '@opentelemetry/api';
import { R as RegisteredLogger, I as IMastraLogger } from './logger-B8XXh6ya.cjs';
import { SpanExporter, ReadableSpan } from '@opentelemetry/sdk-trace-base';

/** Sampling strategy configuration for OpenTelemetry */
type SamplingStrategy = {
    /** Sample traces based on a probability between 0 and 1 */
    type: 'ratio';
    /** Probability between 0 and 1 (e.g., 0.1 for 10% sampling) */
    probability: number;
} | {
    /** Sample all traces */
    type: 'always_on';
} | {
    /** Don't sample any traces */
    type: 'always_off';
} | {
    /** Use parent sampling decision if available, otherwise use root sampler */
    type: 'parent_based';
    /** Configuration for the root sampler when no parent context exists */
    root: {
        /** Probability between 0 and 1 for the root sampler */
        probability: number;
    };
};
/** Configuration options for OpenTelemetry */
type OtelConfig = {
    /** Name of the service for telemetry identification */
    serviceName?: string;
    /** Whether telemetry is enabled. Defaults to true */
    enabled?: boolean;
    /** Name of the tracer to use. Defaults to 'mastra-tracer' */
    tracerName?: string;
    /** Sampling configuration to control trace data volume */
    sampling?: SamplingStrategy;
    /** Whether to disable local export */
    disableLocalExport?: boolean;
    /** Export configuration for sending telemetry data */
    export?: {
        /** Export to an OTLP (OpenTelemetry Protocol) endpoint */
        type: 'otlp';
        /** Whether to use gRPC or HTTP for OTLP */
        protocol?: 'grpc' | 'http';
        /** OTLP endpoint URL */
        endpoint?: string;
        /** Optional headers for OTLP requests */
        headers?: Record<string, string>;
    } | {
        /** Export to console for development/debugging */
        type: 'console';
    } | {
        type: 'custom';
        tracerName?: string;
        exporter: SpanExporter;
    };
};
type Trace = {
    id: string;
    parentSpanId: string;
    name: string;
    traceId: string;
    scope: string;
    kind: ReadableSpan['kind'];
    attributes: ReadableSpan['attributes'];
    status: ReadableSpan['status'];
    events: ReadableSpan['events'];
    links: ReadableSpan['links'];
    other: Record<string, any>;
    startTime: number;
    endTime: number;
    createdAt: string;
};

declare global {
    var __TELEMETRY__: Telemetry | undefined;
}
declare class Telemetry {
    tracer: Tracer;
    name: string;
    private constructor();
    /**
     * @deprecated This method does not do anything
     */
    shutdown(): Promise<void>;
    /**
     * Initialize telemetry with the given configuration
     * @param config - Optional telemetry configuration object
     * @returns Telemetry instance that can be used for tracing
     */
    static init(config?: OtelConfig): Telemetry;
    static getActiveSpan(): Span | undefined;
    /**
     * Get the global telemetry instance
     * @throws {Error} If telemetry has not been initialized
     * @returns {Telemetry} The global telemetry instance
     */
    static get(): Telemetry;
    /**
     * Wraps a class instance with telemetry tracing
     * @param instance The class instance to wrap
     * @param options Optional configuration for tracing
     * @returns Wrapped instance with all methods traced
     */
    traceClass<T extends object>(instance: T, options?: {
        /** Base name for spans (e.g. 'integration', 'agent') */
        spanNamePrefix?: string;
        /** Additional attributes to add to all spans */
        attributes?: Record<string, string>;
        /** Methods to exclude from tracing */
        excludeMethods?: string[];
        /** Skip tracing if telemetry is not active */
        skipIfNoTelemetry?: boolean;
    }): T;
    static setBaggage(baggage: Record<string, BaggageEntry>, ctx?: Context): Context;
    static withContext(ctx: Context, fn: () => void): void;
    /**
     * method to trace individual methods with proper context
     * @param method The method to trace
     * @param context Additional context for the trace
     * @returns Wrapped method with tracing
     */
    traceMethod<TMethod extends Function>(method: TMethod, context: {
        spanName: string;
        attributes?: Record<string, string>;
        skipIfNoTelemetry?: boolean;
        parentSpan?: Span;
    }): TMethod;
    getBaggageTracer(): Tracer;
}

declare class MastraBase {
    component: RegisteredLogger;
    protected logger: IMastraLogger;
    name?: string;
    telemetry?: Telemetry;
    constructor({ component, name }: {
        component?: RegisteredLogger;
        name?: string;
    });
    /**
     * Set the logger for the agent
     * @param logger
     */
    __setLogger(logger: IMastraLogger): void;
    /**
     * Set the telemetry for the
     * @param telemetry
     */
    __setTelemetry(telemetry: Telemetry): void;
    /**
     * Get the telemetry on the vector
     * @returns telemetry
     */
    __getTelemetry(): Telemetry | undefined;
    get experimental_telemetry(): {
        tracer: _opentelemetry_api.Tracer;
        isEnabled: boolean;
    } | undefined;
}

export { MastraBase as M, type OtelConfig as O, type SamplingStrategy as S, type Trace as T, Telemetry as a };
