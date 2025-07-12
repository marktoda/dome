'use strict';

var chunkQQ5K5TZE_cjs = require('./chunk-QQ5K5TZE.cjs');
var chunkP3Q73CAW_cjs = require('./chunk-P3Q73CAW.cjs');

// src/storage/base.ts
var MastraStorage = class extends chunkP3Q73CAW_cjs.MastraBase {
  /** @deprecated import from { TABLE_WORKFLOW_SNAPSHOT } '@mastra/core/storage' instead */
  static TABLE_WORKFLOW_SNAPSHOT = chunkQQ5K5TZE_cjs.TABLE_WORKFLOW_SNAPSHOT;
  /** @deprecated import from { TABLE_EVALS } '@mastra/core/storage' instead */
  static TABLE_EVALS = chunkQQ5K5TZE_cjs.TABLE_EVALS;
  /** @deprecated import from { TABLE_MESSAGES } '@mastra/core/storage' instead */
  static TABLE_MESSAGES = chunkQQ5K5TZE_cjs.TABLE_MESSAGES;
  /** @deprecated import from { TABLE_THREADS } '@mastra/core/storage' instead */
  static TABLE_THREADS = chunkQQ5K5TZE_cjs.TABLE_THREADS;
  /** @deprecated import { TABLE_TRACES } from '@mastra/core/storage' instead */
  static TABLE_TRACES = chunkQQ5K5TZE_cjs.TABLE_TRACES;
  hasInitialized = null;
  shouldCacheInit = true;
  constructor({ name }) {
    super({
      component: "STORAGE",
      name
    });
  }
  get supports() {
    return {
      selectByIncludeResourceScope: false,
      resourceWorkingMemory: false
    };
  }
  ensureDate(date) {
    if (!date) return void 0;
    return date instanceof Date ? date : new Date(date);
  }
  serializeDate(date) {
    if (!date) return void 0;
    const dateObj = this.ensureDate(date);
    return dateObj?.toISOString();
  }
  /**
   * Resolves limit for how many messages to fetch
   *
   * @param last The number of messages to fetch
   * @param defaultLimit The default limit to use if last is not provided
   * @returns The resolved limit
   */
  resolveMessageLimit({
    last,
    defaultLimit
  }) {
    if (typeof last === "number") return Math.max(0, last);
    if (last === false) return 0;
    return defaultLimit;
  }
  getSqlType(type) {
    switch (type) {
      case "text":
        return "TEXT";
      case "timestamp":
        return "TIMESTAMP";
      case "integer":
        return "INTEGER";
      case "bigint":
        return "BIGINT";
      case "jsonb":
        return "JSONB";
      default:
        return "TEXT";
    }
  }
  getDefaultValue(type) {
    switch (type) {
      case "text":
      case "uuid":
        return "DEFAULT ''";
      case "timestamp":
        return "DEFAULT '1970-01-01 00:00:00'";
      case "integer":
      case "bigint":
        return "DEFAULT 0";
      case "jsonb":
        return "DEFAULT '{}'";
      default:
        return "DEFAULT ''";
    }
  }
  batchTraceInsert({ records }) {
    return this.batchInsert({ tableName: chunkQQ5K5TZE_cjs.TABLE_TRACES, records });
  }
  async getResourceById(_) {
    throw new Error(
      `Resource working memory is not supported by this storage adapter (${this.constructor.name}). Supported storage adapters: LibSQL (@mastra/libsql), PostgreSQL (@mastra/pg), Upstash (@mastra/upstash). To use per-resource working memory, switch to one of these supported storage adapters.`
    );
  }
  async saveResource(_) {
    throw new Error(
      `Resource working memory is not supported by this storage adapter (${this.constructor.name}). Supported storage adapters: LibSQL (@mastra/libsql), PostgreSQL (@mastra/pg), Upstash (@mastra/upstash). To use per-resource working memory, switch to one of these supported storage adapters.`
    );
  }
  async updateResource(_) {
    throw new Error(
      `Resource working memory is not supported by this storage adapter (${this.constructor.name}). Supported storage adapters: LibSQL (@mastra/libsql), PostgreSQL (@mastra/pg), Upstash (@mastra/upstash). To use per-resource working memory, switch to one of these supported storage adapters.`
    );
  }
  async init() {
    if (this.shouldCacheInit && await this.hasInitialized) {
      return;
    }
    const tableCreationTasks = [
      this.createTable({
        tableName: chunkQQ5K5TZE_cjs.TABLE_WORKFLOW_SNAPSHOT,
        schema: chunkQQ5K5TZE_cjs.TABLE_SCHEMAS[chunkQQ5K5TZE_cjs.TABLE_WORKFLOW_SNAPSHOT]
      }),
      this.createTable({
        tableName: chunkQQ5K5TZE_cjs.TABLE_EVALS,
        schema: chunkQQ5K5TZE_cjs.TABLE_SCHEMAS[chunkQQ5K5TZE_cjs.TABLE_EVALS]
      }),
      this.createTable({
        tableName: chunkQQ5K5TZE_cjs.TABLE_THREADS,
        schema: chunkQQ5K5TZE_cjs.TABLE_SCHEMAS[chunkQQ5K5TZE_cjs.TABLE_THREADS]
      }),
      this.createTable({
        tableName: chunkQQ5K5TZE_cjs.TABLE_MESSAGES,
        schema: chunkQQ5K5TZE_cjs.TABLE_SCHEMAS[chunkQQ5K5TZE_cjs.TABLE_MESSAGES]
      }),
      this.createTable({
        tableName: chunkQQ5K5TZE_cjs.TABLE_TRACES,
        schema: chunkQQ5K5TZE_cjs.TABLE_SCHEMAS[chunkQQ5K5TZE_cjs.TABLE_TRACES]
      })
    ];
    if (this.supports.resourceWorkingMemory) {
      tableCreationTasks.push(
        this.createTable({
          tableName: chunkQQ5K5TZE_cjs.TABLE_RESOURCES,
          schema: chunkQQ5K5TZE_cjs.TABLE_SCHEMAS[chunkQQ5K5TZE_cjs.TABLE_RESOURCES]
        })
      );
    }
    this.hasInitialized = Promise.all(tableCreationTasks).then(() => true);
    await this.hasInitialized;
    await this?.alterTable?.({
      tableName: chunkQQ5K5TZE_cjs.TABLE_MESSAGES,
      schema: chunkQQ5K5TZE_cjs.TABLE_SCHEMAS[chunkQQ5K5TZE_cjs.TABLE_MESSAGES],
      ifNotExists: ["resourceId"]
    });
  }
  async persistWorkflowSnapshot({
    workflowName,
    runId,
    snapshot
  }) {
    await this.init();
    const data = {
      workflow_name: workflowName,
      run_id: runId,
      snapshot,
      createdAt: /* @__PURE__ */ new Date(),
      updatedAt: /* @__PURE__ */ new Date()
    };
    this.logger.debug("Persisting workflow snapshot", { workflowName, runId, data });
    await this.insert({
      tableName: chunkQQ5K5TZE_cjs.TABLE_WORKFLOW_SNAPSHOT,
      record: data
    });
  }
  async loadWorkflowSnapshot({
    workflowName,
    runId
  }) {
    if (!this.hasInitialized) {
      await this.init();
    }
    this.logger.debug("Loading workflow snapshot", { workflowName, runId });
    const d = await this.load({
      tableName: chunkQQ5K5TZE_cjs.TABLE_WORKFLOW_SNAPSHOT,
      keys: { workflow_name: workflowName, run_id: runId }
    });
    return d ? d.snapshot : null;
  }
};

exports.MastraStorage = MastraStorage;
