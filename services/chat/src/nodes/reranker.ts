import { getLogger } from '@dome/common';
import { LangGraphRunnableConfig } from '@langchain/langgraph';
import { AgentState, DocumentChunk, RetrievalResult, RetrievalTask } from '../types';
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
  // Cohere models (preferred)
  cohere_english: 'rerank-english-v2.0', // Best for English text
  cohere_multilingual: 'rerank-multilingual-v2.0', // Best for multilingual content

  // Workers AI models (fallback)
  workers_base: '@cf/baai/bge-reranker-base', // General purpose model
  workers_large: '@cf/baai/bge-reranker-large', // Better for complex content
  workers_multilingual: '@cf/baai/bge-reranker-m3', // Better for non-English content
};

/**
 * Default model to use when no specific model is selected
 * Using Cohere English reranker as default - better for notes
 */
const DEFAULT_RERANKER_MODEL = RERANKER_MODELS.cohere_english;

/**
 * Maximum number of chunks to return after reranking
 */
const MAX_CHUNKS = 10;

/**
 * Default threshold score for filtering chunks (0-1)
 * Using an adaptive threshold based on content type
 * The actual thresholds are defined in rerankerUtils.ts
 */
const DEFAULT_SCORE_THRESHOLD = 0.45;

/**
 * Which reranking implementation to use by default
 * 'cohere' - More accurate but requires an API key
 * 'workers-ai' - Less accurate but doesn't require an API key
 */
const DEFAULT_IMPLEMENTATION = 'cohere';

/**
 * Unified Reranker Node
 *
 * This updated implementation groups results by retrieval query and type,
 * then reranks each group independently.
 *
 * Features:
 * - Processes each retrieval task independently
 * - Uses a single reranker configuration across all retrieval types
 * - Returns all reranked results in the response
 *
 * The node:
 * 1. Takes retrieval tasks from state.retrievals (array of RetrievalTask objects)
 * 2. Processes each retrieval task separately
 * 3. Applies reranking to each task's chunks
 * 4. Returns all reranked results in the response
 *
 * @param state Current agent state
 * @param cfg LangGraph runnable configuration
 * @param env Environment bindings
 * @returns Updated agent state with reranked results
 */
