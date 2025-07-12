'use strict';

var chunkB6TOBUS6_cjs = require('./chunk-B6TOBUS6.cjs');
var api = require('@opentelemetry/api');
var core = require('@opentelemetry/core');
var otlpTransformer = require('@opentelemetry/otlp-transformer');

function hasActiveTelemetry(tracerName = "default-tracer") {
  try {
    return !!api.trace.getTracer(tracerName);
  } catch {
    return false;
  }
}
function getBaggageValues(ctx) {
  const currentBaggage = api.propagation.getBaggage(ctx);
  const requestId = currentBaggage?.getEntry("http.request_id")?.value;
  const componentName = currentBaggage?.getEntry("componentName")?.value;
  const runId = currentBaggage?.getEntry("runId")?.value;
  return {
    requestId,
    componentName,
    runId
  };
}

// src/telemetry/telemetry.decorators.ts
function withSpan(options) {
  return function(_target, propertyKey, descriptor) {
    if (!descriptor || typeof descriptor === "number") return;
    const originalMethod = descriptor.value;
    const methodName = String(propertyKey);
    descriptor.value = function(...args) {
      if (options?.skipIfNoTelemetry && !hasActiveTelemetry(options?.tracerName)) {
        return originalMethod.apply(this, args);
      }
      const tracer = api.trace.getTracer(options?.tracerName ?? "default-tracer");
      let spanName;
      let spanKind;
      if (typeof options === "string") {
        spanName = options;
      } else if (options) {
        spanName = options.spanName || methodName;
        spanKind = options.spanKind;
      } else {
        spanName = methodName;
      }
      const span = tracer.startSpan(spanName, { kind: spanKind });
      let ctx = api.trace.setSpan(api.context.active(), span);
      args.forEach((arg, index) => {
        try {
          span.setAttribute(`${spanName}.argument.${index}`, JSON.stringify(arg));
        } catch {
          span.setAttribute(`${spanName}.argument.${index}`, "[Not Serializable]");
        }
      });
      const { requestId, componentName, runId } = getBaggageValues(ctx);
      if (requestId) {
        span.setAttribute("http.request_id", requestId);
      }
      if (componentName) {
        span.setAttribute("componentName", componentName);
        span.setAttribute("runId", runId);
      } else if (this && this.name) {
        span.setAttribute("componentName", this.name);
        span.setAttribute("runId", this.runId);
        ctx = api.propagation.setBaggage(
          ctx,
          api.propagation.createBaggage({
            // @ts-ignore
            componentName: { value: this.name },
            // @ts-ignore
            runId: { value: this.runId },
            // @ts-ignore
            "http.request_id": { value: requestId }
          })
        );
      }
      let result;
      try {
        result = api.context.with(ctx, () => originalMethod.apply(this, args));
        if (result instanceof Promise) {
          return result.then((resolvedValue) => {
            try {
              span.setAttribute(`${spanName}.result`, JSON.stringify(resolvedValue));
            } catch {
              span.setAttribute(`${spanName}.result`, "[Not Serializable]");
            }
            return resolvedValue;
          }).finally(() => span.end());
        }
        try {
          span.setAttribute(`${spanName}.result`, JSON.stringify(result));
        } catch {
          span.setAttribute(`${spanName}.result`, "[Not Serializable]");
        }
        return result;
      } catch (error) {
        span.setStatus({
          code: api.SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : "Unknown error"
        });
        if (error instanceof Error) {
          span.recordException(error);
        }
        throw error;
      } finally {
        if (!(result instanceof Promise)) {
          span.end();
        }
      }
    };
    return descriptor;
  };
}
function InstrumentClass(options) {
  return function(target) {
    const methods = Object.getOwnPropertyNames(target.prototype);
    methods.forEach((method) => {
      if (options?.excludeMethods?.includes(method) || method === "constructor") return;
      if (options?.methodFilter && !options.methodFilter(method)) return;
      const descriptor = Object.getOwnPropertyDescriptor(target.prototype, method);
      if (descriptor && typeof descriptor.value === "function") {
        Object.defineProperty(
          target.prototype,
          method,
          withSpan({
            spanName: options?.prefix ? `${options.prefix}.${method}` : method,
            skipIfNoTelemetry: true,
            spanKind: options?.spanKind || api.SpanKind.INTERNAL,
            tracerName: options?.tracerName
          })(target, method, descriptor)
        );
      }
    });
    return target;
  };
}

