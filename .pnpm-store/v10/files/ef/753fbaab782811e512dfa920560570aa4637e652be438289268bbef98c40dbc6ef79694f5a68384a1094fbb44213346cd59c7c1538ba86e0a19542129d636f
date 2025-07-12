'use strict';

var sdkNode = require('@opentelemetry/sdk-node');
var sdkTraceNode = require('@opentelemetry/sdk-trace-node');
var autoInstrumentationsNode = require('@opentelemetry/auto-instrumentations-node');
var semanticConventions = require('@opentelemetry/semantic-conventions');
var resources = require('@opentelemetry/resources');
var exporterTraceOtlpHttp = require('@opentelemetry/exporter-trace-otlp-http');
var exporterTraceOtlpGrpc = require('@opentelemetry/exporter-trace-otlp-grpc');
var sdkTraceBase = require('@opentelemetry/sdk-trace-base');
var core = require('@opentelemetry/core');

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
      resultCallback({ code: core.ExportResultCode.SUCCESS });
      return;
    }
    void Promise.all(
      this.exporters.map(
        (exporter) => new Promise((resolve) => {
          if (exporter.export) {
            exporter.export(filteredSpans, resolve);
          } else {
            resolve({ code: core.ExportResultCode.FAILED });
          }
        })
      )
    ).then((results) => {
      const hasError = results.some((r) => r.code === core.ExportResultCode.FAILED);
      resultCallback({
        code: hasError ? core.ExportResultCode.FAILED : core.ExportResultCode.SUCCESS
      });
    }).catch((error) => {
      console.error("[CompositeExporter] Export error:", error);
      resultCallback({ code: core.ExportResultCode.FAILED, error });
    });
  }
  shutdown() {
    return Promise.all(this.exporters.map((e) => e.shutdown?.() ?? Promise.resolve())).then(() => void 0);
  }
  forceFlush() {
    return Promise.all(this.exporters.map((e) => e.forceFlush?.() ?? Promise.resolve())).then(() => void 0);
  }
};

Object.defineProperty(exports, "NodeSDK", {
  enumerable: true,
  get: function () { return sdkNode.NodeSDK; }
});
Object.defineProperty(exports, "ConsoleSpanExporter", {
  enumerable: true,
  get: function () { return sdkTraceNode.ConsoleSpanExporter; }
});
Object.defineProperty(exports, "getNodeAutoInstrumentations", {
  enumerable: true,
  get: function () { return autoInstrumentationsNode.getNodeAutoInstrumentations; }
});
Object.defineProperty(exports, "ATTR_SERVICE_NAME", {
  enumerable: true,
  get: function () { return semanticConventions.ATTR_SERVICE_NAME; }
});
Object.defineProperty(exports, "resourceFromAttributes", {
  enumerable: true,
  get: function () { return resources.resourceFromAttributes; }
});
Object.defineProperty(exports, "OTLPHttpExporter", {
  enumerable: true,
  get: function () { return exporterTraceOtlpHttp.OTLPTraceExporter; }
});
Object.defineProperty(exports, "OTLPGrpcExporter", {
  enumerable: true,
  get: function () { return exporterTraceOtlpGrpc.OTLPTraceExporter; }
});
Object.defineProperty(exports, "AlwaysOffSampler", {
  enumerable: true,
  get: function () { return sdkTraceBase.AlwaysOffSampler; }
});
Object.defineProperty(exports, "AlwaysOnSampler", {
  enumerable: true,
  get: function () { return sdkTraceBase.AlwaysOnSampler; }
});
Object.defineProperty(exports, "ParentBasedSampler", {
  enumerable: true,
  get: function () { return sdkTraceBase.ParentBasedSampler; }
});
Object.defineProperty(exports, "TraceIdRatioBasedSampler", {
  enumerable: true,
  get: function () { return sdkTraceBase.TraceIdRatioBasedSampler; }
});
exports.CompositeExporter = CompositeExporter;
