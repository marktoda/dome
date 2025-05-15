import { getLogger } from '@dome/common';
import { z } from 'zod';
import { AgentState, UserTaskEntity } from '../types';
import { getUserId } from '../utils/stateUtils';
import { buildMessages } from '../utils';
import { LlmService } from '../services/llmService';
import { ObservabilityService } from '../services/observabilityService';
import { getSplitTaskPrompt } from '../config/promptsConfig';
import type { SliceUpdate } from '../types/stateSlices';

/**
 * Zod schema for task extraction
 * Used for structured output from LLM
 */
const splitInputSchema = z.object({
  tasks: z.array(
    z.object({
      id: z.string(),
      query: z.string(),
    }),
  ).nullable(),
  instructions: z.string().nullable(),
  reasoning: z.string().nullable(),
});

// Type inference from the Zod schema
type SplittedInput = z.infer<typeof splitInputSchema>;

/**
 * Node: routing_split
 * ------------------------------------------------------------------
 * 1. Extract instructions and tasks from user query using structured output from LLM
 * 2. Create UserTaskEntity objects for each identified task
 * 3. Return enriched state with reasoning and task entities
 */
export type RoutingSplitUpdate = SliceUpdate<
  'taskIds' | 'taskEntities' | 'instructions' | 'reasoning'
>;

