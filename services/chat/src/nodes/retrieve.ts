import { getLogger } from '@dome/logging';
import { RetrievalToolType, RETRIEVAL_TOOLS } from '../tools';
import { LangGraphRunnableConfig } from "@langchain/langgraph";
import { AgentState, RetrievalTask, DocumentChunk } from '../types';
import { ObservabilityService } from '../services/observabilityService';
import { toDomeError } from '../utils/errors';

/**
 * Retrieve Node - Unified Retrieval Dispatcher
 *
 * Dispatches retrieval operations to appropriate specialized retrievers based on
 * selections made by the retrievalSelector node. Executes retrievals in parallel
 * for efficiency and combines the results.
 *
 * @param state Current agent state
 * @param cfg LangGraph runnable configuration
 * @param env Environment variables
 * @returns Updated agent state with retrieval results
 */
export async function retrieve(
  state: AgentState,
  cfg: LangGraphRunnableConfig,
  env: Env,
): Promise<Partial<AgentState>> {
  const t0 = performance.now();
  const logger = getLogger().child({ component: 'retrieve' });

  // Verify that retrievalSelections and tasks are available
  if (!state.retrievals) {
    logger.warn("Retrieval selections or tasks not found in state");
    return {
      metadata: {
        currentNode: "retrieve",
        executionTimeMs: 0,
        nodeTimings: {
          ...state.metadata?.nodeTimings,
          retrieve: 0
        },
        errors: [{
          node: "retrieve",
          message: "Retrieval selections or split tasks not found in state",
          timestamp: Date.now()
        }]
      }
    };
  }

  logger.info({
    selectionCount: state.retrievals.length
  }, "Starting retrieval process");

  /* ------------------------------------------------------------------ */
  /*  Trace / logging setup                                             */
  /* ------------------------------------------------------------------ */
  const traceId = state.metadata?.traceId ?? crypto.randomUUID();
  const spanId = ObservabilityService.startSpan(env, traceId, "retrieve", state);
  const logEvt = (e: string, p: Record<string, unknown>) =>
    ObservabilityService.logEvent(env, traceId, spanId, e, p);

  try {
    /* ------------------------------------------------------------------ */
    /*  Process each retrieval in parallel                                */
    /* ------------------------------------------------------------------ */
    // For each task with retrieval selections, execute the retrievals
    const retrievalPromises = state.retrievals.map(async (retrieval) => {
      const retriever = RETRIEVAL_TOOLS[retrieval.category]


      // Log the retrieval operation starting
      logEvt("retrieval_started", {
        query: retrieval.query,
        type: retrieval.category,
      });
      const res = await retriever.retrieve({
        query: retrieval.query,
        userId: state.userId,
      }, env);
      const docs = retriever.toDocuments(res);
      return {
        ...retrieval,
        docs,
      }
    });


    // Wait for all retrievals to complete
    const results: RetrievalTask[] = await Promise.all(retrievalPromises);

    /* ------------------------------------------------------------------ */
    /*  Finish, log, and return the state update                          */
    /* ------------------------------------------------------------------ */
    const elapsed = performance.now() - t0;
    ObservabilityService.endSpan(env, traceId, spanId, "retrieve", state, state, elapsed);

    logger.info({
      elapsedMs: elapsed,
      totalChunks: results.length,
    }, "Retrieval process complete");

    return {
      retrievals: results,
      metadata: {
        currentNode: "retrieve",
        executionTimeMs: elapsed,
        nodeTimings: {
          ...state.metadata?.nodeTimings,
          retrieve: elapsed
        }
      }
    };
  } catch (error) {
    // Handle errors
    const domeError = toDomeError(error);
    logger.error({ err: domeError }, "Error in retrieve node");

    // Format error with required properties
    const formattedError = {
      node: "retrieve",
      message: domeError.message || "Error in retrieve node",
      timestamp: Date.now()
    };

    const elapsed = performance.now() - t0;
    ObservabilityService.endSpan(env, traceId, spanId, "retrieve", state,
      { ...state, metadata: { ...state.metadata, errors: [formattedError] } },
      elapsed
    );

    return {
      metadata: {
        currentNode: "retrieve",
        executionTimeMs: elapsed,
        errors: [formattedError],
        nodeTimings: {
          ...state.metadata?.nodeTimings,
          retrieve: elapsed
        }
      }
    };
  }
}
