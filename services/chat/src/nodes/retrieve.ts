import { getLogger } from '@dome/logging';
import { AgentState, Document } from '../types';
import { SearchService, SearchOptions } from '../services/searchService';
import { ObservabilityService } from '../services/observabilityService';

/**
 * Enhanced retrieval node that uses contextual compression and relevance scoring
 */
export const retrieve = async (state: AgentState, env: Env): Promise<AgentState> => {
  const logger = getLogger().child({ node: 'retrieve' });
  const startTime = performance.now();

  // Get trace and span IDs for observability
  const traceId = state.metadata?.traceId || '';
  const spanId = ObservabilityService.startSpan(env, traceId, 'retrieve', state);

  // Get task information from state
  const taskIds = state.taskIds || [];
  const taskEntities = state.taskEntities || {};

  getLogger().info({ taskIds, taskEntities }, 'Tasks in state');

  // If there are no tasks, skip retrieval
  if (taskIds.length === 0) {
    logger.warn(
      {
        userId: state.userId,
        traceId,
        spanId,
      },
      'No tasks found, skipping retrieval',
    );

    // Record timing for skipped search
    const endTime = performance.now();
    const executionTime = endTime - startTime;

    // End the span early
    ObservabilityService.endSpan(
      env,
      traceId,
      spanId,
      'retrieve',
      state,
      {
        ...state,
        docs: [],
      },
      executionTime,
    );

    return {
      ...state,
      docs: [],
      metadata: {
        ...state.metadata,
        nodeTimings: {
          ...state.metadata?.nodeTimings,
          retrieve: executionTime,
        },
      },
    };
  }

  // Prepare to collect all retrieved documents
  let allRetrievedDocs: Document[] = [];

  // Track tasks that need widening
  const tasksNeedingWidening: Record<string, boolean> = {};

  // Process each task sequentially
  for (const taskId of taskIds) {
    const task = taskEntities[taskId];

    // Skip invalid tasks
    if (!task) {
      logger.warn({ taskId }, 'Task ID not found in taskEntities');
      continue;
    }

    // Extract query from task
    const query = task.rewrittenQuery || task.originalQuery || '';
    const trimmedQuery = query.trim();

    // Define minimum query length
    const MIN_QUERY_LENGTH = 3;

    // Skip empty or too short queries
    if (!trimmedQuery || trimmedQuery.length < MIN_QUERY_LENGTH) {
      logger.warn(
        {
          userId: state.userId,
          traceId,
          spanId,
          taskId,
          query: trimmedQuery,
          queryLength: trimmedQuery?.length || 0,
        },
        trimmedQuery ? 'Query too short, skipping' : 'Empty query, skipping',
      );

      // Mark this task as not needing widening
      tasksNeedingWidening[taskId] = false;
      continue;
    }

    logger.info(
      {
        taskId,
        query: trimmedQuery,
        userId: state.userId,
        traceId,
        spanId,
      },
      'Retrieving documents for task',
    );

    try {
      // Create search service
      const searchService = SearchService.fromEnv(env);

      // Configure search options with contextual parameters
      const searchOptions: SearchOptions = {
        userId: state.userId,
        query: trimmedQuery,
        limit: 10, // Default limit
        minRelevance: 0.5, // Default minimum relevance
        expandSynonyms: false,
        includeRelated: false,
        // Optional parameters that might be set during widening
        startDate: undefined,
        endDate: undefined,
        category: undefined,
      };

      // Apply any widening parameters if available
      if (task.wideningParams) {
        Object.assign(searchOptions, {
          minRelevance: task.wideningParams.minRelevance || searchOptions.minRelevance,
          expandSynonyms: task.wideningParams.expandSynonyms || searchOptions.expandSynonyms,
          includeRelated: task.wideningParams.includeRelated || searchOptions.includeRelated,
        });

        // Apply temporal widening if specified
        if (task.wideningParams.startDate) {
          searchOptions.startDate = task.wideningParams.startDate as number;
        }
        if (task.wideningParams.endDate) {
          searchOptions.endDate = task.wideningParams.endDate as number;
        }

        // Apply category widening if specified
        if (task.wideningParams.category) {
          searchOptions.category = task.wideningParams.category as any;
        }
      }

      // Perform search
      const documents = await searchService.search(searchOptions);

      // Apply contextual compression to filter and rerank documents
      const contextualizedDocs = await applyContextualCompression(documents, trimmedQuery);

      // Calculate retrieval quality
      const retrievalQuality = assessRetrievalQuality(contextualizedDocs);

      // Determine if widening is needed based on retrieval quality
      const needsWidening = determineIfWideningNeeded(
        retrievalQuality,
        task.wideningAttempts || 0,
      );

      // Store widening status for this task
      tasksNeedingWidening[taskId] = needsWidening;

      // Add this task's docs to the overall collection
      allRetrievedDocs = [...allRetrievedDocs, ...contextualizedDocs];

      logger.info(
        {
          taskId,
          documentCount: contextualizedDocs.length,
          retrievalQuality,
          needsWidening,
          wideningAttempts: task.wideningAttempts || 0,
          traceId,
          spanId,
        },
        'Retrieved and processed documents for task',
      );

    } catch (error) {
      // Log the error
      logger.error(
        {
          err: error,
          taskId,
          query: trimmedQuery,
          traceId,
          spanId,
        },
        'Error retrieving documents for task',
      );

      // Mark this task as not needing widening due to error
      tasksNeedingWidening[taskId] = false;
    }
  }

  // Update state with timing information
  const endTime = performance.now();
  const executionTime = endTime - startTime;

  // Create updated state with retrieved documents
  const updatedState = {
    ...state,
    docs: allRetrievedDocs,
    sources: allRetrievedDocs.map(doc => ({
      id: doc.id,
      title: doc.title,
      source: doc.metadata.source,
      url: doc.metadata.url,
      relevanceScore: doc.metadata.relevanceScore,

    })),
  };

  // Update widening status for each task
  if (Object.keys(tasksNeedingWidening).length > 0) {
    updatedState.taskEntities = { ...taskEntities };

    for (const [taskId, needsWidening] of Object.entries(tasksNeedingWidening)) {
      if (updatedState.taskEntities[taskId]) {
        updatedState.taskEntities[taskId] = {
          ...updatedState.taskEntities[taskId],
          needsWidening,
        };
      }
    }
  }

  // End the span
  ObservabilityService.endSpan(
    env,
    traceId,
    spanId,
    'retrieve',
    state,
    updatedState,
    executionTime,
  );

  // Log retrieval metrics
  ObservabilityService.logEvent(env, traceId, spanId, 'retrieval_complete', {
    taskCount: taskIds.length,
    totalDocumentCount: allRetrievedDocs.length,
    executionTimeMs: executionTime,
    hasDocs: allRetrievedDocs.length > 0,
  });

  return {
    ...updatedState,
    metadata: {
      ...updatedState.metadata,
      nodeTimings: {
        ...updatedState.metadata?.nodeTimings,
        retrieve: executionTime,
      },
    },
  };
};

