import { getLogger } from '@dome/logging';
import { AgentState, Document } from '../types';
import { countTokens } from '../utils/tokenCounter';
import { getUserId } from '../utils/stateUtils';
import { truncateDocumentToMaxTokens } from '../utils/promptFormatter';
import { SearchService } from '../services/searchService';
import { ObservabilityService } from '../services/observabilityService';
import { LlmService } from '../services/llmService';
import { getModelConfig } from '../config/modelConfig';

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

  // Log minimal options for debugging
  logger.info({
    enhanceWithContext: state.options?.enhanceWithContext,
    maxContextItems: state.options?.maxContextItems,
  }, 'Retrieve node options');

  // Force enable context enhancement for now
  const enhanceWithContext = state.options?.enhanceWithContext ?? true;

  // Skip retrieval if not enabled (but we're forcing it on for now)
  if (!enhanceWithContext) {
    logger.info('Context enhancement disabled, skipping retrieval');

    // Log the skip event
    ObservabilityService.logEvent(env, traceId, spanId, 'retrieval_skipped', {
      reason: 'Context enhancement disabled',
      options: state.options,
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
  let query = state.tasks?.rewrittenQuery || state.tasks?.originalQuery;
  // If query is empty, use the last user message as a fallback
  if (!query) {
    logger.info('No query provided');
    throw new Error('No query provided for retrieval');
  }

  // Log the query for debugging
  logger.info({ query }, 'Query for retrieval');


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

    // Log the retrieval results with minimal info
    logger.info(
      {
        docsCount,
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

    // Get model configuration
    const modelId = state.options?.modelId || LlmService.MODEL;
    const modelConfig = getModelConfig(modelId);
    
    // Calculate total tokens in retrieved docs and truncate if needed
    let totalTokens = 0;
    const processedDocs = docs.map(doc => {
      // First truncate each document to a reasonable size (max tokens per doc based on model)
      // Use 10% of model's context window as max per document
      const maxTokensPerDoc = Math.floor(modelConfig.maxContextTokens * 0.1);
      const truncatedDoc = truncateDocumentToMaxTokens(doc, maxTokensPerDoc);
      
      // Count tokens in the truncated document
      const docTokens = countTokens(truncatedDoc.title + ' ' + truncatedDoc.body);
      totalTokens += docTokens;

      return {
        ...truncatedDoc,
        metadata: {
          ...truncatedDoc.metadata,
          tokenCount: docTokens,
        },
      };
    });

    // Extract source metadata for attribution
    const sourceMetadata = SearchService.extractSourceMetadata(docs);

    // Rank and filter documents by relevance
    const rankedDocs = SearchService.rankAndFilterDocuments(processedDocs, minRelevance);
    
    // Limit the total number of documents to control token count
    // Use 50% of model's context window for documents, leaving room for the prompt and response
    const maxDocsTokens = Math.floor(modelConfig.maxContextTokens * 0.5);
    let currentTokens = 0;
    const limitedDocs = [];
    
    // Log model configuration
    logger.info(
      {
        modelId,
        modelName: modelConfig.name,
        maxContextTokens: modelConfig.maxContextTokens,
        maxDocsTokens,
        totalRetrievedDocs: rankedDocs.length,
        totalRetrievedTokens: totalTokens,
      },
      'Document token limits based on model configuration'
    );
    
    for (const doc of rankedDocs) {
      if (currentTokens + (doc.metadata?.tokenCount || 0) > maxDocsTokens) {
        // Skip this document if it would exceed our token budget
        continue;
      }
      
      limitedDocs.push(doc);
      currentTokens += doc.metadata?.tokenCount || 0;
      
      // If we've reached our document limit, stop adding more
      if (limitedDocs.length >= 5) {
        break;
      }
    }
    
    // Update the total token count
    totalTokens = currentTokens;

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
    logger.error({
      errorMessage: error instanceof Error ? error.message : String(error),
      userId
    }, 'Error retrieving context');

    // Log the error event with minimal info
    ObservabilityService.logEvent(env, traceId, spanId, 'retrieval_error', {
      userId,
      errorMessage: error instanceof Error ? error.message : String(error),
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

