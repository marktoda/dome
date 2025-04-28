import { getLogger } from '@dome/logging';
import { z } from 'zod';
import { AgentState, AIMessage, UserTaskEntity } from '../types';
import { getUserId } from '../utils/stateUtils';
import { LlmService } from '../services/llmService';
import { ObservabilityService } from '../services/observabilityService';
import { getCondenseTaskPrompt } from '../config/promptsConfig';

/**
 * Zod schema for task rewriting output
 * Used for structured output from LLM
 */
const rewrittenTaskSchema = z.object({
  taskId: z.string(),
  rewrittenQuery: z.union([z.string(), z.null()]),
  requiredTools: z.union([z.array(z.string()), z.null()]),
  reasoning: z.union([z.string(), z.null()]),
});

// Type inference from the Zod schema
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
export const rewrite = async (
  state: AgentState,
  env: Env,
): Promise<AgentState> => {
  const logger = getLogger().child({ node: 'rewrite' });
  const t0 = performance.now();

  /* --------------------------------------------------------------- */
  /*  1. Initialize observability                                    */
  /* --------------------------------------------------------------- */
  const userId = getUserId(state);
  const traceId = state.metadata?.traceId ?? ObservabilityService.initTrace(env, userId, state);
  const spanId = ObservabilityService.startSpan(env, traceId, 'rewrite', state);
  const logEvt = (e: string, p: Record<string, unknown>) => ObservabilityService.logEvent(env, traceId, spanId, e, p);

  const taskEntities = state.taskEntities || {};
  const taskCount = Object.keys(taskEntities).length;

  if (taskCount === 0) {
    logger.info('No tasks to rewrite');
    const elapsed = performance.now() - t0;
    
    ObservabilityService.endSpan(env, traceId, spanId, 'rewrite', state, state, elapsed);
    
    return {
      ...state,
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
    const processingPromises = Object.entries(taskEntities).map(async ([taskId, task]) => {
      // Skip tasks that already have a rewritten query
      if (task.rewrittenQuery) {
        logger.debug({ taskId }, 'Task already has a rewritten query, skipping');
        return {
          taskId,
          rewrittenQuery: task.rewrittenQuery,
          requiredTools: task.requiredTools,
          reasoning: 'Task already rewritten.'
        };
      }

      const originalQuery = task.originalQuery || '';
      if (!originalQuery) {
        logger.warn({ taskId }, 'Task has no original query to rewrite');
        return {
          taskId,
          rewrittenQuery: '',
          reasoning: 'No original query to rewrite.'
        };
      }

      // Create messages for the LLM call
      const messages: AIMessage[] = [
        { role: 'system', content: getCondenseTaskPrompt() },
        { role: 'user', content: originalQuery }
      ];

      // Get context from chat history if available
      if (state.chatHistory && state.chatHistory.length > 0) {
        // Get the last few messages for context, with a reasonable limit
        const recentHistory = state.chatHistory.slice(-3);
        const historyContext = recentHistory.map(pair => 
          `User: ${pair.user.content}\nAssistant: ${pair.assistant.content}`
        ).join('\n\n');
        
        messages.push({ 
          role: 'system', 
          content: `Recent conversation context:\n${historyContext}` 
        });
      }

      // Call LLM with structured output schema
      try {
        const result = await LlmService.invokeStructured<RewrittenTask>(
          env,
          messages,
          {
            schema: rewrittenTaskSchema,
            schemaInstructions: 'Rewrite the user query in a concise, clear format and identify required tools.'
          }
        );

        return {
          ...result,
          taskId // Ensure we use our taskId, not the LLM-generated one
        };
      } catch (error) {
        logger.error({ err: error, taskId }, 'Error rewriting task');
        // Return original query if rewriting fails
        return {
          taskId,
          rewrittenQuery: originalQuery,
          reasoning: `Error during rewriting: ${error instanceof Error ? error.message : 'Unknown error'}`
        };
      }
    });

    // Wait for all tasks to be processed
    const results = await Promise.all(processingPromises);

    /* --------------------------------------------------------------- */
    /*  3. Update task entities with rewritten queries                 */
    /* --------------------------------------------------------------- */
    const updatedTaskEntities = { ...taskEntities };
    const reasons: string[] = [];
    
    results.forEach(result => {
      if (!result.rewrittenQuery) return;
      
      const task = updatedTaskEntities[result.taskId];
      if (task) {
        updatedTaskEntities[result.taskId] = {
          ...task,
          rewrittenQuery: result.rewrittenQuery === null ? '' : result.rewrittenQuery,
          requiredTools: result.requiredTools === null ? (task.requiredTools || []) : result.requiredTools,
          definition: result.rewrittenQuery === null ? '' : result.rewrittenQuery // Set definition to the rewritten query
        };
        
        reasons.push(`Task ${result.taskId}: ${result.reasoning === null ? 'Task rewritten successfully.' : result.reasoning}`);
      }
    });

    /* --------------------------------------------------------------- */
    /*  4. Log completion and metrics                                  */
    /* --------------------------------------------------------------- */
    const elapsed = performance.now() - t0;
    logEvt('rewrite_complete', { 
      taskCount,
      processingTimeMs: elapsed,
      taskRewriteCount: results.length
    });
    
    ObservabilityService.endSpan(env, traceId, spanId, 'rewrite', state, state, elapsed);

    logger.info({
      taskCount,
      taskRewriteCount: results.length,
      elapsedMs: elapsed
    }, 'rewrite done');

    /* --------------------------------------------------------------- */
    /*  5. Return updated state                                        */
    /* --------------------------------------------------------------- */
    return {
      ...state,
      taskEntities: updatedTaskEntities,
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
    logger.error({ err: error }, 'Error in rewrite node');
    
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
      ...state,
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