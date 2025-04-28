import { getLogger } from '@dome/logging';
import { AgentState, Document, QueryAnalysis } from '../types';
import { LlmService } from '../services/llmService';
import { ObservabilityService } from '../services/observabilityService';

/**
 * Widening strategy types
 */
export enum WideningStrategy {
  SEMANTIC = 'semantic',    // Expands semantic scope for better recall
  TEMPORAL = 'temporal',    // Extends time range for historical content
  RELEVANCE = 'relevance',  // Reduces relevance threshold to include more results
  CATEGORY = 'category',    // Expands to related content categories
  SYNONYM = 'synonym',      // Includes synonyms and related terms
  HYBRID = 'hybrid'         // Combines multiple strategies
}

/**
 * Interface for widening parameters
 */
export interface WideningParams extends Record<string, unknown> {
  strategy: WideningStrategy;
  minRelevance?: number;
  expandSynonyms?: boolean;
  includeRelated?: boolean;
  startDate?: number;
  endDate?: number;
  category?: string;
  maxIterations?: number;
  reasonForWidening?: string;
}

/**
 * Dynamically widen search parameters for better retrieval with intelligent parameter adjustment
 * Implements safeguards for maximum iterations and tracks effectiveness of widening strategies
 */
export const dynamicWiden = async (state: AgentState, env: Env): Promise<AgentState> => {
  const logger = getLogger().child({ node: 'dynamicWiden' });
  const startTime = performance.now();

  // Get trace and span IDs for observability
  const traceId = state.metadata?.traceId || '';
  const spanId = ObservabilityService.startSpan(env, traceId, 'dynamicWiden', state);

  // Increment widening attempts
  const wideningAttempts = (state.tasks?.wideningAttempts || 0) + 1;
  
  // Set maximum iterations to prevent infinite widening
  const MAX_WIDENING_ATTEMPTS = 3;
  
  // Check if we've reached maximum attempts
  if (wideningAttempts > MAX_WIDENING_ATTEMPTS) {
    logger.warn(
      {
        wideningAttempts,
        maxAttempts: MAX_WIDENING_ATTEMPTS,
        traceId,
        spanId,
      },
      'Maximum widening attempts reached',
    );
    
    const endTime = performance.now();
    const executionTime = endTime - startTime;
    
    // Return state with no further widening
    return {
      ...state,
      tasks: {
        ...state.tasks,
        needsWidening: false,
        wideningAttempts,
        wideningStrategy: WideningStrategy.HYBRID,
        wideningParams: {
          strategy: WideningStrategy.HYBRID,
          maxIterations: MAX_WIDENING_ATTEMPTS,
          minRelevance: 0.2, // Lower threshold as a final attempt
        },
      },
      metadata: {
        ...state.metadata,
        nodeTimings: {
          ...state.metadata?.nodeTimings,
          dynamicWiden: executionTime,
        },
      },
    };
  }

  logger.info(
    {
      wideningAttempts,
      originalQuery: state.tasks?.originalQuery,
      rewrittenQuery: state.tasks?.rewrittenQuery,
      previousDocCount: state.docs?.length || 0,
      traceId,
      spanId,
    },
    'Widening search parameters',
  );

  try {
    // Analyze query characteristics, previous results, and retrieval metrics
    // to determine the optimal widening strategy
    const wideningParams = await determineWideningStrategy(
      state,
      env,
      wideningAttempts,
      traceId,
      spanId,
    );
    
    // Add maximum iterations to widening parameters
    wideningParams.maxIterations = MAX_WIDENING_ATTEMPTS;

    // Log the selected strategy
    logger.info(
      {
        wideningAttempts,
        strategy: wideningParams.strategy,
        params: wideningParams,
        traceId,
        spanId,
      },
      'Selected widening strategy',
    );

    // Update state with widening parameters
    const updatedState = {
      ...state,
      tasks: {
        ...state.tasks,
        wideningAttempts,
        wideningStrategy: wideningParams.strategy,
        wideningParams,
      },
    };

    // Update state with timing information
    const endTime = performance.now();
    const executionTime = endTime - startTime;

    // End the span
    ObservabilityService.endSpan(
      env,
      traceId,
      spanId,
      'dynamicWiden',
      state,
      updatedState,
      executionTime,
    );

    // Log the widening event
    ObservabilityService.logEvent(env, traceId, spanId, 'widening_parameters_adjusted', {
      wideningAttempts,
      strategy: wideningParams.strategy,
      params: wideningParams,
      executionTimeMs: executionTime,
    });

    return {
      ...updatedState,
      metadata: {
        ...updatedState.metadata,
        nodeTimings: {
          ...updatedState.metadata?.nodeTimings,
          dynamicWiden: executionTime,
        },
      },
    };
  } catch (error) {
    // Log the error
    logger.error(
      {
        err: error,
        wideningAttempts,
        traceId,
        spanId,
      },
      'Error in dynamic widening',
    );

    // Use default widening parameters on error
    const defaultParams: WideningParams = {
      strategy: WideningStrategy.RELEVANCE,
      minRelevance: Math.max(0.5 - wideningAttempts * 0.1, 0.2),
      expandSynonyms: wideningAttempts > 1,
      includeRelated: wideningAttempts > 1,
    };

    // Update state with timing information
    const endTime = performance.now();
    const executionTime = endTime - startTime;

    // End the span with error
    ObservabilityService.endSpan(
      env,
      traceId,
      spanId,
      'dynamicWiden',
      state,
      {
        ...state,
        tasks: {
          ...state.tasks,
          wideningAttempts,
          wideningStrategy: defaultParams.strategy,
          wideningParams: defaultParams,
        },
      },
      executionTime,
    );

    // Log the error event
    ObservabilityService.logEvent(env, traceId, spanId, 'widening_error', {
      error: error instanceof Error ? error.message : String(error),
      wideningAttempts,
      fallbackStrategy: defaultParams.strategy,
      executionTimeMs: executionTime,
    });

    return {
      ...state,
      tasks: {
        ...state.tasks,
        wideningAttempts,
        wideningStrategy: defaultParams.strategy,
        wideningParams: defaultParams,
      },
      metadata: {
        ...state.metadata,
        nodeTimings: {
          ...state.metadata?.nodeTimings,
          dynamicWiden: executionTime,
        },
        errors: [
          ...(state.metadata?.errors || []),
          {
            node: 'dynamicWiden',
            message: error instanceof Error ? error.message : String(error),
            timestamp: Date.now(),
          },
        ],
      },
    };
  }
};

