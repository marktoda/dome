export { NodeSDK } from '@opentelemetry/sdk-node';
export { ConsoleSpanExporter } from '@opentelemetry/sdk-trace-node';
export { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
export { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
export { resourceFromAttributes } from '@opentelemetry/resources';
export { OTLPTraceExporter as OTLPHttpExporter } from '@opentelemetry/exporter-trace-otlp-http';
export { OTLPTraceExporter as OTLPGrpcExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
export { AlwaysOffSampler, AlwaysOnSampler, ParentBasedSampler, TraceIdRatioBasedSampler } from '@opentelemetry/sdk-trace-base';
import { ExportResultCode } from '@opentelemetry/core';

var CompositeExporter = class {
  exporters;
  constructor(exporters) {
    this.exporters = exporters;
  }
  export(spans, resultCallback) {
    const telemetryTraceIds = new Set(
      spans.filter((span) => {
        const attrs = span.attributes || {};
        const httpTarget = attrs["http.target"];
        return httpTarget === "/api/telemetry";
      }).map((span) => span.spanContext().traceId)
    );
    const filteredSpans = spans.filter((span) => !telemetryTraceIds.has(span.spanContext().traceId));
    if (filteredSpans.length === 0) {
      resultCallback({ code: ExportResultCode.SUCCESS });
      return;
    }
    void Promise.all(
      this.exporters.map(
        (exporter) => new Promise((resolve) => {
          if (exporter.export) {
            exporter.export(filteredSpans, resolve);
          } else {
            resolve({ code: ExportResultCode.FAILED });
          }
        })
      )
    ).then((results) => {
      const hasError = results.some((r) => r.code === ExportResultCode.FAILED);
      resultCallback({
        code: hasError ? ExportResultCode.FAILED : ExportResultCode.SUCCESS
      });
    }).catch((error) => {
      console.error("[CompositeExporter] Export error:", error);
      resultCallback({ code: ExportResultCode.FAILED, error });
    });
  }
  shutdown() {
    return Promise.all(this.exporters.map((e) => e.shutdown?.() ?? Promise.resolve())).then(() => void 0);
  }
  forceFlush() {
    return Promise.all(this.exporters.map((e) => e.forceFlush?.() ?? Promise.resolve())).then(() => void 0);
  }
};

export { CompositeExporter };
