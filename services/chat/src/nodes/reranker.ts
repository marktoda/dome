import { getLogger } from '@dome/logging';
import { LangGraphRunnableConfig } from "@langchain/langgraph";
import { AgentState, DocumentChunk, RetrievalResult } from '../types';
import { createReranker } from '../utils/rerankerUtils';
import { ObservabilityService } from '../services/observabilityService';
import { toDomeError } from '../utils/errors';

/**
 * Content categories that can be reranked
 */
export type ContentCategory = 'code' | 'docs' | 'notes';

/**
 * Model configurations for different content types
 */
const RERANKER_MODELS = {
  code: 'bge-reranker-code',
  docs: 'bge-reranker-docs',
  notes: 'bge-reranker-notes'
};

/**
 * Maximum number of chunks to return after reranking for each content type
 */
const MAX_CHUNKS = {
  code: 8,
  docs: 8,
  notes: 8
};

/**
 * Threshold scores for filtering chunks (0-1) for each content type
 * Chunks with scores below the threshold will be filtered out
 */
const SCORE_THRESHOLDS = {
  code: 0.25,
  docs: 0.22,
  notes: 0.2
};

/**
 * Unified Reranker Node
 *
 * This is the central, unified implementation for reranking content across all categories.
 * It replaces the previously separate implementations (codeReranker, docsReranker, notesReranker)
 * with a single, configurable reranker that adapts to different content types.
 *
 * Features:
 * - Single, unified implementation for all content types
 * - Category-specific configurations (models, thresholds, result limits)
 * - Consistent typing and interfaces across all reranking operations
 * - Improved maintainability through centralized code
 *
 * The node:
 * 1. Takes initial retrieval results from the `retrieve` node for the specified category
 * 2. Applies a content-specific cross-encoder reranking model based on category settings
 * 3. Selects the top N most relevant chunks based on category-specific thresholds and limits
 * 4. Updates agent state with the reranked results for the specified category
 *
 * Usage:
 * ```
 * // To use the reranker directly with a category
 * await reranker(state, 'code', cfg, env);
 *
 * // Or to create a specialized reranker function for a category
 * const codeRerankerFn = createCategoryReranker('code');
 * await codeRerankerFn(state, cfg, env);
 * ```
 *
 * @param state Current agent state
 * @param category Content category to rerank ('code', 'docs', 'notes')
 * @param cfg LangGraph runnable configuration
 * @param env Environment bindings
 * @returns Updated agent state with reranked results for the specified category
 */
export async function reranker(
  state: AgentState,
  category: ContentCategory,
  cfg: LangGraphRunnableConfig,
  env: Env,
): Promise<Partial<AgentState>> {
  const t0 = performance.now();
  const logger = getLogger().child({ component: `${category}Reranker` });
  const nodeId = `${category}Reranker`;
  
  // Skip if no retrieval results or category-specific results
  if (!(state as any).retrievalResults || !(state as any).retrievalResults[category]) {
    logger.info(`No ${category} retrieval results found to rerank`);
    return {
      metadata: {
        currentNode: nodeId,
        executionTimeMs: 0,
        nodeTimings: {
          ...state.metadata?.nodeTimings,
          [nodeId]: 0
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
        currentNode: nodeId,
        executionTimeMs: 0,
        nodeTimings: {
          ...state.metadata?.nodeTimings,
          [nodeId]: 0
        }
      }
    };
  }
  
  const query = lastUserMessage.content;
  
  /* ------------------------------------------------------------------ */
  /*  Trace / logging setup                                             */
  /* ------------------------------------------------------------------ */
  const traceId = state.metadata?.traceId ?? crypto.randomUUID();
  const spanId = ObservabilityService.startSpan(env, traceId, nodeId, state);
  
  try {
    logger.info({
      query,
      category,
      chunkCount: (state as any).retrievalResults[category].chunks.length,
    }, `Starting ${category} reranking`);
    
    // Create reranker instance with category-specific configuration
    const reranker = createReranker({
      name: category,
      model: RERANKER_MODELS[category],
      scoreThreshold: SCORE_THRESHOLDS[category],
      maxResults: MAX_CHUNKS[category]
    });
    
    // Perform reranking
    const rerankedResults = await reranker(
      (state as any).retrievalResults[category],
      query,
      env,
      traceId,
      spanId
    );
    
    // Log results
    logger.info({
      category,
      originalChunks: (state as any).retrievalResults[category].chunks.length,
      rerankedChunks: rerankedResults.rerankedChunks.length,
      executionTimeMs: rerankedResults.metadata.executionTimeMs
    }, `${category} reranking complete`);
    
    // Calculate execution time
    const elapsed = performance.now() - t0;
    
    // Update state with reranked results for the specific category
    return {
      rerankedResults: {
        ...state.rerankedResults,
        [category]: rerankedResults
      },
      metadata: {
        currentNode: nodeId,
        executionTimeMs: elapsed,
        nodeTimings: {
          ...state.metadata?.nodeTimings,
          [nodeId]: elapsed
        }
      }
    };
  } catch (error) {
    // Handle errors
    const domeError = toDomeError(error);
    logger.error({ err: domeError }, `Error in ${category} reranker`);
    
    // Format error
    const formattedError = {
      node: nodeId,
      message: domeError.message,
      timestamp: Date.now()
    };
    
    const elapsed = performance.now() - t0;
    ObservabilityService.endSpan(
      env, 
      traceId, 
      spanId, 
      nodeId, 
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
        currentNode: nodeId,
        executionTimeMs: elapsed,
        errors: [
          ...(state.metadata?.errors || []),
          formattedError
        ],
        nodeTimings: {
          ...state.metadata?.nodeTimings,
          [nodeId]: elapsed
        }
      }
    };
  }
}

/**
 * Helper function to create a specialized reranker for a specific content category
 * 
 * @param category Content category to rerank ('code', 'docs', 'notes')
 * @returns A reranker function specialized for the given content category
 */
export function createCategoryReranker(category: ContentCategory) {
  return (state: AgentState, cfg: LangGraphRunnableConfig, env: Env) => 
    reranker(state, category, cfg, env);
}

// Pre-configured rerankers for backwards compatibility
export const codeReranker = createCategoryReranker('code');
export const docsReranker = createCategoryReranker('docs');
export const notesReranker = createCategoryReranker('notes');