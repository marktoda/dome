import { getLogger } from '@dome/logging';
import { AgentState, Document } from '../types';
import { countTokens } from '../utils/tokenCounter';
import { getUserId } from '../utils/stateUtils';
import { SearchService } from '../services/searchService';
import { ObservabilityService } from '../services/observabilityService';

/**
 * Retrieve relevant documents based on the query
 */
export const retrieve = async (state: AgentState, env: Env): Promise<AgentState> => {
  const searchService = SearchService.fromEnv(env);
  const logger = getLogger().child({ node: 'retrieve' });
  const startTime = performance.now();

  // Get trace and span IDs for observability
  const traceId = state.metadata?.traceId || '';
  const spanId = ObservabilityService.startSpan(env, traceId, 'retrieve', state);

  // Skip retrieval if not enabled
  if (!state.options?.enhanceWithContext) {
    logger.info('Context enhancement disabled, skipping retrieval');

    // Log the skip event
    ObservabilityService.logEvent(env, traceId, spanId, 'retrieval_skipped', {
      reason: 'Context enhancement disabled',
    });

    return {
      ...state,
      docs: [],
      metadata: {
        ...state.metadata,
        spanId,
        nodeTimings: {
          ...state.metadata?.nodeTimings,
          retrieve: 0,
        },
      },
    };
  }

  const userId = getUserId(state);
  const query = state.tasks?.rewrittenQuery || state.tasks?.originalQuery || '';
  const maxItems = state.options?.maxContextItems || 10;

  // Track widening attempts
  const wideningAttempts = state.tasks?.wideningAttempts || 0;

  // Adjust search parameters based on widening attempts
  const minRelevance = Math.max(0.5 - wideningAttempts * 0.1, 0.2);
  const expandSynonyms = wideningAttempts > 0;
  const includeRelated = wideningAttempts > 1;

  logger.info(
    {
      userId,
      query,
      maxItems,
      wideningAttempts,
      minRelevance,
      expandSynonyms,
      includeRelated,
    },
    'Retrieving context',
  );

  // Log the retrieval start event
  ObservabilityService.logEvent(env, traceId, spanId, 'retrieval_start', {
    userId,
    query,
    maxItems,
    wideningAttempts,
    minRelevance,
    expandSynonyms,
    includeRelated,
  });

  try {
    // Call the search service to retrieve documents
    const searchOptions = {
      userId,
      query,
      limit: maxItems,
      minRelevance,
      expandSynonyms,
      includeRelated,
    };

    const docs = await searchService.search(searchOptions);
    const docsCount = docs.length;

    // Log the retrieval results
    logger.info(
      {
        docsCount,
        query,
        wideningAttempts,
        topRelevanceScore: docs.length > 0 ? docs[0].metadata.relevanceScore : 0,
      },
      'Retrieved documents',
    );

    // Log the retrieval completion event
    ObservabilityService.logRetrieval(
      env,
      traceId,
      spanId,
      query,
      docs.map(doc => ({ id: doc.id, score: doc.metadata.relevanceScore })),
      performance.now() - startTime,
    );

    // Calculate total tokens in retrieved docs
    let totalTokens = 0;
    const processedDocs = docs.map(doc => {
      const docTokens = countTokens(doc.title + ' ' + doc.body);
      totalTokens += docTokens;

      return {
        ...doc,
        metadata: {
          ...doc.metadata,
          tokenCount: docTokens,
        },
      };
    });

    // Extract source metadata for attribution
    const sourceMetadata = SearchService.extractSourceMetadata(docs);

    // Rank and filter documents by relevance
    const rankedDocs = SearchService.rankAndFilterDocuments(processedDocs, minRelevance);

    // Update state with timing information
    const endTime = performance.now();
    const executionTime = endTime - startTime;

    // End the span
    ObservabilityService.endSpan(
      env,
      traceId,
      spanId,
      'retrieve',
      state,
      {
        ...state,
        docs: rankedDocs,
        tasks: {
          ...state.tasks,
          needsWidening: docsCount < 2 && wideningAttempts < 2,
          wideningAttempts,
        },
        metadata: {
          ...state.metadata,
          spanId,
          nodeTimings: {
            ...state.metadata?.nodeTimings,
            retrieve: executionTime,
          },
          tokenCounts: {
            ...state.metadata?.tokenCounts,
            retrievedDocs: totalTokens,
          },
        },
      },
      executionTime,
    );

    return {
      ...state,
      docs: rankedDocs,
      tasks: {
        ...state.tasks,
        needsWidening: docsCount < 2 && wideningAttempts < 2,
        wideningAttempts,
      },
      metadata: {
        ...state.metadata,
        spanId,
        nodeTimings: {
          ...state.metadata?.nodeTimings,
          retrieve: executionTime,
        },
        tokenCounts: {
          ...state.metadata?.tokenCounts,
          retrievedDocs: totalTokens,
        },
      },
    };
  } catch (error) {
    logger.error({ err: error, userId, query }, 'Error retrieving context');

    // Log the error event
    ObservabilityService.logEvent(env, traceId, spanId, 'retrieval_error', {
      userId,
      query,
      error: error instanceof Error ? error.message : String(error),
    });

    // Update state with timing information
    const endTime = performance.now();
    const executionTime = endTime - startTime;

    // Return state with empty docs on error
    return {
      ...state,
      docs: [],
      metadata: {
        ...state.metadata,
        spanId,
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
