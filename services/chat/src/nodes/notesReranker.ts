import { getLogger } from '@dome/logging';
import { LangGraphRunnableConfig } from "@langchain/langgraph";
import { AgentState } from '../types';
import { createReranker } from '../utils/rerankerUtils';
import { ObservabilityService } from '../services/observabilityService';
import { toDomeError } from '../utils/errors';

/**
 * Model used for notes reranking
 * This simulates a cross-encoder model specialized for personal notes relevance
 */
const NOTES_RERANKER_MODEL = 'bge-reranker-notes';

/**
 * Maximum number of notes chunks to return after reranking
 */
const MAX_NOTES_CHUNKS = 8;

/**
 * Threshold score for notes chunks (0-1)
 * Chunks with scores below this threshold will be filtered out
 */
const NOTES_SCORE_THRESHOLD = 0.2;

/**
 * Notes Reranker Node
 * 
 * Reranks personal notes retrieved from the notes repository to improve
 * relevance ranking. Uses a specialized cross-encoder model that
 * considers both the query and note content to compute a more accurate
 * relevance score.
 * 
 * The node:
 * 1. Takes initial notes retrieval results from the `retrieve` node
 * 2. Applies a cross-encoder reranking model to improve relevance scoring
 * 3. Selects the top 8 most relevant chunks based on reranker scores
 * 4. Updates agent state with the reranked results
 * 
 * This ensures personal notes are properly ranked based on their relevance
 * to the user's query, improving the quality of personalized responses.
 * 
 * @param state Current agent state
 * @param cfg LangGraph runnable configuration
 * @param env Environment bindings
 * @returns Updated agent state with reranked notes results
 */
export async function notesReranker(
  state: AgentState,
  cfg: LangGraphRunnableConfig,
  env: Env,
): Promise<Partial<AgentState>> {
  const t0 = performance.now();
  const logger = getLogger().child({ component: 'notesReranker' });
  
  // Skip if no retrieval results or notes results
  if (!state.retrievalResults || !state.retrievalResults.notes) {
    logger.info("No notes retrieval results found to rerank");
    return {
      metadata: {
        currentNode: "notesReranker",
        executionTimeMs: 0,
        nodeTimings: {
          ...state.metadata?.nodeTimings,
          notesReranker: 0
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
        currentNode: "notesReranker",
        executionTimeMs: 0,
        nodeTimings: {
          ...state.metadata?.nodeTimings,
          notesReranker: 0
        }
      }
    };
  }
  
  const query = lastUserMessage.content;
  
  /* ------------------------------------------------------------------ */
  /*  Trace / logging setup                                             */
  /* ------------------------------------------------------------------ */
  const traceId = state.metadata?.traceId ?? crypto.randomUUID();
  const spanId = ObservabilityService.startSpan(env, traceId, "notesReranker", state);
  
  try {
    logger.info({
      query,
      chunkCount: state.retrievalResults.notes.chunks.length,
    }, "Starting notes reranking");
    
    // Create reranker instance
    const reranker = createReranker({
      name: 'notes',
      model: NOTES_RERANKER_MODEL,
      scoreThreshold: NOTES_SCORE_THRESHOLD,
      maxResults: MAX_NOTES_CHUNKS
    });
    
    // Perform reranking
    const rerankedResults = await reranker(
      state.retrievalResults.notes,
      query,
      env,
      traceId,
      spanId
    );
    
    // Log results
    logger.info({
      originalChunks: state.retrievalResults.notes.chunks.length,
      rerankedChunks: rerankedResults.rerankedChunks.length,
      executionTimeMs: rerankedResults.metadata.executionTimeMs
    }, "Notes reranking complete");
    
    // Calculate execution time
    const elapsed = performance.now() - t0;
    
    // Update state with reranked results
    return {
      rerankedResults: {
        ...state.rerankedResults,
        notes: rerankedResults
      },
      metadata: {
        currentNode: "notesReranker",
        executionTimeMs: elapsed,
        nodeTimings: {
          ...state.metadata?.nodeTimings,
          notesReranker: elapsed
        }
      }
    };
  } catch (error) {
    // Handle errors
    const domeError = toDomeError(error);
    logger.error({ err: domeError }, "Error in notes reranker");
    
    // Format error
    const formattedError = {
      node: "notesReranker",
      message: domeError.message,
      timestamp: Date.now()
    };
    
    const elapsed = performance.now() - t0;
    ObservabilityService.endSpan(
      env, 
      traceId, 
      spanId, 
      "notesReranker", 
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
        currentNode: "notesReranker",
        executionTimeMs: elapsed,
        errors: [
          ...(state.metadata?.errors || []),
          formattedError
        ],
        nodeTimings: {
          ...state.metadata?.nodeTimings,
          notesReranker: elapsed
        }
      }
    };
  }
}