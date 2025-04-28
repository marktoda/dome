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

  // Get the query for retrieval
  getLogger().info({ tasks: state.tasks }, 'Tasks in state');
  const query = state.tasks?.rewrittenQuery || state.tasks?.originalQuery || '';
  const trimmedQuery = query.trim();

  // Define minimum query length
  const MIN_QUERY_LENGTH = 3;

  // Validate query to prevent empty or too short query errors
  if (!trimmedQuery) {
    logger.warn(
      {
        userId: state.userId,
        traceId,
        spanId,
      },
      'Empty query detected, skipping vector search',
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
        tasks: {
          ...state.tasks,
          needsWidening: false,
        },
      },
      executionTime,
    );

    // Log the empty query event
    ObservabilityService.logEvent(env, traceId, spanId, 'retrieval_skipped', {
      reason: 'empty_query',
      executionTimeMs: executionTime,
    });

    // Return state with empty docs and timing information
    return {
      ...state,
      docs: [],
      tasks: {
        ...state.tasks,
        needsWidening: false,
      },
      metadata: {
        ...state.metadata,
        nodeTimings: {
          ...state.metadata?.nodeTimings,
          retrieve: executionTime,
        },
      },
    };
  }

  // Check for query length
  if (trimmedQuery.length < MIN_QUERY_LENGTH) {
    logger.warn(
      {
        userId: state.userId,
        traceId,
        spanId,
        query: trimmedQuery,
        queryLength: trimmedQuery.length,
      },
      'Query too short, skipping vector search',
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
        tasks: {
          ...state.tasks,
          needsWidening: false,
        },
      },
      executionTime,
    );

    // Log the short query event
    ObservabilityService.logEvent(env, traceId, spanId, 'retrieval_skipped', {
      reason: 'query_too_short',
      queryLength: trimmedQuery.length,
      executionTimeMs: executionTime,
    });

    // Return state with empty docs and timing information
    return {
      ...state,
      docs: [],
      tasks: {
        ...state.tasks,
        needsWidening: false,
      },
      metadata: {
        ...state.metadata,
        nodeTimings: {
          ...state.metadata?.nodeTimings,
          retrieve: executionTime,
        },
      },
    };
  }

  logger.info(
    {
      query: trimmedQuery,
      userId: state.userId,
      traceId,
      spanId,
    },
    'Retrieving documents',
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
    if (state.tasks?.wideningParams) {
      Object.assign(searchOptions, {
        minRelevance: state.tasks.wideningParams.minRelevance || searchOptions.minRelevance,
        expandSynonyms: state.tasks.wideningParams.expandSynonyms || searchOptions.expandSynonyms,
        includeRelated: state.tasks.wideningParams.includeRelated || searchOptions.includeRelated,
      });

      // Apply temporal widening if specified
      if (state.tasks.wideningParams.startDate) {
        searchOptions.startDate = state.tasks.wideningParams.startDate as number;
      }
      if (state.tasks.wideningParams.endDate) {
        searchOptions.endDate = state.tasks.wideningParams.endDate as number;
      }

      // Apply category widening if specified
      if (state.tasks.wideningParams.category) {
        searchOptions.category = state.tasks.wideningParams.category as any;
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
      state.tasks?.wideningAttempts || 0,
    );

    logger.info(
      {
        documentCount: contextualizedDocs.length,
        retrievalQuality,
        needsWidening,
        wideningAttempts: state.tasks?.wideningAttempts || 0,
        traceId,
        spanId,
      },
      'Retrieved and processed documents',
    );

    // Update state with timing information
    const endTime = performance.now();
    const executionTime = endTime - startTime;

    // Create updated state with retrieved documents
    const updatedState = {
      ...state,
      docs: contextualizedDocs,
      tasks: {
        ...state.tasks,
        needsWidening,
      },
    };

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
      query: trimmedQuery,
      documentCount: contextualizedDocs.length,
      retrievalQuality,
      needsWidening,
      executionTimeMs: executionTime,
      hasDocs: contextualizedDocs.length > 0,
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
  } catch (error) {
    // Log the error
    logger.error(
      {
        err: error,
        query: trimmedQuery,
        traceId,
        spanId,
      },
      'Error retrieving documents',
    );

    // Update state with timing information
    const endTime = performance.now();
    const executionTime = endTime - startTime;

    // End the span with error
    ObservabilityService.endSpan(
      env,
      traceId,
      spanId,
      'retrieve',
      state,
      {
        ...state,
        docs: [],
        tasks: {
          ...state.tasks,
          needsWidening: false,
        },
      },
      executionTime,
    );

    // Log the error event
    ObservabilityService.logEvent(env, traceId, spanId, 'retrieval_error', {
      error: error instanceof Error ? error.message : String(error),
      executionTimeMs: executionTime,
    });

    return {
      ...state,
      docs: [],
      tasks: {
        ...state.tasks,
        needsWidening: false,
      },
      metadata: {
        ...state.metadata,
        nodeTimings: {
          ...state.metadata?.nodeTimings,
          retrieve: executionTime,
        },
        errors: [
          ...(state.metadata?.errors || []),
          {
            node: 'retrieve',
            message: error instanceof Error ? error.message : String(error),
            timestamp: Date.now(),
          },
        ],
      },
    };
  }
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
  const queryTokens = new Set(
    query
      .toLowerCase()
      .split(/\s+/)
      .filter(token => token.length > 3),
  );

  // Apply contextual scoring to adjust relevance
  return sortedDocuments.map(doc => {
    const content = doc.body.toLowerCase();
    let contextRelevance = 0;

    // Count query tokens that appear in the document
    queryTokens.forEach(token => {
      if (content.includes(token)) {
        contextRelevance += 1;
      }
    });

    // Normalize the contextual relevance score
    const normalizedContextScore = queryTokens.size > 0
      ? contextRelevance / queryTokens.size
      : 0;

    // Combine base relevance with contextual relevance
    const baseRelevance = doc.metadata.relevanceScore || 0;
    const combinedScore = 0.7 * baseRelevance + 0.3 * normalizedContextScore;

    // Return document with updated relevance score
    return {
      ...doc,
      metadata: {
        ...doc.metadata,
        relevanceScore: combinedScore,
        contextual_similarity: normalizedContextScore,
      },
    };
  });
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
