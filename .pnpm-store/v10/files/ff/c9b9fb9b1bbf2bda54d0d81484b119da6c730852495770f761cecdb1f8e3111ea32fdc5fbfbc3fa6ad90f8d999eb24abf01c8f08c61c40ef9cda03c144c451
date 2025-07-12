'use strict';

var fs = require('fs');
var logger = require('@mastra/core/logger');

// src/file/index.ts
var FileTransport = class extends logger.LoggerTransport {
  path;
  fileStream;
  constructor({ path }) {
    super({ objectMode: true });
    this.path = path;
    if (!fs.existsSync(this.path)) {
      console.log(this.path);
      throw new Error("File path does not exist");
    }
    this.fileStream = fs.createWriteStream(this.path, { flags: "a" });
  }
  _transform(chunk, _encoding, callback) {
    try {
      this.fileStream.write(chunk);
    } catch (error) {
      console.error("Error parsing log entry:", error);
    }
    callback(null, chunk);
  }
  _flush(callback) {
    this.fileStream.end(() => {
      callback();
    });
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
  // Clean up resources
  _destroy(error, callback) {
    if (this.fileStream) {
      this.fileStream.destroy(error);
    }
    callback(error);
  }
  async getLogs(params) {
    try {
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
      const logs = fs.readFileSync(this.path, "utf8").split("\n").filter(Boolean).map((log) => JSON.parse(log));
      let filteredLogs = logs.filter((record) => record !== null && typeof record === "object");
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
      console.error("Error getting logs from file:", error);
      return {
        logs: [],
        total: 0,
        page: 0,
        perPage: 0,
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
      const allLogs = await this.getLogs({ fromDate, toDate, logLevel, filters });
      const logs = allLogs?.logs?.filter((log) => log?.runId === runId) || [];
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
      console.error("Error getting logs by runId from file:", error);
      return {
        logs: [],
        total: 0,
        page: 0,
        perPage: 0,
        hasMore: false
      };
    }
  }
};

exports.FileTransport = FileTransport;