/**
 * Determine the best widening strategy based on query characteristics and previous results
 */
async function determineWideningStrategy(
  state: AgentState,
  env: Env,
  wideningAttempts: number,
  traceId: string,
  spanId: string,
): Promise<WideningParams> {
  const logger = getLogger().child({ node: 'dynamicWiden', function: 'determineWideningStrategy' });

  // Get the query and previous results
  const query = state.tasks?.rewrittenQuery || state.tasks?.originalQuery || '';
  const previousDocs = state.docs || [];
  const queryAnalysis = state.tasks?.queryAnalysis;

  // If we have previous results, analyze them to determine the best strategy
  if (previousDocs.length > 0) {
    // Check if the results are relevant but insufficient
    const relevanceScores = previousDocs.map(doc => doc.metadata.relevanceScore);
    const avgRelevance =
      relevanceScores.reduce((sum, score) => sum + score, 0) / relevanceScores.length;

    // If average relevance is high but we don't have enough results, try temporal widening
    if (avgRelevance > 0.7 && previousDocs.length < 3) {
      logger.info(
        {
          avgRelevance,
          docCount: previousDocs.length,
          wideningAttempts,
          traceId,
          spanId,
        },
        'Using temporal widening strategy due to high relevance but few results',
      );

      return {
        strategy: WideningStrategy.TEMPORAL,
        minRelevance: 0.6,
        expandSynonyms: false,
        includeRelated: true,
        // Widen the date range progressively
        startDate: Date.now() - (90 + wideningAttempts * 90) * 24 * 60 * 60 * 1000, // 3+ months ago
        endDate: Date.now(),
      };
    }

    // If average relevance is low, try semantic widening
    if (avgRelevance < 0.6) {
      logger.info(
        {
          avgRelevance,
          docCount: previousDocs.length,
          wideningAttempts,
          traceId,
          spanId,
        },
        'Using semantic widening strategy due to low relevance',
      );

      return {
        strategy: WideningStrategy.SEMANTIC,
        minRelevance: Math.max(0.4 - wideningAttempts * 0.1, 0.2),
        expandSynonyms: true,
        includeRelated: true,
      };
    }
  }

  // If we have a query analysis, use it to determine the strategy
  if (queryAnalysis) {
    // If the query is complex, try category widening
    if (queryAnalysis.isComplex) {
      logger.info(
        {
          queryAnalysis,
          wideningAttempts,
          traceId,
          spanId,
        },
        'Using category widening strategy due to complex query',
      );

      return {
        strategy: WideningStrategy.CATEGORY,
        minRelevance: 0.5 - wideningAttempts * 0.1,
        expandSynonyms: true,
        includeRelated: true,
      };
    }
  }

  // Check for temporal indicators in the query
  const temporalPattern =
    /\b(recent|latest|new|old|past|history|historical|yesterday|today|last week|last month|last year)\b/i;
  if (temporalPattern.test(query)) {
    logger.info(
      {
        query,
        wideningAttempts,
        traceId,
        spanId,
      },
      'Using temporal widening strategy due to temporal indicators in query',
    );

    return {
      strategy: WideningStrategy.TEMPORAL,
      minRelevance: 0.5,
      expandSynonyms: false,
      includeRelated: true,
      // Widen the date range progressively
      startDate: Date.now() - (30 + wideningAttempts * 60) * 24 * 60 * 60 * 1000, // 1+ months ago
      endDate: Date.now(),
    };
  }

  // Default to progressive relevance reduction
  logger.info(
    {
      wideningAttempts,
      traceId,
      spanId,
    },
    'Using default relevance widening strategy',
  );

  return {
    strategy: WideningStrategy.RELEVANCE,
    minRelevance: Math.max(0.5 - wideningAttempts * 0.1, 0.2),
    expandSynonyms: wideningAttempts > 1,
    includeRelated: wideningAttempts > 1,
  };
}

/**
 * Learn from successful retrievals to improve future widening strategies
 * This is a placeholder for future implementation of a learning mechanism
 */
async function learnFromSuccessfulRetrievals(
  state: AgentState,
  env: Env,
  wideningParams: WideningParams,
  traceId: string,
  spanId: string,
): Promise<void> {
  // This would be implemented in a future version to track successful strategies
  // and adjust parameters based on historical performance

  // For now, just log the successful strategy
  const logger = getLogger().child({
    node: 'dynamicWiden',
    function: 'learnFromSuccessfulRetrievals',
  });

  logger.info(
    {
      strategy: wideningParams.strategy,
      params: wideningParams,
      traceId,
      spanId,
    },
    'Successful widening strategy recorded for learning',
  );

  // In a real implementation, this would:
  // 1. Store the successful strategy in a database
  // 2. Update a model that predicts the best strategy for similar queries
  // 3. Adjust default parameters based on historical performance
}
