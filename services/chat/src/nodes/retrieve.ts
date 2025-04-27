import { getLogger } from '@dome/logging';
import { AgentState, Document } from '../types';
import { countTokens, estimateDocumentTokens } from '../utils/tokenCounter';
import { getUserId } from '../utils/stateUtils';
import { truncateDocumentToMaxTokens } from '../utils/promptFormatter';
import { SearchService } from '../services/searchService';
import { ObservabilityService } from '../services/observabilityService';
import { LlmService } from '../services/llmService';
import { getModelConfig, getRetrieveConfig, calculateMinRelevanceScore } from '../config';
import {
  updateStateWithTiming,
  updateStateWithTokenCount,
  addErrorToState,
} from '../utils/stateUpdateHelpers';

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
  logger.info(
    {
      enhanceWithContext: state.options?.enhanceWithContext,
      maxContextItems: state.options?.maxContextItems,
    },
    'Retrieve node options',
  );

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

    return updateStateWithTiming({ ...state, docs: [] }, 'retrieve', 0, spanId);
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

  // Adjust search parameters based on widening attempts and configuration
  const minRelevance = calculateMinRelevanceScore(wideningAttempts);
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

    // Get model configuration and retrieval config
    const modelId = state.options?.modelId || LlmService.MODEL;
    const modelConfig = getModelConfig(modelId);
    const retrieveConfig = getRetrieveConfig();
    
    // Calculate token limits
    const maxTokensPerDoc = Math.floor(
      modelConfig.maxContextTokens * retrieveConfig.tokenAllocation.maxPerDocument
    );
    const maxDocsTokens = Math.floor(
      modelConfig.maxContextTokens * retrieveConfig.tokenAllocation.maxForAllDocuments
    );
    
    // Extract source metadata for attribution
    const sourceMetadata = SearchService.extractSourceMetadata(docs);
    
    // Process documents in a single pass
    const processedDocs: Document[] = [];
    let totalTokens = 0;
    
    // First, truncate and rank documents by relevance
    const rankedDocs = SearchService.rankAndFilterDocuments(
      docs.map(doc => {
        const truncatedDoc = truncateDocumentToMaxTokens(doc, maxTokensPerDoc);
        const docTokens = estimateDocumentTokens(truncatedDoc);
        
        return {
          ...truncatedDoc,
          metadata: {
            ...truncatedDoc.metadata,
            tokenCount: docTokens,
          },
        };
      }),
      minRelevance
    );
    
    // Log model configuration
    logger.info(
      {
        modelId,
        modelName: modelConfig.name,
        maxContextTokens: modelConfig.maxContextTokens,
        maxDocsTokens,
        totalRetrievedDocs: rankedDocs.length,
      },
      'Document token limits based on model configuration'
    );
    
    // Then select documents respecting token budget and document limit
    for (const doc of rankedDocs) {
      const docTokens = doc.metadata?.tokenCount || 0;
      
      // Skip if would exceed token budget
      if (totalTokens + docTokens > maxDocsTokens) {
        continue;
      }
      
      // Add document and update token count
      processedDocs.push(doc);
      totalTokens += docTokens;
      
      // Stop if we've reached document limit
      if (processedDocs.length >= retrieveConfig.documentLimits.maxDocuments) {
        break;
      }
    }

    // Update state with timing information
    const endTime = performance.now();
    const executionTime = endTime - startTime;

    // Create updated state with docs and tasks
    const updatedState = {
      ...state,
      docs: processedDocs,
      tasks: {
        ...state.tasks,
        needsWidening: docsCount < 2 && wideningAttempts < 2,
        wideningAttempts,
      },
    };

    // Add timing and token count information
    let resultState = updateStateWithTiming(updatedState, 'retrieve', executionTime, spanId);
    resultState = updateStateWithTokenCount(resultState, 'retrievedDocs', totalTokens);

    // End the span
    ObservabilityService.endSpan(
      env,
      traceId,
      spanId,
      'retrieve',
      state,
      resultState,
      executionTime,
    );

    return resultState;
  } catch (error) {
    logger.error(
      {
        errorMessage: error instanceof Error ? error.message : String(error),
        userId,
      },
      'Error retrieving context',
    );

    // Log the error event with minimal info
    ObservabilityService.logEvent(env, traceId, spanId, 'retrieval_error', {
      userId,
      errorMessage: error instanceof Error ? error.message : String(error),
    });

    // Update state with timing information
    const endTime = performance.now();
    const executionTime = endTime - startTime;

    // Create error state with empty docs
    const errorState = updateStateWithTiming(
      { ...state, docs: [] },
      'retrieve',
      executionTime,
      spanId,
    );

    // Add error information and return
    return addErrorToState(
      errorState,
      'retrieve',
      error instanceof Error ? error.message : String(error),
    );
  }
};
