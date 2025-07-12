import { validateBody } from './chunk-RSEO4XPX.js';
import { handleError } from './chunk-LF7P5PLR.js';
import { __export } from './chunk-MLKGABMK.js';

// src/server/handlers/logs.ts
var logs_exports = {};
__export(logs_exports, {
  getLogTransports: () => getLogTransports,
  getLogsByRunIdHandler: () => getLogsByRunIdHandler,
  getLogsHandler: () => getLogsHandler
});
async function getLogsHandler({
  mastra,
  transportId,
  params
}) {
  try {
    validateBody({ transportId });
    const { fromDate, toDate, logLevel, filters: _filters, page, perPage } = params || {};
    const filters = _filters ? Object.fromEntries(
      (Array.isArray(_filters) ? _filters : [_filters]).map((attr) => {
        const [key, value] = attr.split(":");
        return [key, value];
      })
    ) : void 0;
    const logs = await mastra.getLogs(transportId, {
      fromDate,
      toDate,
      logLevel,
      filters,
      page: page ? Number(page) : void 0,
      perPage: perPage ? Number(perPage) : void 0
    });
    return logs;
  } catch (error) {
    return handleError(error, "Error getting logs");
  }
}
async function getLogsByRunIdHandler({
  mastra,
  runId,
  transportId,
  params
}) {
  try {
    validateBody({ runId, transportId });
    const { fromDate, toDate, logLevel, filters: _filters, page, perPage } = params || {};
    const filters = _filters ? Object.fromEntries(
      (Array.isArray(_filters) ? _filters : [_filters]).map((attr) => {
        const [key, value] = attr.split(":");
        return [key, value];
      })
    ) : void 0;
    const logs = await mastra.getLogsByRunId({
      runId,
      transportId,
      fromDate,
      toDate,
      logLevel,
      filters,
      page: page ? Number(page) : void 0,
      perPage: perPage ? Number(perPage) : void 0
    });
    return logs;
  } catch (error) {
    return handleError(error, "Error getting logs by run ID");
  }
}
async function getLogTransports({ mastra }) {
  try {
    const logger = mastra.getLogger();
    const transports = logger.getTransports();
    return {
      transports: transports ? [...transports.keys()] : []
    };
  } catch (error) {
    return handleError(error, "Error getting log Transports");
  }
}

export { getLogTransports, getLogsByRunIdHandler, getLogsHandler, logs_exports };
