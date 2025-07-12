import { Transform } from 'stream';

// src/logger/multi-logger.ts
var MultiLogger = class {
  loggers;
  constructor(loggers) {
    this.loggers = loggers;
  }
  debug(message, ...args) {
    this.loggers.forEach((logger) => logger.debug(message, ...args));
  }
  info(message, ...args) {
    this.loggers.forEach((logger) => logger.info(message, ...args));
  }
  warn(message, ...args) {
    this.loggers.forEach((logger) => logger.warn(message, ...args));
  }
  error(message, ...args) {
    this.loggers.forEach((logger) => logger.error(message, ...args));
  }
  trackException(error) {
    this.loggers.forEach((logger) => logger.trackException(error));
  }
  getTransports() {
    const transports = [];
    this.loggers.forEach((logger) => transports.push(...logger.getTransports().entries()));
    return new Map(transports);
  }
  async getLogs(transportId, params) {
    for (const logger of this.loggers) {
      const logs = await logger.getLogs(transportId, params);
      if (logs.total > 0) {
        return logs;
      }
    }
    return { logs: [], total: 0, page: params?.page ?? 1, perPage: params?.perPage ?? 100, hasMore: false };
  }
  async getLogsByRunId(args) {
    for (const logger of this.loggers) {
      const logs = await logger.getLogsByRunId(args);
      if (logs.total > 0) {
        return logs;
      }
    }
    return { logs: [], total: 0, page: args.page ?? 1, perPage: args.perPage ?? 100, hasMore: false };
  }
};

// src/logger/noop-logger.ts
var noopLogger = {
  debug: () => {
  },
  info: () => {
  },
  warn: () => {
  },
  error: () => {
  },
  cleanup: async () => {
  },
  getTransports: () => /* @__PURE__ */ new Map(),
  trackException: () => {
  },
  getLogs: async () => ({ logs: [], total: 0, page: 1, perPage: 100, hasMore: false }),
  getLogsByRunId: async () => ({ logs: [], total: 0, page: 1, perPage: 100, hasMore: false })
};
var LoggerTransport = class extends Transform {
  constructor(opts = {}) {
    super({ ...opts, objectMode: true });
  }
  async getLogsByRunId(_args) {
    return { logs: [], total: 0, page: _args?.page ?? 1, perPage: _args?.perPage ?? 100, hasMore: false };
  }
  async getLogs(_args) {
    return { logs: [], total: 0, page: _args?.page ?? 1, perPage: _args?.perPage ?? 100, hasMore: false };
  }
};
var createCustomTransport = (stream, getLogs, getLogsByRunId) => {
  let transport = stream;
  if (getLogs) {
    transport.getLogs = getLogs;
  }
  if (getLogsByRunId) {
    transport.getLogsByRunId = getLogsByRunId;
  }
  return transport;
};

export { LoggerTransport, MultiLogger, createCustomTransport, noopLogger };
