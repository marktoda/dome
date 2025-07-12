import { handleError } from './chunk-LF7P5PLR.js';
import { HTTPException } from './chunk-LCM566I4.js';
import { __export } from './chunk-MLKGABMK.js';

// src/server/handlers/vector.ts
var vector_exports = {};
__export(vector_exports, {
  createIndex: () => createIndex,
  deleteIndex: () => deleteIndex,
  describeIndex: () => describeIndex,
  listIndexes: () => listIndexes,
  queryVectors: () => queryVectors,
  upsertVectors: () => upsertVectors
});
function getVector(mastra, vectorName) {
  if (!vectorName) {
    throw new HTTPException(400, { message: "Vector name is required" });
  }
  const vector = mastra.getVector(vectorName);
  if (!vector) {
    throw new HTTPException(404, { message: `Vector store ${vectorName} not found` });
  }
  return vector;
}
async function upsertVectors({ mastra, vectorName, index }) {
  try {
    if (!index?.indexName || !index?.vectors || !Array.isArray(index.vectors)) {
      throw new HTTPException(400, { message: "Invalid request index. indexName and vectors array are required." });
    }
    const vector = getVector(mastra, vectorName);
    const result = await vector.upsert(index);
    return { ids: result };
  } catch (error) {
    return handleError(error, "Error upserting vectors");
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
      throw new HTTPException(400, {
        message: "Invalid request index, indexName and positive dimension number are required."
      });
    }
    if (metric && !["cosine", "euclidean", "dotproduct"].includes(metric)) {
      throw new HTTPException(400, { message: "Invalid metric. Must be one of: cosine, euclidean, dotproduct" });
    }
    const vector = getVector(mastra, vectorName);
    await vector.createIndex({ indexName, dimension, metric });
    return { success: true };
  } catch (error) {
    return handleError(error, "Error creating index");
  }
}
async function queryVectors({
  mastra,
  vectorName,
  query
}) {
  try {
    if (!query?.indexName || !query?.queryVector || !Array.isArray(query.queryVector)) {
      throw new HTTPException(400, { message: "Invalid request query. indexName and queryVector array are required." });
    }
    const vector = getVector(mastra, vectorName);
    const results = await vector.query(query);
    return results;
  } catch (error) {
    return handleError(error, "Error querying vectors");
  }
}
async function listIndexes({ mastra, vectorName }) {
  try {
    const vector = getVector(mastra, vectorName);
    const indexes = await vector.listIndexes();
    return indexes.filter(Boolean);
  } catch (error) {
    return handleError(error, "Error listing indexes");
  }
}
async function describeIndex({
  mastra,
  vectorName,
  indexName
}) {
  try {
    if (!indexName) {
      throw new HTTPException(400, { message: "Index name is required" });
    }
    const vector = getVector(mastra, vectorName);
    const stats = await vector.describeIndex({ indexName });
    return {
      dimension: stats.dimension,
      count: stats.count,
      metric: stats.metric?.toLowerCase()
    };
  } catch (error) {
    return handleError(error, "Error describing index");
  }
}
async function deleteIndex({
  mastra,
  vectorName,
  indexName
}) {
  try {
    if (!indexName) {
      throw new HTTPException(400, { message: "Index name is required" });
    }
    const vector = getVector(mastra, vectorName);
    await vector.deleteIndex({ indexName });
    return { success: true };
  } catch (error) {
    return handleError(error, "Error deleting index");
  }
}

export { createIndex, deleteIndex, describeIndex, listIndexes, queryVectors, upsertVectors, vector_exports };
