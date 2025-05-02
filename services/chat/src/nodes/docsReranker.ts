import { getLogger } from '@dome/logging';
import { LangGraphRunnableConfig } from "@langchain/langgraph";
import { AgentState } from '../types';
import { createReranker } from '../utils/rerankerUtils';
import { ObservabilityService } from '../services/observabilityService';
import { toDomeError } from '../utils/errors';

/**
 * Model used for documentation reranking
 * This simulates a cross-encoder model specialized for documentation relevance
 */
const DOCS_RERANKER_MODEL = 'bge-reranker-docs';

/**
 * Maximum number of docs chunks to return after reranking
 */
const MAX_DOCS_CHUNKS = 8;

/**
 * Threshold score for docs chunks (0-1)
 * Chunks with scores below this threshold will be filtered out
 */
const DOCS_SCORE_THRESHOLD = 0.22;

/**
 * Docs Reranker Node
 * 
 * Reranks Notion documents retrieved from the docs repository to improve
 * relevance ranking. Uses a specialized cross-encoder model that
 * considers both the query and document content to compute a more accurate
 * relevance score.
 * 
 * The node:
 * 1. Takes initial docs retrieval results from the `retrieve` node
 * 2. Applies a cross-encoder reranking model to improve relevance scoring
 * 3. Selects the top 8 most relevant chunks based on reranker scores
 * 4. Updates agent state with the reranked results
 * 
 * This improves the quality of documentation provided to the LLM when
 * generating responses, ensuring that the most relevant parts of the 
 * documentation are prioritized.
 * 
 * @param state Current agent state
 * @param cfg LangGraph runnable configuration
 * @param env Environment bindings
 * @returns Updated agent state with reranked docs results
 */
export async function docsReranker(
  state: AgentState,
  cfg: LangGraphRunnableConfig,
  env: Env,
): Promise<Partial<AgentState>> {
  const t0 = performance.now();
  const logger = getLogger().child({ component: 'docsReranker' });
  
  // Skip if no retrieval results or docs results
  if (!state.retrievalResults || !state.retrievalResults.docs) {
    logger.info("No docs retrieval results found to rerank");
    return {
      metadata: {
        currentNode: "docsReranker",
        executionTimeMs: 0,
        nodeTimings: {
          ...state.metadata?.nodeTimings,
          docsReranker: 0
        }
      }
    };
  }
  
  // Extract last user message to use as query
  const lastUserMessage = [...state.messages].reverse().find(msg => msg.role === 'user');
  if (!lastUserMessage) {
    logger.warn("No user message found for reranking context");
    return {
      metadata: {
        currentNode: "docsReranker",
        executionTimeMs: 0,
        nodeTimings: {
          ...state.metadata?.nodeTimings,
          docsReranker: 0
        }
      }
    };
  }
  
  const query = lastUserMessage.content;
  
  /* ------------------------------------------------------------------ */
  /*  Trace / logging setup                                             */
  /* ------------------------------------------------------------------ */
  const traceId = state.metadata?.traceId ?? crypto.randomUUID();
  const spanId = ObservabilityService.startSpan(env, traceId, "docsReranker", state);
  
  try {
    logger.info({
      query,
      chunkCount: state.retrievalResults.docs.chunks.length,
    }, "Starting docs reranking");
    
    // Create reranker instance
    const reranker = createReranker({
      name: 'docs',
      model: DOCS_RERANKER_MODEL,
      scoreThreshold: DOCS_SCORE_THRESHOLD,
      maxResults: MAX_DOCS_CHUNKS
    });
    
    // Perform reranking
    const rerankedResults = await reranker(
      state.retrievalResults.docs,
      query,
      env,
      traceId,
      spanId
    );
    
    // Log results
    logger.info({
      originalChunks: state.retrievalResults.docs.chunks.length,
      rerankedChunks: rerankedResults.rerankedChunks.length,
      executionTimeMs: rerankedResults.metadata.executionTimeMs
    }, "Docs reranking complete");
    
    // Calculate execution time
    const elapsed = performance.now() - t0;
    
    // Update state with reranked results
    return {
      rerankedResults: {
        ...state.rerankedResults,
        docs: rerankedResults
      },
      metadata: {
        currentNode: "docsReranker",
        executionTimeMs: elapsed,
        nodeTimings: {
          ...state.metadata?.nodeTimings,
          docsReranker: elapsed
        }
      }
    };
  } catch (error) {
    // Handle errors
    const domeError = toDomeError(error);
    logger.error({ err: domeError }, "Error in docs reranker");
    
    // Format error
    const formattedError = {
      node: "docsReranker",
      message: domeError.message,
      timestamp: Date.now()
    };
    
    const elapsed = performance.now() - t0;
    ObservabilityService.endSpan(
      env, 
      traceId, 
      spanId, 
      "docsReranker", 
      state, 
      { 
        ...state, 
        metadata: { 
          ...state.metadata, 
          errors: [
            ...(state.metadata?.errors || []),
            formattedError
          ] 
        } 
      }, 
      elapsed
    );
    
    return {
      metadata: {
        currentNode: "docsReranker",
        executionTimeMs: elapsed,
        errors: [
          ...(state.metadata?.errors || []),
          formattedError
        ],
        nodeTimings: {
          ...state.metadata?.nodeTimings,
          docsReranker: elapsed
        }
      }
    };
  }
}