// src/storage/constants.ts
var TABLE_WORKFLOW_SNAPSHOT = "mastra_workflow_snapshot";
var TABLE_EVALS = "mastra_evals";
var TABLE_MESSAGES = "mastra_messages";
var TABLE_THREADS = "mastra_threads";
var TABLE_TRACES = "mastra_traces";
var TABLE_RESOURCES = "mastra_resources";
var TABLE_SCHEMAS = {
  [TABLE_WORKFLOW_SNAPSHOT]: {
    workflow_name: {
      type: "text"
    },
    run_id: {
      type: "text"
    },
    resourceId: { type: "text", nullable: true },
    snapshot: {
      type: "text"
    },
    createdAt: {
      type: "timestamp"
    },
    updatedAt: {
      type: "timestamp"
    }
  },
  [TABLE_EVALS]: {
    input: {
      type: "text"
    },
    output: {
      type: "text"
    },
    result: {
      type: "jsonb"
    },
    agent_name: {
      type: "text"
    },
    metric_name: {
      type: "text"
    },
    instructions: {
      type: "text"
    },
    test_info: {
      type: "jsonb",
      nullable: true
    },
    global_run_id: {
      type: "text"
    },
    run_id: {
      type: "text"
    },
    created_at: {
      type: "timestamp"
    },
    createdAt: {
      type: "timestamp",
      nullable: true
    }
  },
  [TABLE_THREADS]: {
    id: { type: "text", nullable: false, primaryKey: true },
    resourceId: { type: "text", nullable: false },
    title: { type: "text", nullable: false },
    metadata: { type: "text", nullable: true },
    createdAt: { type: "timestamp", nullable: false },
    updatedAt: { type: "timestamp", nullable: false }
  },
  [TABLE_MESSAGES]: {
    id: { type: "text", nullable: false, primaryKey: true },
    thread_id: { type: "text", nullable: false },
    content: { type: "text", nullable: false },
    role: { type: "text", nullable: false },
    type: { type: "text", nullable: false },
    createdAt: { type: "timestamp", nullable: false },
    resourceId: { type: "text", nullable: true }
  },
  [TABLE_TRACES]: {
    id: { type: "text", nullable: false, primaryKey: true },
    parentSpanId: { type: "text", nullable: true },
    name: { type: "text", nullable: false },
    traceId: { type: "text", nullable: false },
    scope: { type: "text", nullable: false },
    kind: { type: "integer", nullable: false },
    attributes: { type: "jsonb", nullable: true },
    status: { type: "jsonb", nullable: true },
    events: { type: "jsonb", nullable: true },
    links: { type: "jsonb", nullable: true },
    other: { type: "text", nullable: true },
    startTime: { type: "bigint", nullable: false },
    endTime: { type: "bigint", nullable: false },
    createdAt: { type: "timestamp", nullable: false }
  },
  [TABLE_RESOURCES]: {
    id: { type: "text", nullable: false, primaryKey: true },
    workingMemory: { type: "text", nullable: true },
    metadata: { type: "jsonb", nullable: true },
    createdAt: { type: "timestamp", nullable: false },
    updatedAt: { type: "timestamp", nullable: false }
  }
};

