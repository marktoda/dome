import { getLogger } from "@dome/logging";
import { AgentState, Document } from "../types";
import { SearchService, SearchOptions } from "../services/searchService";
import { ObservabilityService } from "../services/observabilityService";

/**
 * Retrieve node: fetches relevant documents for each task in full parallel, applies contextual
 * compression, and flags tasks that may benefit from query widening.
 */
export const retrieve = async (state: AgentState, env: Env): Promise<AgentState> => {
  const logger = getLogger().child({ node: "retrieve" });
  const startMs = performance.now();

  // ──────────────────────────────────────────────────────────────
  // Observability
  // ──────────────────────────────────────────────────────────────
  const traceId = state.metadata?.traceId ?? "";
  const spanId = ObservabilityService.startSpan(env, traceId, "retrieve", state);

  const taskIds = state.taskIds ?? [];
  const taskEntities = state.taskEntities ?? {};

  if (taskIds.length === 0) {
    return finish(state, env, traceId, spanId, startMs, [], {});
  }

  const searchService = SearchService.fromEnv(env);
  const MIN_QUERY_LENGTH = 3;

  // ---------------------------------------------------------------------------
  // Launch searches in parallel (Promise.all) – no concurrency limiter needed
  // ---------------------------------------------------------------------------
  const results = await Promise.all(taskIds.map(async taskId => {
    const task = taskEntities[taskId];
    if (!task) return emptyTaskResult(taskId);

    const query = (task.rewrittenQuery || task.originalQuery || "").trim();
    if (query.length < MIN_QUERY_LENGTH) {
      logger.warn({ taskId, query }, "Query too short – skipping");
      return emptyTaskResult(taskId);
    }

    try {
      const options = buildSearchOptions(state.userId, query, task);
      const docs = await searchService.search(options);
      const contextual = await applyContextualCompression(docs, query);
      const quality = assessRetrievalQuality(contextual);
      const needsWide = determineIfWideningNeeded(quality, task.wideningAttempts ?? 0);
      return { taskId, docs: contextual, needsWidening: needsWide } as TaskResult;
    } catch (err) {
      logger.error({ err, taskId, query }, "Search failed");
      return emptyTaskResult(taskId);
    }
  }));

  // Aggregate docs & widening flags
  const docs = results.flatMap(r => r.docs);
  const wideningFlags = Object.fromEntries(results.map(r => [r.taskId, r.needsWidening]));
  const updatedTaskEntities = applyWideningFlags(taskEntities, wideningFlags);

  const newState: AgentState = { ...state, docs, taskEntities: updatedTaskEntities };
  return finish(newState, env, traceId, spanId, startMs, docs, wideningFlags);
};

// ──────────────────────────────────────────────────────────────
// Helper types & functions
// ──────────────────────────────────────────────────────────────
interface TaskResult { taskId: string; docs: Document[]; needsWidening: boolean; }
const emptyTaskResult = (taskId: string): TaskResult => ({ taskId, docs: [], needsWidening: false });

function buildSearchOptions(userId: string, query: string, task: any): SearchOptions {
  const base: SearchOptions = {
    userId,
    query,
    limit: 10,
    minRelevance: 0.5,
    expandSynonyms: false,
    includeRelated: false,
  };
  if (!task.wideningParams) return base;

  const { minRelevance, expandSynonyms, includeRelated, startDate, endDate, category } = task.wideningParams;
  return {
    ...base,
    minRelevance: minRelevance ?? base.minRelevance,
    expandSynonyms: expandSynonyms ?? base.expandSynonyms,
    includeRelated: includeRelated ?? base.includeRelated,
    startDate,
    endDate,
    category,
  };
}

function applyWideningFlags(entities: Record<string, any>, flags: Record<string, boolean>) {
  const out = { ...entities };
  for (const [id, flag] of Object.entries(flags)) if (out[id]) out[id] = { ...out[id], needsWidening: flag };
  return out;
}

async function applyContextualCompression(docs: Document[], _query: string): Promise<Document[]> {
  return SearchService.rankAndFilterDocuments(docs);
}

function assessRetrievalQuality(docs: Document[]): "high" | "low" | "none" {
  if (docs.length === 0) return "none";
  const avg = docs.reduce((s, d) => s + d.metadata.relevanceScore, 0) / docs.length;
  if (avg > 0.7 && docs.length >= 3) return "high";
  if (avg > 0.4 || docs.length >= 2) return "low";
  return "none";
}

function determineIfWideningNeeded(quality: "high" | "low" | "none", attempts: number): boolean {
  if (quality === "high" || attempts >= 2) return false;
  if (quality === "none" && attempts === 0) return true;
  if (quality === "low" && attempts === 1) return true;
  if (quality === "none" && attempts === 1) return true; // second try when still none
  return false;
}

function finish(
  state: AgentState,
  env: Env,
  traceId: string,
  spanId: string,
  start: number,
  docs: Document[],
  widening: Record<string, boolean>,
): AgentState {
  const ms = performance.now() - start;
  ObservabilityService.endSpan(env, traceId, spanId, "retrieve", state, state, ms);
  ObservabilityService.logEvent(env, traceId, spanId, "retrieval_complete", {
    taskCount: Object.keys(widening).length,
    totalDocumentCount: docs.length,
    executionTimeMs: ms,
    hasDocs: docs.length > 0,
  });
  return {
    ...state,
    metadata: { ...state.metadata, nodeTimings: { ...(state.metadata?.nodeTimings ?? {}), retrieve: ms } },
  };
}
