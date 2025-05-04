import { getLogger } from '@dome/common';
import { AgentState, Document, QueryAnalysis } from '../types';
import { LlmService } from '../services/llmService';
import { ObservabilityService } from '../services/observabilityService';

/**
 * Widening strategy types
 */
export enum WideningStrategy {
  SEMANTIC = 'semantic', // Expands semantic scope for better recall
  TEMPORAL = 'temporal', // Extends time range for historical content
  RELEVANCE = 'relevance', // Reduces relevance threshold to include more results
  CATEGORY = 'category', // Expands to related content categories
  SYNONYM = 'synonym', // Includes synonyms and related terms
  HYBRID = 'hybrid', // Combines multiple strategies
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

  // Get task information from state
  const taskIds = state.taskIds || [];
  const taskEntities = state.taskEntities || {};

  // Track the tasks that need widening
  const tasksToWiden: string[] = [];

  // Find tasks that need widening
  for (const taskId of taskIds) {
    const task = taskEntities[taskId];
    if (!task) continue;

    if (task.needsWidening) {
      tasksToWiden.push(taskId);
    }
  }

  if (tasksToWiden.length === 0) {
    logger.info('No tasks need widening, skipping dynamicWiden node');
    const endTime = performance.now();
    const executionTime = endTime - startTime;

    return {
      ...state,
      metadata: {
        ...state.metadata,
        nodeTimings: {
          ...state.metadata?.nodeTimings,
          dynamicWiden: executionTime,
        },
      },
    };
  }

  // Set maximum iterations to prevent infinite widening
  const MAX_WIDENING_ATTEMPTS = 3;

  // Create an updated state we'll modify
  const updatedState = {
    ...state,
    taskEntities: { ...taskEntities },
  };

  // Process each task that needs widening
  for (const taskId of tasksToWiden) {
    const task = taskEntities[taskId];

    // Increment widening attempts
    const wideningAttempts = (task.wideningAttempts || 0) + 1;

    // Check if we've reached maximum attempts
    if (wideningAttempts > MAX_WIDENING_ATTEMPTS) {
      logger.warn(
        {
          taskId,
          wideningAttempts,
          maxAttempts: MAX_WIDENING_ATTEMPTS,
          traceId,
          spanId,
        },
        'Maximum widening attempts reached for task',
      );

      // Update task with no further widening
      updatedState.taskEntities[taskId] = {
        ...updatedState.taskEntities[taskId],
        needsWidening: false,
        wideningAttempts,
        wideningStrategy: WideningStrategy.HYBRID,
        wideningParams: {
          strategy: WideningStrategy.HYBRID,
          maxIterations: MAX_WIDENING_ATTEMPTS,
          minRelevance: 0.2, // Lower threshold as a final attempt
        },
      };

      continue;
    }

    logger.info(
      {
        taskId,
        wideningAttempts,
        originalQuery: task.originalQuery,
        rewrittenQuery: task.rewrittenQuery,
        previousDocCount: task.docs?.length || 0,
        traceId,
        spanId,
      },
      'Widening search parameters for task',
    );

    try {
      // Analyze query characteristics, previous results, and retrieval metrics
      // to determine the optimal widening strategy
      const wideningParams = await determineWideningStrategy(
        task,
        state.docs || [],
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
          taskId,
          wideningAttempts,
          strategy: wideningParams.strategy,
          params: wideningParams,
          traceId,
          spanId,
        },
        'Selected widening strategy for task',
      );

      // Update task with widening parameters
      updatedState.taskEntities[taskId] = {
        ...updatedState.taskEntities[taskId],
        wideningAttempts,
        wideningStrategy: wideningParams.strategy,
        wideningParams,
      };

      // Log the widening event
      ObservabilityService.logEvent(env, traceId, spanId, 'widening_parameters_adjusted', {
        taskId,
        wideningAttempts,
        strategy: wideningParams.strategy,
        params: wideningParams,
      });
    } catch (error) {
      // Log the error
      logger.error(
        {
          err: error,
          taskId,
          wideningAttempts,
          traceId,
          spanId,
        },
        'Error determining widening strategy for task',
      );

      // Use default widening parameters on error
      const defaultParams: WideningParams = {
        strategy: WideningStrategy.RELEVANCE,
        minRelevance: Math.max(0.5 - wideningAttempts * 0.1, 0.2),
        expandSynonyms: wideningAttempts > 1,
        includeRelated: wideningAttempts > 1,
      };

      // Update task with default widening parameters
      updatedState.taskEntities[taskId] = {
        ...updatedState.taskEntities[taskId],
        wideningAttempts,
        wideningStrategy: defaultParams.strategy,
        wideningParams: defaultParams,
      };

      // Log the error event
      ObservabilityService.logEvent(env, traceId, spanId, 'widening_error', {
        taskId,
        error: error instanceof Error ? error.message : String(error),
        wideningAttempts,
        fallbackStrategy: defaultParams.strategy,
      });
    }
  }

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
};

/**
 * Determine the best widening strategy based on query characteristics and previous results
 */
async function determineWideningStrategy(
  task: any,
  allDocs: Document[],
  env: Env,
  wideningAttempts: number,
  traceId: string,
  spanId: string,
): Promise<WideningParams> {
  const logger = getLogger().child({ node: 'dynamicWiden', function: 'determineWideningStrategy' });

  // Get the query
  const query = task.rewrittenQuery || task.originalQuery || '';

  // Get docs related to this task (if available) or use all docs as a fallback
  const previousDocs = task.docs || allDocs;
  const queryAnalysis = task.queryAnalysis;

  // If we have previous results, analyze them to determine the best strategy
  if (previousDocs.length > 0) {
    // Check if the results are relevant but insufficient
    const relevanceScores = previousDocs.map((doc: Document) => doc.metadata.relevanceScore);
    const avgRelevance =
      relevanceScores.reduce((sum: number, score: number) => sum + score, 0) /
      relevanceScores.length;

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