/**
 * Apply contextual compression to filter and rerank documents based on the query context
 */
async function applyContextualCompression(documents: Document[], query: string): Promise<Document[]> {
  // Ensure query is trimmed and non-empty (defensive programming)
  const processedQuery = query.trim();
  if (!processedQuery) {
    return documents; // Return documents as-is if query is empty
  }
  // Sort by relevance first
  const sortedDocuments = SearchService.rankAndFilterDocuments(documents);

  // Token-aware document filtering
  // In a production system, this would use more sophisticated embedding-based similarity
  // TODO: apply embedding based reranking
  return sortedDocuments;
}

/**
 * Assess retrieval quality based on document relevance scores and count
 */
function assessRetrievalQuality(documents: Document[]): 'high' | 'low' | 'none' {
  if (documents.length === 0) {
    return 'none';
  }

  // Calculate average relevance score
  const relevanceScores = documents.map(doc => doc.metadata.relevanceScore);
  const avgRelevance = relevanceScores.reduce((sum, score) => sum + score, 0) / relevanceScores.length;

  // High quality: Good average relevance and sufficient number of documents
  if (avgRelevance > 0.7 && documents.length >= 3) {
    return 'high';
  }

  // Low quality: Some relevant documents but not ideal
  if (avgRelevance > 0.4 || documents.length >= 2) {
    return 'low';
  }

  // No quality: Very few or irrelevant documents
  return 'none';
}

/**
 * Determine if search widening is needed based on retrieval quality and previous attempts
 */
function determineIfWideningNeeded(retrievalQuality: 'high' | 'low' | 'none', attempts: number): boolean {
  // Never widen if we already have high quality results
  if (retrievalQuality === 'high') {
    return false;
  }

  // Always try widening once if results are poor
  if (retrievalQuality === 'none' && attempts === 0) {
    return true;
  }

  // Try widening a second time if results are still low quality
  if (retrievalQuality === 'low' && attempts === 1) {
    return true;
  }

  // Try widening a third time if we still have no results
  if (retrievalQuality === 'none' && attempts === 1) {
    return true;
  }

  // Maximum 3 widening attempts
  if (attempts >= 2) {
    return false;
  }

  return false;
}
