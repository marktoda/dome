import { LoggerTransport } from '@mastra/core/logger';

// src/upstash/index.ts
var UpstashTransport = class extends LoggerTransport {
  upstashUrl;
  upstashToken;
  listName;
  maxListLength;
  batchSize;
  flushInterval;
  logBuffer;
  lastFlush;
  flushIntervalId;
  constructor(opts) {
    super({ objectMode: true });
    if (!opts.upstashUrl || !opts.upstashToken) {
      throw new Error("Upstash URL and token are required");
    }
    this.upstashUrl = opts.upstashUrl;
    this.upstashToken = opts.upstashToken;
    this.listName = opts.listName || "application-logs";
    this.maxListLength = opts.maxListLength || 1e4;
    this.batchSize = opts.batchSize || 100;
    this.flushInterval = opts.flushInterval || 1e4;
    this.logBuffer = [];
    this.lastFlush = Date.now();
    this.flushIntervalId = setInterval(() => {
      this._flush().catch((err) => {
        console.error("Error flushing logs to Upstash:", err);
      });
    }, this.flushInterval);
  }
  async executeUpstashCommand(command) {
    const response = await fetch(`${this.upstashUrl}/pipeline`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.upstashToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify([command])
    });
    if (!response.ok) {
      throw new Error(`Failed to execute Upstash command: ${response.statusText}`);
    }
    return response.json();
  }
  async _flush() {
    if (this.logBuffer.length === 0) {
      return;
    }
    const now = Date.now();
    const logs = this.logBuffer.splice(0, this.batchSize);
    try {
      const command = ["LPUSH", this.listName, ...logs.map((log) => JSON.stringify(log))];
      if (this.maxListLength > 0) {
        command.push("LTRIM", this.listName, 0, this.maxListLength - 1);
      }
      await this.executeUpstashCommand(command);
      this.lastFlush = now;
    } catch (error) {
      this.logBuffer.unshift(...logs);
      throw error;
    }
  }
  _write(chunk, encoding, callback) {
    if (typeof callback === "function") {
      this._transform(chunk, encoding || "utf8", callback);
      return true;
    }
    this._transform(chunk, encoding || "utf8", (error) => {
      if (error) console.error("Transform error in write:", error);
    });
    return true;
  }
  _transform(chunk, _enc, cb) {
    try {
      const log = typeof chunk === "string" ? JSON.parse(chunk) : chunk;
      if (!log.time) {
        log.time = Date.now();
      }
      this.logBuffer.push(log);
      if (this.logBuffer.length >= this.batchSize) {
        this._flush().catch((err) => {
          console.error("Error flushing logs to Upstash:", err);
        });
      }
      cb(null, chunk);
    } catch (error) {
      cb(error);
    }
  }
  _destroy(err, cb) {
    clearInterval(this.flushIntervalId);
    if (this.logBuffer.length > 0) {
      this._flush().then(() => cb(err)).catch((flushErr) => {
        console.error("Error in final flush:", flushErr);
        cb(err || flushErr);
      });
    } else {
      cb(err);
    }
  }
  async getLogs(params) {
    try {
      const command = ["LRANGE", this.listName, 0, -1];
      const response = await this.executeUpstashCommand(command);
      const logs = response?.[0]?.result?.map((log) => {
        try {
          return JSON.parse(log);
        } catch {
          return {};
        }
      }) || [];
      let filteredLogs = logs.filter((record) => record !== null && typeof record === "object");
      const {
        fromDate,
        toDate,
        logLevel,
        filters,
        returnPaginationResults: returnPaginationResultsInput,
        page: pageInput,
        perPage: perPageInput
      } = params || {};
      const page = pageInput === 0 ? 1 : pageInput ?? 1;
      const perPage = perPageInput ?? 100;
      const returnPaginationResults = returnPaginationResultsInput ?? true;
      if (filters) {
        filteredLogs = filteredLogs.filter(
          (log) => Object.entries(filters || {}).every(([key, value]) => log[key] === value)
        );
      }
      if (logLevel) {
        filteredLogs = filteredLogs.filter((log) => log.level === logLevel);
      }
      if (fromDate) {
        filteredLogs = filteredLogs.filter((log) => new Date(log.time)?.getTime() >= fromDate.getTime());
      }
      if (toDate) {
        filteredLogs = filteredLogs.filter((log) => new Date(log.time)?.getTime() <= toDate.getTime());
      }
      if (!returnPaginationResults) {
        return {
          logs: filteredLogs,
          total: filteredLogs.length,
          page,
          perPage: filteredLogs.length,
          hasMore: false
        };
      }
      const total = filteredLogs.length;
      const resolvedPerPage = perPage || 100;
      const start = (page - 1) * resolvedPerPage;
      const end = start + resolvedPerPage;
      const paginatedLogs = filteredLogs.slice(start, end);
      const hasMore = end < total;
      return {
        logs: paginatedLogs,
        total,
        page,
        perPage: resolvedPerPage,
        hasMore
      };
    } catch (error) {
      console.error("Error getting logs from Upstash:", error);
      return {
        logs: [],
        total: 0,
        page: params?.page ?? 1,
        perPage: params?.perPage ?? 100,
        hasMore: false
      };
    }
  }
  async getLogsByRunId({
    runId,
    fromDate,
    toDate,
    logLevel,
    filters,
    page: pageInput,
    perPage: perPageInput
  }) {
    try {
      const page = pageInput === 0 ? 1 : pageInput ?? 1;
      const perPage = perPageInput ?? 100;
      const allLogs = await this.getLogs({ fromDate, toDate, logLevel, filters, returnPaginationResults: false });
      const logs = allLogs?.logs?.filter((log) => log.runId === runId) || [];
      const total = logs.length;
      const resolvedPerPage = perPage || 100;
      const start = (page - 1) * resolvedPerPage;
      const end = start + resolvedPerPage;
      const paginatedLogs = logs.slice(start, end);
      const hasMore = end < total;
      return {
        logs: paginatedLogs,
        total,
        page,
        perPage: resolvedPerPage,
        hasMore
      };
    } catch (error) {
      console.error("Error getting logs by runId from Upstash:", error);
      return {
        logs: [],
        total: 0,
        page: pageInput ?? 1,
        perPage: perPageInput ?? 100,
        hasMore: false
      };
    }
  }
};

export { UpstashTransport };