export const routingSplit = async (state: AgentState, env: Env): Promise<RoutingSplitUpdate> => {
  const logger = getLogger().child({ node: 'routingSplit' });
  const t0 = performance.now();

  /* --------------------------------------------------------------- */
  /*  1. Grab the latest user message                                */
  /* --------------------------------------------------------------- */
  const lastUserMsg = [...state.messages].reverse().find(m => m.role === 'user');
  if (!lastUserMsg) {
    logger.warn('No user message found');
    return {
      reasoning: [...(state.reasoning || []), 'No user message found to process.'],
      metadata: {
        ...state.metadata,
        currentNode: 'routing_split',
      },
    };
  }

  /* --------------------------------------------------------------- */
  /*  2. Schema already defined with zod above                       */
  /* --------------------------------------------------------------- */

  /* --------------------------------------------------------------- */
  /*  3. Observability setup                                         */
  /* --------------------------------------------------------------- */
  const userId = getUserId(state);
  const traceId = state.metadata?.traceId ?? ObservabilityService.initTrace(env, userId, state);
  const spanId = ObservabilityService.startSpan(env, traceId, 'routingSplit', state);
  const logEvt = (e: string, p: Record<string, unknown>) =>
    ObservabilityService.logEvent(env, traceId, spanId, e, p);

  logEvt('routing_split_start', { userMessage: lastUserMsg.content });

  try {
    /* --------------------------------------------------------------- */
    /*  4. Use LLM to extract tasks and instructions                   */
    /* --------------------------------------------------------------- */
    // Add a system message with instructions for the task extraction
    const messages = buildMessages(getSplitTaskPrompt(), state.chatHistory, lastUserMsg.content);

    // Call LLM with structured output schema
    const result: SplittedInput = await LlmService.invokeStructured<SplittedInput>(env, messages, {
      schema: splitInputSchema,
      schemaInstructions: 'Extract tasks from the user query and provide reasoning',
      task: 'rewrite',
    });

    /* --------------------------------------------------------------- */
    /*  5. Parse the result, handling both direct structured           */
    /*     response and AIMessageChunk format                          */
    /* --------------------------------------------------------------- */
    let responseFormat = 'direct';
    logger.info({ result }, 'Received raw result from LLM');

    /* --------------------------------------------------------------- */
    /*  6. Create task entities from parsed result                     */
    /* --------------------------------------------------------------- */
    const taskEntities: Record<string, UserTaskEntity> = {};
    const taskIds: string[] = [];

    // Add proper null checks to handle cases where tasks might be undefined
    if (!result?.tasks || !Array.isArray(result.tasks)) {
      logger.warn(
        { result },
        'LLM response missing tasks array or invalid format, creating default task',
      );

      // Create a default task as fallback
      const defaultTaskId = `default-task-${Date.now()}-${Math.random()
        .toString(36)
        .substring(2, 9)}`;
      taskEntities[defaultTaskId] = {
        id: defaultTaskId,
        originalQuery: lastUserMsg.content, // Use the original user message
        status: 'pending',
        createdAt: Date.now(),
      };
      taskIds.push(defaultTaskId);
    } else {
      // Process tasks normally when they exist
      result.tasks.forEach(task => {
        // Generate a simple timestamp-based ID if one isn't provided
        const taskId =
          task.id || `task-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
        taskEntities[taskId] = {
          id: taskId,
          originalQuery: task.query || lastUserMsg.content, // Fallback to original message if query is missing
          status: 'pending',
          createdAt: Date.now(),
        };
        taskIds.push(taskId);
      });
    }

    // Safely access properties with fallbacks, handling null values explicitly
    const instructions = result?.instructions === null ? '' : result?.instructions || '';
    const reasoning =
      result?.reasoning === null
        ? 'Processed user query and extracted tasks.'
        : result?.reasoning || 'Processed user query and extracted tasks.';

    /* --------------------------------------------------------------- */
    /*  7. Log completion and metrics                                  */
    /* --------------------------------------------------------------- */
    const elapsed = performance.now() - t0;
    logEvt('routing_split_complete', {
      taskCount: result?.tasks && Array.isArray(result.tasks) ? result.tasks.length : 1,
      instructions: instructions,
      reasoning: reasoning,
      responseFormat: responseFormat,
      elapsedMs: elapsed,
    });

    ObservabilityService.endSpan(env, traceId, spanId, 'routingSplit', state, state, elapsed);

    logger.info(
      {
        taskCount: result?.tasks && Array.isArray(result.tasks) ? result.tasks.length : 1,
        instructions: instructions,
        responseFormat: responseFormat,
        elapsedMs: elapsed,
      },
      'routingSplit done',
    );

    /* --------------------------------------------------------------- */
    /*  8. Return updated state                                        */
    /* --------------------------------------------------------------- */
    return {
      taskIds,
      taskEntities,
      instructions,
      reasoning: [...(state.reasoning || []), reasoning],
      metadata: {
        ...state.metadata,
        traceId,
        spanId,
        currentNode: 'routing_split',
        nodeTimings: {
          ...state.metadata?.nodeTimings,
          routingSplit: elapsed,
        },
      },
    };
  } catch (error) {
    // Create more specific error logging
    if (error instanceof z.ZodError) {
      logger.error(
        {
          err: error,
          zodErrors: error.errors,
        },
        'Schema validation error in routingSplit - malformed LLM response',
      );
    } else if (error instanceof SyntaxError && error.message.includes('JSON')) {
      logger.error(
        {
          err: error,
        },
        'JSON parsing error in routingSplit - invalid JSON in AIMessageChunk content',
      );
    } else if (error instanceof TypeError && error.message.includes('undefined')) {
      logger.error(
        {
          err: error,
        },
        'Null/undefined property access error in routingSplit - likely malformed LLM response',
      );
    } else {
      logger.error({ err: error }, 'Unexpected error in routingSplit');
    }

    // Handle error case with more context
    let errorMsg = 'Unknown error processing your request';
    if (error instanceof Error) {
      errorMsg = `Error processing query: ${error.message}`;
    }
    const elapsed2 = performance.now() - t0;

    // Add error to metadata before ending span
    const stateWithError = {
      ...state,
      metadata: {
        ...state.metadata,
        errors: [
          ...(state.metadata?.errors || []),
          {
            node: 'routingSplit',
            message: errorMsg,
            timestamp: Date.now(),
          },
        ],
      },
    };

    ObservabilityService.endSpan(
      env,
      traceId,
      spanId,
      'routingSplit',
      state,
      stateWithError,
      elapsed2,
    );

    // Create a default task as fallback
    const defaultTaskId = `default-task-${Date.now()}-${Math.random()
      .toString(36)
      .substring(2, 9)}`;
    const taskEntities: Record<string, UserTaskEntity> = {
      [defaultTaskId]: {
        id: defaultTaskId,
        originalQuery: lastUserMsg.content,
        status: 'pending',
        createdAt: Date.now(),
      },
    };

    // Create taskIds array with the default task ID
    const taskIds = [defaultTaskId];

    return {
      taskIds,
      taskEntities,
      instructions: '',
      reasoning: [...(state.reasoning || []), `Error processing query: ${errorMsg}`],
      metadata: {
        ...state.metadata,
        traceId,
        spanId,
        currentNode: 'routing_split',
        nodeTimings: {
          ...state.metadata?.nodeTimings,
          routingSplit: elapsed2,
        },
        errors: [
          ...(state.metadata?.errors || []),
          {
            node: 'routingSplit',
            message: errorMsg,
            timestamp: Date.now(),
          },
        ],
      },
    };
  }
};
