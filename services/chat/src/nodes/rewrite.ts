import { getLogger, logError } from '@dome/common';
import { z } from 'zod';
import { AgentStateV3 as AgentState } from '../types/stateSlices';
import { getUserId } from '../utils/stateUtils';
import { LlmService } from '../services/llmService';
import { buildMessages } from '../utils';
import { ObservabilityService } from '../services/observabilityService';
import { getCondenseTaskPrompt } from '../config/promptsConfig';
import type { SliceUpdate } from '../types/stateSlices';

const rewrittenTaskSchema = z.object({
  rewrittenQuery: z.string(),
  reasoning: z.string().nullable(),
});
type RewrittenTask = z.infer<typeof rewrittenTaskSchema>;

/**
 * Node: rewrite
 * ------------------------------------------------------------------
 * 1. Use CONDENSE_TASK_PROMPT to rewrite queries succinctly
 * 2. Process tasks asynchronously
 * 3. Update task definitions in state
 *
 * This node condenses verbose user queries into clearer, more focused task
 * definitions to improve downstream processing.
 */
export type RewriteUpdate = SliceUpdate<'taskEntities' | 'reasoning'>;

export const rewrite = async (state: AgentState, env: Env): Promise<RewriteUpdate> => {
  const logger = getLogger().child({ node: 'rewrite' });
  const t0 = performance.now();

  /* --------------------------------------------------------------- */
  /*  1. Initialize observability                                    */
  /* --------------------------------------------------------------- */
  const userId = getUserId(state);
  const traceId = state.metadata?.traceId ?? ObservabilityService.initTrace(env, userId, state);
  const spanId = ObservabilityService.startSpan(env, traceId, 'rewrite', state);
  const logEvt = (e: string, p: Record<string, unknown>) =>
    ObservabilityService.logEvent(env, traceId, spanId, e, p);

  const taskEntities = state.taskEntities || {};
  const taskCount = Object.keys(taskEntities).length;

  if (taskCount === 0) {
    logger.info('No tasks to rewrite');
    const elapsed = performance.now() - t0;

    ObservabilityService.endSpan(env, traceId, spanId, 'rewrite', state, state, elapsed);

    return {
      reasoning: [...(state.reasoning || []), 'No tasks to rewrite.'],
      metadata: {
        ...state.metadata,
        traceId,
        spanId,
        currentNode: 'rewrite',
        nodeTimings: {
          ...state.metadata?.nodeTimings,
          rewrite: elapsed,
        },
      },
    };
  }

  logEvt('rewrite_start', { taskCount });

  try {
    /* --------------------------------------------------------------- */
    /*  2. Process each task asynchronously to rewrite queries         */
    /* --------------------------------------------------------------- */
    // Schema is already defined with zod above

    // Process tasks in parallel
    const tasks = state.taskEntities ?? {};
    const reasons = await Promise.all(
      Object.entries(taskEntities).map(async ([taskId, task]) => {
        const originalQuery = task.originalQuery || '';
        if (!originalQuery) {
          logger.warn({ taskId }, 'Task has no original query to rewrite');
          return 'No original query to rewrite.';
        }

        // Create messages for the LLM call
        const messages = buildMessages(getCondenseTaskPrompt(), state.chatHistory, originalQuery);

        // Call LLM with structured output schema
        try {
          const result = await LlmService.invokeStructured<RewrittenTask>(env, messages, {
            schema: rewrittenTaskSchema,
            schemaInstructions: 'Rewrite the user query in a concise, clear format',
            task: 'rewrite',
          });

          tasks[taskId].rewrittenQuery = result.rewrittenQuery;
          tasks[taskId].definition = result.rewrittenQuery;
          return result.reasoning || 'No reasoning provided';
        } catch (error) {
          logError(error, 'Error rewriting task', { taskId });
          return `Error during rewriting: ${
            error instanceof Error ? error.message : 'Unknown error'
          }`;
        }
      }),
    );

    /* --------------------------------------------------------------- */
    /*  4. Log completion and metrics                                  */
    /* --------------------------------------------------------------- */
    const elapsed = performance.now() - t0;
    logEvt('rewrite_complete', {
      taskCount,
      processingTimeMs: elapsed,
      taskRewriteCount: reasons.length,
    });

    ObservabilityService.endSpan(env, traceId, spanId, 'rewrite', state, state, elapsed);

    /* --------------------------------------------------------------- */
    /*  5. Return updated state                                        */
    /* --------------------------------------------------------------- */
    return {
      taskEntities: tasks,
      reasoning: [...(state.reasoning || []), ...reasons],
      metadata: {
        ...state.metadata,
        traceId,
        spanId,
        currentNode: 'rewrite',
        nodeTimings: {
          ...state.metadata?.nodeTimings,
          rewrite: elapsed,
        },
      },
    };
  } catch (error) {
    logError(error, 'Error in rewrite node');

    // Handle error case
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    const elapsed = performance.now() - t0;

    // Add error to metadata before ending span
    const stateWithError = {
      ...state,
      metadata: {
        ...state.metadata,
        errors: [
          ...(state.metadata?.errors || []),
          {
            node: 'rewrite',
            message: errorMsg,
            timestamp: Date.now(),
          },
        ],
      },
    };

    ObservabilityService.endSpan(env, traceId, spanId, 'rewrite', state, stateWithError, elapsed);

    return {
      reasoning: [...(state.reasoning || []), `Error rewriting tasks: ${errorMsg}`],
      metadata: {
        ...state.metadata,
        traceId,
        spanId,
        currentNode: 'rewrite',
        nodeTimings: {
          ...state.metadata?.nodeTimings,
          rewrite: elapsed,
        },
        errors: [
          ...(state.metadata?.errors || []),
          {
            node: 'rewrite',
            message: errorMsg,
            timestamp: Date.now(),
          },
        ],
      },
    };
  }
};
