import { getLogger } from '@dome/common';
import { Document, QueryAnalysis } from '../types';
import { AgentStateV3 as AgentState } from '../types/stateSlices';
import { LlmService } from '../services/llmService';
import { ObservabilityService } from '../services/observabilityService';
import type { SliceUpdate } from '../types/stateSlices';
import {
  WideningStrategy,
  WideningParams,
  determineWideningStrategy,
  learnFromSuccessfulRetrievals,
} from './helpers/widening';

export type DynamicWidenUpdate = SliceUpdate<'taskEntities'>;

/**
 * Dynamically widen search parameters for better retrieval with intelligent parameter adjustment
 * Implements safeguards for maximum iterations and tracks effectiveness of widening strategies
 */
export const dynamicWiden = async (state: AgentState, env: Env): Promise<DynamicWidenUpdate> => {
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
  const updatedTaskEntities: typeof taskEntities = { ...taskEntities };

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
      updatedTaskEntities[taskId] = {
        ...updatedTaskEntities[taskId],
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
      updatedTaskEntities[taskId] = {
        ...updatedTaskEntities[taskId],
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
      updatedTaskEntities[taskId] = {
        ...updatedTaskEntities[taskId],
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
    { ...state, taskEntities: updatedTaskEntities },
    executionTime,
  );

  return {
    taskEntities: updatedTaskEntities,
    metadata: {
      ...state.metadata,
      nodeTimings: {
        ...state.metadata?.nodeTimings,
        dynamicWiden: executionTime,
      },
      currentNode: 'dynamicWiden',
    },
  };
};

// Re-export strategy enum for legacy tests
export { WideningStrategy } from './helpers/widening';