// src/telemetry/storage-exporter.ts
var OTLPTraceExporter = class {
  storage;
  queue = [];
  serializer;
  logger;
  activeFlush = void 0;
  constructor({ logger, storage }) {
    this.storage = storage;
    this.serializer = otlpTransformer.JsonTraceSerializer;
    this.logger = logger;
  }
  export(internalRepresentation, resultCallback) {
    const serializedRequest = this.serializer.serializeRequest(internalRepresentation);
    const payload = JSON.parse(Buffer.from(serializedRequest.buffer, "utf8"));
    const items = payload?.resourceSpans?.[0]?.scopeSpans;
    this.logger.debug(`Exporting telemetry: ${items.length} scope spans to be processed [trace batch]`);
    this.queue.push({ data: items, resultCallback });
    if (!this.activeFlush) {
      this.activeFlush = this.flush();
    }
  }
  shutdown() {
    return this.forceFlush();
  }
  flush() {
    const now = /* @__PURE__ */ new Date();
    const items = this.queue.shift();
    if (!items) return Promise.resolve();
    const allSpans = items.data.reduce((acc, scopedSpans) => {
      const { scope, spans } = scopedSpans;
      for (const span of spans) {
        const {
          spanId,
          parentSpanId,
          traceId,
          name,
          kind,
          attributes,
          status,
          events,
          links,
          startTimeUnixNano,
          endTimeUnixNano,
          ...rest
        } = span;
        const startTime = Number(BigInt(startTimeUnixNano) / 1000n);
        const endTime = Number(BigInt(endTimeUnixNano) / 1000n);
        acc.push({
          id: spanId,
          parentSpanId,
          traceId,
          name,
          scope: scope.name,
          kind,
          status: JSON.stringify(status),
          events: JSON.stringify(events),
          links: JSON.stringify(links),
          attributes: JSON.stringify(
            attributes.reduce((acc2, attr) => {
              const valueKey = Object.keys(attr.value)[0];
              if (valueKey) {
                acc2[attr.key] = attr.value[valueKey];
              }
              return acc2;
            }, {})
          ),
          startTime,
          endTime,
          other: JSON.stringify(rest),
          createdAt: now
        });
      }
      return acc;
    }, []);
    return this.storage.batchInsert({
      tableName: TABLE_TRACES,
      records: allSpans
    }).then(() => {
      items.resultCallback({
        code: core.ExportResultCode.SUCCESS
      });
    }).catch((e) => {
      const mastraError = new chunkB6TOBUS6_cjs.MastraError(
        {
          id: "OTLP_TRACE_EXPORT_FAILURE",
          text: "Failed to export telemetry spans",
          domain: "MASTRA_TELEMETRY" /* MASTRA_TELEMETRY */,
          category: "SYSTEM" /* SYSTEM */,
          details: {
            attemptedSpanCount: allSpans.length,
            targetTable: TABLE_TRACES,
            firstSpanName: allSpans.length > 0 ? allSpans[0].name : "",
            firstSpanKind: allSpans.length > 0 ? allSpans[0].kind : "",
            firstSpanScope: allSpans.length > 0 ? allSpans[0].scope : ""
          }
        },
        e
      );
      this.logger.trackException(mastraError);
      this.logger.error("span err:" + mastraError.toString());
      items.resultCallback({
        code: core.ExportResultCode.FAILED,
        error: e
      });
    }).finally(() => {
      this.activeFlush = void 0;
    });
  }
  async forceFlush() {
    if (!this.queue.length) {
      return;
    }
    await this.activeFlush;
    while (this.queue.length) {
      await this.flush();
    }
  }
  __setLogger(logger) {
    this.logger = logger;
  }
};
var Telemetry = class _Telemetry {
  tracer = api.trace.getTracer("default");
  name = "default-service";
  constructor(config) {
    this.name = config.serviceName ?? "default-service";
    this.tracer = api.trace.getTracer(this.name);
  }
  /**
   * @deprecated This method does not do anything
   */
  async shutdown() {
  }
  /**
   * Initialize telemetry with the given configuration
   * @param config - Optional telemetry configuration object
   * @returns Telemetry instance that can be used for tracing
   */
  static init(config = {}) {
    try {
      if (!globalThis.__TELEMETRY__) {
        globalThis.__TELEMETRY__ = new _Telemetry(config);
      }
      return globalThis.__TELEMETRY__;
    } catch (error) {
      const wrappedError = new chunkB6TOBUS6_cjs.MastraError(
        {
          id: "TELEMETRY_INIT_FAILED",
          text: "Failed to initialize telemetry",
          domain: "MASTRA_TELEMETRY" /* MASTRA_TELEMETRY */,
          category: "SYSTEM" /* SYSTEM */
        },
        error
      );
      throw wrappedError;
    }
  }
  static getActiveSpan() {
    const span = api.trace.getActiveSpan();
    return span;
  }
  /**
   * Get the global telemetry instance
   * @throws {Error} If telemetry has not been initialized
   * @returns {Telemetry} The global telemetry instance
   */
  static get() {
    if (!globalThis.__TELEMETRY__) {
      throw new chunkB6TOBUS6_cjs.MastraError({
        id: "TELEMETRY_GETTER_FAILED_GLOBAL_TELEMETRY_NOT_INITIALIZED",
        text: "Telemetry not initialized",
        domain: "MASTRA_TELEMETRY" /* MASTRA_TELEMETRY */,
        category: "USER" /* USER */
      });
    }
    return globalThis.__TELEMETRY__;
  }
  /**
   * Wraps a class instance with telemetry tracing
   * @param instance The class instance to wrap
   * @param options Optional configuration for tracing
   * @returns Wrapped instance with all methods traced
   */
  traceClass(instance, options = {}) {
    const { skipIfNoTelemetry = true } = options;
    if (skipIfNoTelemetry && !hasActiveTelemetry()) {
      return instance;
    }
    const { spanNamePrefix = instance.constructor.name.toLowerCase(), attributes = {}, excludeMethods = [] } = options;
    return new Proxy(instance, {
      get: (target, prop) => {
        const value = target[prop];
        if (typeof value === "function" && prop !== "constructor" && !prop.toString().startsWith("_") && !excludeMethods.includes(prop.toString())) {
          return this.traceMethod(value.bind(target), {
            spanName: `${spanNamePrefix}.${prop.toString()}`,
            attributes: {
              ...attributes,
              [`${spanNamePrefix}.name`]: target.constructor.name,
              [`${spanNamePrefix}.method.name`]: prop.toString()
            }
          });
        }
        return value;
      }
    });
  }
  static setBaggage(baggage, ctx = api.context.active()) {
    const currentBaggage = Object.fromEntries(api.propagation.getBaggage(ctx)?.getAllEntries() ?? []);
    const newCtx = api.propagation.setBaggage(
      ctx,
      api.propagation.createBaggage({
        ...currentBaggage,
        ...baggage
      })
    );
    return newCtx;
  }
  static withContext(ctx, fn) {
    return api.context.with(ctx, fn);
  }
  /**
   * method to trace individual methods with proper context
   * @param method The method to trace
   * @param context Additional context for the trace
   * @returns Wrapped method with tracing
   */
  traceMethod(method, context3) {
    let ctx = api.context.active();
    const { skipIfNoTelemetry = true } = context3;
    if (skipIfNoTelemetry && !hasActiveTelemetry()) {
      return method;
    }
    return (...args) => {
      const span = this.tracer.startSpan(context3.spanName);
      function handleError(error) {
        span.recordException(error);
        span.setStatus({
          code: api.SpanStatusCode.ERROR,
          message: error.message
        });
        span.end();
        throw error;
      }
      try {
        let recordResult2 = function(res) {
          try {
            span.setAttribute(`${context3.spanName}.result`, JSON.stringify(res));
          } catch {
            span.setAttribute(`${context3.spanName}.result`, "[Not Serializable]");
          }
          span.end();
          return res;
        };
        const { requestId, componentName, runId } = getBaggageValues(ctx);
        if (context3.attributes) {
          span.setAttributes(context3.attributes);
        }
        if (requestId) {
          span.setAttribute("http.request_id", requestId);
        }
        if (context3.attributes?.componentName) {
          ctx = api.propagation.setBaggage(
            ctx,
            api.propagation.createBaggage({
              componentName: { value: context3.attributes.componentName },
              // @ts-ignore
              runId: { value: context3.attributes.runId },
              // @ts-ignore
              "http.request_id": { value: requestId }
            })
          );
        } else {
          if (componentName) {
            span.setAttribute("componentName", componentName);
            span.setAttribute("runId", runId);
          } else if (this && this.name) {
            span.setAttribute("componentName", this.name);
            span.setAttribute("runId", this.runId);
            ctx = api.propagation.setBaggage(
              ctx,
              api.propagation.createBaggage({
                componentName: { value: this.name },
                // @ts-ignore
                runId: { value: this.runId },
                // @ts-ignore
                "http.request_id": { value: requestId }
              })
            );
          }
        }
        args.forEach((arg, index) => {
          try {
            span.setAttribute(`${context3.spanName}.argument.${index}`, JSON.stringify(arg));
          } catch {
            span.setAttribute(`${context3.spanName}.argument.${index}`, "[Not Serializable]");
          }
        });
        let result;
        api.context.with(api.trace.setSpan(ctx, span), () => {
          result = method(...args);
        });
        if (result instanceof Promise) {
          return result.then(recordResult2).catch(handleError);
        } else {
          return recordResult2(result);
        }
      } catch (error) {
        handleError(error);
      }
    };
  }
  getBaggageTracer() {
    return new BaggageTracer(this.tracer);
  }
};
var BaggageTracer = class {
  _tracer;
  constructor(tracer) {
    this._tracer = tracer;
  }
  startSpan(name, options = {}, ctx) {
    ctx = ctx ?? api.context.active();
    const span = this._tracer.startSpan(name, options, ctx);
    const { componentName, runId, requestId } = getBaggageValues(ctx);
    span.setAttribute("componentName", componentName);
    span.setAttribute("runId", runId);
    span.setAttribute("http.request_id", requestId);
    return span;
  }
  startActiveSpan(name, optionsOrFn, ctxOrFn, fn) {
    if (typeof optionsOrFn === "function") {
      const wrappedFn2 = (span) => {
        const { componentName, runId, requestId } = getBaggageValues(api.context.active());
        span.setAttribute("componentName", componentName);
        span.setAttribute("runId", runId);
        span.setAttribute("http.request_id", requestId);
        return optionsOrFn(span);
      };
      return this._tracer.startActiveSpan(name, {}, api.context.active(), wrappedFn2);
    }
    if (typeof ctxOrFn === "function") {
      const wrappedFn2 = (span) => {
        const { componentName, runId, requestId } = getBaggageValues(api.context.active());
        span.setAttribute("componentName", componentName);
        span.setAttribute("runId", runId);
        span.setAttribute("http.request_id", requestId);
        return ctxOrFn(span);
      };
      return this._tracer.startActiveSpan(name, optionsOrFn, api.context.active(), wrappedFn2);
    }
    const wrappedFn = (span) => {
      const { componentName, runId, requestId } = getBaggageValues(ctxOrFn ?? api.context.active());
      span.setAttribute("componentName", componentName);
      span.setAttribute("runId", runId);
      span.setAttribute("http.request_id", requestId);
      return fn(span);
    };
    return this._tracer.startActiveSpan(name, optionsOrFn, ctxOrFn, wrappedFn);
  }
};

exports.InstrumentClass = InstrumentClass;
exports.OTLPTraceExporter = OTLPTraceExporter;
exports.TABLE_EVALS = TABLE_EVALS;
exports.TABLE_MESSAGES = TABLE_MESSAGES;
exports.TABLE_RESOURCES = TABLE_RESOURCES;
exports.TABLE_SCHEMAS = TABLE_SCHEMAS;
exports.TABLE_THREADS = TABLE_THREADS;
exports.TABLE_TRACES = TABLE_TRACES;
exports.TABLE_WORKFLOW_SNAPSHOT = TABLE_WORKFLOW_SNAPSHOT;
exports.Telemetry = Telemetry;
exports.getBaggageValues = getBaggageValues;
exports.hasActiveTelemetry = hasActiveTelemetry;
exports.withSpan = withSpan;
