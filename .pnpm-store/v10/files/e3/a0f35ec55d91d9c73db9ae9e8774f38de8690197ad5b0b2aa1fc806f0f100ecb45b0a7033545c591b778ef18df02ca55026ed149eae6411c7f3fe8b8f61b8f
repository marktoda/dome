import { LoggerTransport } from '@mastra/core/logger';

// src/http/index.ts
var HttpTransport = class extends LoggerTransport {
  url;
  method;
  headers;
  batchSize;
  flushInterval;
  timeout;
  retryOptions;
  logBuffer;
  lastFlush;
  flushIntervalId;
  constructor(options) {
    super({ objectMode: true });
    if (!options.url) {
      throw new Error("HTTP URL is required");
    }
    this.url = options.url;
    this.method = options.method || "POST";
    this.headers = {
      "Content-Type": "application/json",
      ...options.headers
    };
    this.batchSize = options.batchSize || 100;
    this.flushInterval = options.flushInterval || 1e4;
    this.timeout = options.timeout || 3e4;
    this.retryOptions = {
      maxRetries: options.retryOptions?.maxRetries || 3,
      retryDelay: options.retryOptions?.retryDelay || 1e3,
      exponentialBackoff: options.retryOptions?.exponentialBackoff || true
    };
    this.logBuffer = [];
    this.lastFlush = Date.now();
    this.flushIntervalId = setInterval(() => {
      this._flush().catch((err) => {
        console.error("Error flushing logs to HTTP endpoint:", err);
      });
    }, this.flushInterval);
  }
  async makeHttpRequest(data, retryCount = 0) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);
    try {
      const body = JSON.stringify({ logs: data });
      const response = await fetch(this.url, {
        method: this.method,
        headers: this.headers,
        body,
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      return response;
    } catch (error) {
      clearTimeout(timeoutId);
      if (retryCount < this.retryOptions.maxRetries) {
        const delay = this.retryOptions.exponentialBackoff ? this.retryOptions.retryDelay * Math.pow(2, retryCount) : this.retryOptions.retryDelay;
        await new Promise((resolve) => setTimeout(resolve, delay));
        return this.makeHttpRequest(data, retryCount + 1);
      }
      throw error;
    }
  }
  async _flush() {
    if (this.logBuffer.length === 0) {
      return;
    }
    const now = Date.now();
    const logs = this.logBuffer.splice(0, this.batchSize);
    try {
      await this.makeHttpRequest(logs);
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
          console.error("Error flushing logs to HTTP endpoint:", err);
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
    console.warn(
      "HttpTransport.getLogs: This transport is write-only. Override this method to implement log retrieval."
    );
    return {
      logs: [],
      total: 0,
      page: params?.page ?? 1,
      perPage: params?.perPage ?? 100,
      hasMore: false
    };
  }
  async getLogsByRunId({
    runId: _runId,
    fromDate: _fromDate,
    toDate: _toDate,
    logLevel: _logLevel,
    filters: _filters,
    page,
    perPage
  }) {
    console.warn(
      "HttpTransport.getLogsByRunId: This transport is write-only. Override this method to implement log retrieval."
    );
    return {
      logs: [],
      total: 0,
      page: page ?? 1,
      perPage: perPage ?? 100,
      hasMore: false
    };
  }
  // Utility methods
  getBufferedLogs() {
    return [...this.logBuffer];
  }
  clearBuffer() {
    this.logBuffer = [];
  }
  getLastFlushTime() {
    return this.lastFlush;
  }
};

export { HttpTransport };
