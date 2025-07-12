'use strict';

var chunkPZQDCRPV_cjs = require('./chunk-PZQDCRPV.cjs');
var chunk2KZFMI6P_cjs = require('./chunk-2KZFMI6P.cjs');
var chunk75ZPJI57_cjs = require('./chunk-75ZPJI57.cjs');

// src/server/handlers/vector.ts
var vector_exports = {};
chunk75ZPJI57_cjs.__export(vector_exports, {
  createIndex: () => createIndex,
  deleteIndex: () => deleteIndex,
  describeIndex: () => describeIndex,
  listIndexes: () => listIndexes,
  queryVectors: () => queryVectors,
  upsertVectors: () => upsertVectors
});
function getVector(mastra, vectorName) {
  if (!vectorName) {
    throw new chunk2KZFMI6P_cjs.HTTPException(400, { message: "Vector name is required" });
  }
  const vector = mastra.getVector(vectorName);
  if (!vector) {
    throw new chunk2KZFMI6P_cjs.HTTPException(404, { message: `Vector store ${vectorName} not found` });
  }
  return vector;
}
async function upsertVectors({ mastra, vectorName, index }) {
  try {
    if (!index?.indexName || !index?.vectors || !Array.isArray(index.vectors)) {
      throw new chunk2KZFMI6P_cjs.HTTPException(400, { message: "Invalid request index. indexName and vectors array are required." });
    }
    const vector = getVector(mastra, vectorName);
    const result = await vector.upsert(index);
    return { ids: result };
  } catch (error) {
    return chunkPZQDCRPV_cjs.handleError(error, "Error upserting vectors");
  }
}
async function createIndex({
  mastra,
  vectorName,
  index
}) {
  try {
    const { indexName, dimension, metric } = index;
    if (!indexName || typeof dimension !== "number" || dimension <= 0) {
      throw new chunk2KZFMI6P_cjs.HTTPException(400, {
        message: "Invalid request index, indexName and positive dimension number are required."
      });
    }
    if (metric && !["cosine", "euclidean", "dotproduct"].includes(metric)) {
      throw new chunk2KZFMI6P_cjs.HTTPException(400, { message: "Invalid metric. Must be one of: cosine, euclidean, dotproduct" });
    }
    const vector = getVector(mastra, vectorName);
    await vector.createIndex({ indexName, dimension, metric });
    return { success: true };
  } catch (error) {
    return chunkPZQDCRPV_cjs.handleError(error, "Error creating index");
  }
}
async function queryVectors({
  mastra,
  vectorName,
  query
}) {
  try {
    if (!query?.indexName || !query?.queryVector || !Array.isArray(query.queryVector)) {
      throw new chunk2KZFMI6P_cjs.HTTPException(400, { message: "Invalid request query. indexName and queryVector array are required." });
    }
    const vector = getVector(mastra, vectorName);
    const results = await vector.query(query);
    return results;
  } catch (error) {
    return chunkPZQDCRPV_cjs.handleError(error, "Error querying vectors");
  }
}
async function listIndexes({ mastra, vectorName }) {
  try {
    const vector = getVector(mastra, vectorName);
    const indexes = await vector.listIndexes();
    return indexes.filter(Boolean);
  } catch (error) {
    return chunkPZQDCRPV_cjs.handleError(error, "Error listing indexes");
  }
}
async function describeIndex({
  mastra,
  vectorName,
  indexName
}) {
  try {
    if (!indexName) {
      throw new chunk2KZFMI6P_cjs.HTTPException(400, { message: "Index name is required" });
    }
    const vector = getVector(mastra, vectorName);
    const stats = await vector.describeIndex({ indexName });
    return {
      dimension: stats.dimension,
      count: stats.count,
      metric: stats.metric?.toLowerCase()
    };
  } catch (error) {
    return chunkPZQDCRPV_cjs.handleError(error, "Error describing index");
  }
}
async function deleteIndex({
  mastra,
  vectorName,
  indexName
}) {
  try {
    if (!indexName) {
      throw new chunk2KZFMI6P_cjs.HTTPException(400, { message: "Index name is required" });
    }
    const vector = getVector(mastra, vectorName);
    await vector.deleteIndex({ indexName });
    return { success: true };
  } catch (error) {
    return chunkPZQDCRPV_cjs.handleError(error, "Error deleting index");
  }
}

exports.createIndex = createIndex;
exports.deleteIndex = deleteIndex;
exports.describeIndex = describeIndex;
exports.listIndexes = listIndexes;
exports.queryVectors = queryVectors;
exports.upsertVectors = upsertVectors;
exports.vector_exports = vector_exports;
