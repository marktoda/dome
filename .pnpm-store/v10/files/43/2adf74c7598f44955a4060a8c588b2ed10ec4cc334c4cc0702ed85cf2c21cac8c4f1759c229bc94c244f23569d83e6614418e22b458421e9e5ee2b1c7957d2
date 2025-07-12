'use strict';

var chunkB6TOBUS6_cjs = require('./chunk-B6TOBUS6.cjs');
var chunkP3Q73CAW_cjs = require('./chunk-P3Q73CAW.cjs');

// src/vector/vector.ts
var MastraVector = class extends chunkP3Q73CAW_cjs.MastraBase {
  constructor() {
    super({ name: "MastraVector", component: "VECTOR" });
  }
  get indexSeparator() {
    return "_";
  }
  async validateExistingIndex(indexName, dimension, metric) {
    let info;
    try {
      info = await this.describeIndex({ indexName });
    } catch (infoError) {
      const mastraError = new chunkB6TOBUS6_cjs.MastraError(
        {
          id: "VECTOR_VALIDATE_INDEX_FETCH_FAILED",
          text: `Index "${indexName}" already exists, but failed to fetch index info for dimension check.`,
          domain: "MASTRA_VECTOR" /* MASTRA_VECTOR */,
          category: "SYSTEM" /* SYSTEM */,
          details: { indexName }
        },
        infoError
      );
      this.logger?.trackException(mastraError);
      this.logger?.error(mastraError.toString());
      throw mastraError;
    }
    const existingDim = info?.dimension;
    const existingMetric = info?.metric;
    if (existingDim === dimension) {
      this.logger?.info(
        `Index "${indexName}" already exists with ${existingDim} dimensions and metric ${existingMetric}, skipping creation.`
      );
      if (existingMetric !== metric) {
        this.logger?.warn(
          `Attempted to create index with metric "${metric}", but index already exists with metric "${existingMetric}". To use a different metric, delete and recreate the index.`
        );
      }
    } else if (info) {
      const mastraError = new chunkB6TOBUS6_cjs.MastraError({
        id: "VECTOR_VALIDATE_INDEX_DIMENSION_MISMATCH",
        text: `Index "${indexName}" already exists with ${existingDim} dimensions, but ${dimension} dimensions were requested`,
        domain: "MASTRA_VECTOR" /* MASTRA_VECTOR */,
        category: "USER" /* USER */,
        details: { indexName, existingDim, requestedDim: dimension }
      });
      this.logger?.trackException(mastraError);
      this.logger?.error(mastraError.toString());
      throw mastraError;
    } else {
      const mastraError = new chunkB6TOBUS6_cjs.MastraError({
        id: "VECTOR_VALIDATE_INDEX_NO_DIMENSION",
        text: `Index "${indexName}" already exists, but could not retrieve its dimensions for validation.`,
        domain: "MASTRA_VECTOR" /* MASTRA_VECTOR */,
        category: "SYSTEM" /* SYSTEM */,
        details: { indexName }
      });
      this.logger?.trackException(mastraError);
      this.logger?.error(mastraError.toString());
      throw mastraError;
    }
  }
};

exports.MastraVector = MastraVector;
