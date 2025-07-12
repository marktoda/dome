export { NodeSDK } from '@opentelemetry/sdk-node';
export { ConsoleSpanExporter } from '@opentelemetry/sdk-trace-node';
export { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
export { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
export { resourceFromAttributes } from '@opentelemetry/resources';
export { OTLPTraceExporter as OTLPHttpExporter } from '@opentelemetry/exporter-trace-otlp-http';
export { OTLPTraceExporter as OTLPGrpcExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { SpanExporter, ReadableSpan } from '@opentelemetry/sdk-trace-base';
export { AlwaysOffSampler, AlwaysOnSampler, ParentBasedSampler, Sampler, TraceIdRatioBasedSampler } from '@opentelemetry/sdk-trace-base';
import { ExportResult } from '@opentelemetry/core';

declare class CompositeExporter implements SpanExporter {
    private exporters;
    constructor(exporters: SpanExporter[]);
    export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void;
    shutdown(): Promise<void>;
    forceFlush(): Promise<void>;
}

export { CompositeExporter };
