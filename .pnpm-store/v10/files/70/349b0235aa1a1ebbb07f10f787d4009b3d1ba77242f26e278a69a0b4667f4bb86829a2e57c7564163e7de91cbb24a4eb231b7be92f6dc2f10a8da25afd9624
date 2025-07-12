import { MastraError } from './chunk-6UNGH46J.js';
import { MastraBase } from './chunk-5IEKR756.js';

// src/vector/vector.ts
var MastraVector = class extends MastraBase {
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
      const mastraError = new MastraError(
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
      const mastraError = new MastraError({
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
      const mastraError = new MastraError({
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

export { MastraVector };