export async function reranker(
  state: AgentState,
  cfg: LangGraphRunnableConfig,
  env: Env,
): Promise<Partial<AgentState>> {
  const t0 = performance.now();
  const logger = getLogger().child({ component: 'UnifiedReranker' });
  const nodeId = 'unified_reranker';

  // Get retrieval tasks from state
  // retrievals is an array of RetrievalTask objects
  const retrievals = (state as any).retrievals || [];

  // Skip if no retrieval tasks found
  if (!Array.isArray(retrievals) || retrievals.length === 0) {
    logger.info('No retrieval tasks found to rerank');
    return {
      metadata: {
        currentNode: nodeId,
        executionTimeMs: 0,
        nodeTimings: {
          ...state.metadata?.nodeTimings,
          [nodeId]: 0,
        },
      },
    };
  }

  // Detect and handle duplicate tasks with the same category and query
  // Create a map of tasks keyed by category+query
  const taskMap = new Map<string, RetrievalTask>();

  // Log the incoming retrievals for debugging
  logger.info(
    {
      incomingRetrievals: retrievals.map(r => ({
        category: r.category,
        query: r.query,
        chunkCount: r.chunks?.length || 0,
      })),
    },
    'Incoming retrieval tasks',
  );

  // Process each task, merging duplicates
  for (const task of retrievals) {
    const key = `${task.category}:${task.query}`;

    if (taskMap.has(key)) {
      // Found a duplicate task, merge chunks
      const existingTask = taskMap.get(key)!;
      const existingChunks = existingTask.chunks || [];
      const newChunks = task.chunks || [];

      // Only merge if the new task has chunks
      if (newChunks.length > 0) {
        logger.info(
          {
            category: task.category,
            query: task.query,
            existingChunks: existingChunks.length,
            newChunks: newChunks.length,
          },
          'Merging duplicate retrieval tasks',
        );

        // Create a map to deduplicate chunks by ID to prevent duplicates
        const chunkMap = new Map<string, DocumentChunk>();

        // Add existing chunks
        for (const chunk of existingChunks) {
          chunkMap.set(chunk.id, chunk);
        }

        // Add new chunks (will overwrite if ID already exists)
        for (const chunk of newChunks) {
          chunkMap.set(chunk.id, chunk);
        }

        // Update the existing task with deduplicated chunks
        existingTask.chunks = Array.from(chunkMap.values());
      }
    } else {
      // New task, add to map
      taskMap.set(key, { ...task });
    }
  }

  // Convert the map back to an array of tasks
  const mergedTasks = Array.from(taskMap.values());

  logger.info(
    {
      originalTaskCount: retrievals.length,
      mergedTaskCount: mergedTasks.length,
      hasChunks: mergedTasks.filter(task => task.chunks && task.chunks.length > 0).length,
    },
    'Merged duplicate retrieval tasks',
  );

  // Extract last user message to use as fallback query
  const lastUserMessage = [...(state.messages || [])].reverse().find(msg => msg.role === 'user');
  if (!lastUserMessage) {
    logger.warn('No user message found for reranking context');
    return {
      metadata: {
        currentNode: nodeId,
        executionTimeMs: 0,
        nodeTimings: {
          ...state.metadata?.nodeTimings,
          [nodeId]: 0,
        },
      },
    };
  }

  const defaultQuery = lastUserMessage.content;

  /* ------------------------------------------------------------------ */
  /*  Trace / logging setup                                             */
  /* ------------------------------------------------------------------ */
  const traceId = state.metadata?.traceId ?? crypto.randomUUID();
  const spanId = ObservabilityService.startSpan(env, traceId, nodeId, state);

  try {
    // Array to store all reranked tasks
    const rerankedTasks: RetrievalTask[] = [];

    // Log the reranker model configuration
    logger.info(
      {
        models: RERANKER_MODELS,
        defaultModel: DEFAULT_RERANKER_MODEL,
        defaultThreshold: DEFAULT_SCORE_THRESHOLD,
        maxChunks: MAX_CHUNKS,
      },
      'Reranker configuration',
    );

    // Process each merged retrieval task separately
    for (const task of mergedTasks) {
      // Skip if no chunks or empty chunks
      if (!task.chunks || task.chunks.length === 0) {
        logger.info(
          {
            category: task.category,
            query: task.query,
          },
          'Skipping retrieval task with no chunks',
        );
        continue;
      }

      // Determine the best model and implementation to use based on content type
      const contentType = task.sourceType || task.category;
      const contentTypeStr = contentType.toString().toLowerCase();

      // Choose appropriate model based on content type
      let modelToUse = DEFAULT_RERANKER_MODEL;
      const implementation: 'cohere' | 'workers-ai' = DEFAULT_IMPLEMENTATION as
        | 'cohere'
        | 'workers-ai';

      if (implementation === 'cohere') {
        // Use appropriate Cohere model
        if (task.query?.match(/[^\x00-\x7F]/)) {
          // Contains non-ASCII characters - use multilingual
          modelToUse = RERANKER_MODELS.cohere_multilingual;
        } else {
          // Standard English content
          modelToUse = RERANKER_MODELS.cohere_english;
        }
      } else {
        // Use appropriate Workers AI model as fallback
        if (contentTypeStr === 'code' || task.query?.toLowerCase().includes('code')) {
          modelToUse = RERANKER_MODELS.workers_large;
        } else if (task.query?.match(/[^\x00-\x7F]/)) {
          modelToUse = RERANKER_MODELS.workers_multilingual;
        } else {
          modelToUse = RERANKER_MODELS.workers_base;
        }
      }

      logger.info(
        {
          category: task.category,
          query: task.query,
          chunkCount: task.chunks.length,
          sourceType: contentType,
          selectedModel: modelToUse,
          implementation,
          hasApiKey: !!(env as any).COHERE_API_KEY,
          isMultilingual: !!task.query?.match(/[^\x00-\x7F]/),
          isCodeRelated: contentTypeStr === 'code' || !!task.query?.toLowerCase().includes('code'),
        },
        `Reranking chunks for ${task.category}`,
      );

      // Create a reranker instance with appropriate configuration
      const reranker = createReranker({
        name: `reranker-${contentTypeStr}`,
        model: modelToUse,
        implementation, // Use Cohere by default
        scoreThreshold: DEFAULT_SCORE_THRESHOLD, // This is just a default, source-specific thresholds are applied in rerankerUtils
        maxResults: MAX_CHUNKS,
        cohereApiKey: (env as any).COHERE_API_KEY, // Pass API key from environment using type assertion
      });

      // Create a properly typed RetrievalResult for the reranker
      const retrievalResult: RetrievalResult = {
        query: task.query || defaultQuery,
        chunks: task.chunks,
        sourceType: task.sourceType || task.category,
        metadata: task.metadata || {
          executionTimeMs: 0,
          retrievalStrategy: 'unknown',
          totalCandidates: task.chunks.length,
        },
      };

      // Perform reranking for this task
      const rerankedResult = await reranker(
        retrievalResult,
        task.query || defaultQuery,
        env,
        traceId,
        spanId,
      );

      // Create a new task with the reranked chunks
      // Ensure all required metadata fields have default values
      const rerankedTask: RetrievalTask = {
        ...task,
        chunks: rerankedResult.chunks || [],
        metadata: {
          ...(task.metadata || {}),
          executionTimeMs: rerankedResult.metadata?.executionTimeMs || 0,
          rerankerModel: modelToUse, // Use the selected model for this task
          rerankerImplementation: implementation, // Add implementation info
          originalChunkCount: task.chunks?.length || 0,
          rerankedChunkCount: rerankedResult.chunks?.length || 0,
          // Ensure required metadata properties always have values
          retrievalStrategy: task.metadata?.retrievalStrategy || 'unified-retrieval',
          totalCandidates: task.metadata?.totalCandidates || task.chunks?.length || 0,
        },
      };

      // Add to the reranked tasks array
      rerankedTasks.push(rerankedTask);

      // Add enhanced logging with score information
      const rerankedChunks = rerankedResult.chunks || [];
      const scoreInfo = rerankedChunks.slice(0, 3).map(chunk => {
        // Use type assertion to access the dynamically added properties
        const meta = chunk.metadata as any;
        return {
          id: chunk.id,
          rawScore: meta.rerankerRawScore,
          normalizedScore: meta.rerankerScore,
          hybridScore: meta.hybridScore,
          sourceThreshold: meta.sourceThreshold,
        };
      });

      logger.info(
        {
          category: task.category,
          originalChunks: task.chunks?.length || 0,
          rerankedChunks: rerankedResult.chunks?.length || 0,
          executionTimeMs: rerankedResult.metadata?.executionTimeMs || 0,
          model: modelToUse,
          topScores: scoreInfo,
        },
        `Completed reranking for ${task.category}`,
      );
    }

    // Calculate execution time
    const elapsed = performance.now() - t0;

    // Use state with a generic "as any" type for span tracking
    const updatedState = {
      ...state,
      retrievals: rerankedTasks,
    };

    // Complete the span
    ObservabilityService.endSpan(env, traceId, spanId, nodeId, state, updatedState, elapsed);

    // Log the deduplicated and reranked retrievals with enhanced information
    logger.info(
      {
        rerankedTaskCount: rerankedTasks.length,
        totalRerankedChunks: rerankedTasks.reduce(
          (sum, task) => sum + (task.chunks?.length || 0),
          0,
        ),
        taskBreakdown: rerankedTasks.map(task => ({
          category: task.category,
          sourceType: task.sourceType,
          chunkCount: task.chunks?.length || 0,
        })),
      },
      'Completed all reranking operations',
    );

    // Return updated state with all reranked tasks
    return {
      retrievals: rerankedTasks,
      metadata: {
        currentNode: nodeId,
        executionTimeMs: elapsed,
        nodeTimings: {
          ...state.metadata?.nodeTimings,
          [nodeId]: elapsed,
        },
      },
    };
  } catch (error) {
    // Handle errors
    const domeError = toDomeError(error);
    logger.error({ err: domeError }, 'Error in unified reranker');

    // Format error
    const formattedError = {
      node: nodeId,
      message: domeError.message,
      timestamp: Date.now(),
    };

    // Complete the span with error
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
          errors: [...(state.metadata?.errors || []), formattedError],
        },
      },
      elapsed,
    );

    // Return error state
    return {
      metadata: {
        currentNode: nodeId,
        executionTimeMs: elapsed,
        errors: [...(state.metadata?.errors || []), formattedError],
        nodeTimings: {
          ...state.metadata?.nodeTimings,
          [nodeId]: elapsed,
        },
      },
    };
  }
}

/**
 * Helper function to create a reranker function
 * (No longer category-specific)
 *
 * @returns A reranker function
 */
export function createCategoryReranker() {
  return (state: AgentState, cfg: LangGraphRunnableConfig, env: Env) => reranker(state, cfg, env);
}

// For backward compatibility
export const codeReranker = createCategoryReranker();
export const docsReranker = createCategoryReranker();
export const notesReranker = createCategoryReranker();
