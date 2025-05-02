import { getLogger } from '@dome/logging';
import { LangGraphRunnableConfig } from "@langchain/langgraph";
import { AgentState } from '../types';
import { createReranker } from '../utils/rerankerUtils';
import { ObservabilityService } from '../services/observabilityService';
import { toDomeError } from '../utils/errors';

/**
 * Model used for code reranking
 * This simulates a cross-encoder model specialized for code relevance
 */
const CODE_RERANKER_MODEL = 'bge-reranker-code';

/**
 * Maximum number of code chunks to return after reranking
 */
const MAX_CODE_CHUNKS = 8;

/**
 * Threshold score for code chunks (0-1)
 * Chunks with scores below this threshold will be filtered out
 */
const CODE_SCORE_THRESHOLD = 0.25;

/**
 * Code Reranker Node
 * 
 * Reranks code snippets retrieved from code repositories to improve
 * relevance ranking. Uses a specialized cross-encoder model that
 * considers both the query and code content to compute a more accurate
 * relevance score.
 * 
 * The node:
 * 1. Takes initial code retrieval results from the `retrieve` node
 * 2. Applies a cross-encoder reranking model to improve relevance scoring
 * 3. Selects the top 8 most relevant chunks based on reranker scores
 * 4. Updates agent state with the reranked results
 * 
 * This improves the quality of code examples provided to the LLM when
 * generating responses.
 * 
 * @param state Current agent state
 * @param cfg LangGraph runnable configuration
 * @param env Environment bindings
 * @returns Updated agent state with reranked code results
 */
export async function codeReranker(
  state: AgentState,
  cfg: LangGraphRunnableConfig,
  env: Env,
): Promise<Partial<AgentState>> {
  const t0 = performance.now();
  const logger = getLogger().child({ component: 'codeReranker' });
  
  // Skip if no retrieval results or code results
  if (!state.retrievalResults || !state.retrievalResults.code) {
    logger.info("No code retrieval results found to rerank");
    return {
      metadata: {
        currentNode: "codeReranker",
        executionTimeMs: 0,
        nodeTimings: {
          ...state.metadata?.nodeTimings,
          codeReranker: 0
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
        currentNode: "codeReranker",
        executionTimeMs: 0,
        nodeTimings: {
          ...state.metadata?.nodeTimings,
          codeReranker: 0
        }
      }
    };
  }
  
  const query = lastUserMessage.content;
  
  /* ------------------------------------------------------------------ */
  /*  Trace / logging setup                                             */
  /* ------------------------------------------------------------------ */
  const traceId = state.metadata?.traceId ?? crypto.randomUUID();
  const spanId = ObservabilityService.startSpan(env, traceId, "codeReranker", state);
  
  try {
    logger.info({
      query,
      chunkCount: state.retrievalResults.code.chunks.length,
    }, "Starting code reranking");
    
    // Create reranker instance
    const reranker = createReranker({
      name: 'code',
      model: CODE_RERANKER_MODEL,
      scoreThreshold: CODE_SCORE_THRESHOLD,
      maxResults: MAX_CODE_CHUNKS
    });
    
    // Perform reranking
    const rerankedResults = await reranker(
      state.retrievalResults.code,
      query,
      env,
      traceId,
      spanId
    );
    
    // Log results
    logger.info({
      originalChunks: state.retrievalResults.code.chunks.length,
      rerankedChunks: rerankedResults.rerankedChunks.length,
      executionTimeMs: rerankedResults.metadata.executionTimeMs
    }, "Code reranking complete");
    
    // Calculate execution time
    const elapsed = performance.now() - t0;
    
    // Update state with reranked results
    return {
      rerankedResults: {
        ...state.rerankedResults,
        code: rerankedResults
      },
      metadata: {
        currentNode: "codeReranker",
        executionTimeMs: elapsed,
        nodeTimings: {
          ...state.metadata?.nodeTimings,
          codeReranker: elapsed
        }
      }
    };
  } catch (error) {
    // Handle errors
    const domeError = toDomeError(error);
    logger.error({ err: domeError }, "Error in code reranker");
    
    // Format error
    const formattedError = {
      node: "codeReranker",
      message: domeError.message,
      timestamp: Date.now()
    };
    
    const elapsed = performance.now() - t0;
    ObservabilityService.endSpan(
      env, 
      traceId, 
      spanId, 
      "codeReranker", 
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
        currentNode: "codeReranker",
        executionTimeMs: elapsed,
        errors: [
          ...(state.metadata?.errors || []),
          formattedError
        ],
        nodeTimings: {
          ...state.metadata?.nodeTimings,
          codeReranker: elapsed
        }
      }
    };
  }
}