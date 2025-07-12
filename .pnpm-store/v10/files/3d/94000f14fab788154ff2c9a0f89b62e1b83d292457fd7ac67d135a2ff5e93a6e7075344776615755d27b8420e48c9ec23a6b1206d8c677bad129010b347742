import { handleError } from './chunk-LF7P5PLR.js';
import { HTTPException } from './chunk-LCM566I4.js';
import { __export } from './chunk-MLKGABMK.js';

// src/server/handlers/telemetry.ts
var telemetry_exports = {};
__export(telemetry_exports, {
  getTelemetryHandler: () => getTelemetryHandler,
  storeTelemetryHandler: () => storeTelemetryHandler
});
async function getTelemetryHandler({ mastra, body }) {
  try {
    const telemetry = mastra.getTelemetry();
    const storage = mastra.getStorage();
    if (!telemetry) {
      throw new HTTPException(400, { message: "Telemetry is not initialized" });
    }
    if (!storage) {
      return [];
    }
    if (!body) {
      throw new HTTPException(400, { message: "Body is required" });
    }
    const { name, scope, page, perPage, attribute, fromDate, toDate } = body;
    const attributes = attribute ? Object.fromEntries(
      (Array.isArray(attribute) ? attribute : [attribute]).map((attr) => {
        const [key, value] = attr.split(":");
        return [key, value];
      })
    ) : void 0;
    const traces = await storage.getTraces({
      name,
      scope,
      page: Number(page ?? 0),
      perPage: Number(perPage ?? 100),
      attributes,
      fromDate: fromDate ? new Date(fromDate) : void 0,
      toDate: toDate ? new Date(toDate) : void 0
    });
    return traces;
  } catch (error2) {
    return handleError(error2, "Error getting telemetry");
  }
}
async function storeTelemetryHandler({ mastra, body }) {
  try {
    const storage = mastra.getStorage();
    const logger = mastra.getLogger();
    if (!storage) {
      return {
        status: "error",
        message: "Storage is not initialized"
      };
    }
    const now = /* @__PURE__ */ new Date();
    const items = body?.resourceSpans?.[0]?.scopeSpans;
    logger.debug("[Telemetry Handler] Received spans:", {
      totalSpans: items?.reduce((acc, scope) => acc + scope.spans.length, 0) || 0,
      timestamp: now.toISOString()
    });
    if (!items?.length) {
      return {
        status: "success",
        message: "No spans to process",
        traceCount: 0
      };
    }
    const allSpans = items.reduce((acc, scopedSpans) => {
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
    return storage.batchTraceInsert({
      records: allSpans
    }).then(() => {
      return {
        status: "success",
        message: "Traces received and processed successfully",
        traceCount: body.resourceSpans?.length || 0
      };
    }).catch(() => {
      return {
        status: "error",
        message: "Failed to process traces",
        // @ts-ignore
        error: error.message
      };
    });
  } catch (error2) {
    console.error("Error processing traces:", error2);
    return {
      status: "error",
      message: "Failed to process traces",
      // @ts-ignore
      error: error2.message
    };
  }
}

export { getTelemetryHandler, storeTelemetryHandler, telemetry_exports };
