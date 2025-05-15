import { getLogger } from '@dome/common';
import type { SliceUpdate } from '../types/stateSlices';
import { NodeError, toDomeError } from '../utils/errors';
import { z } from 'zod';
import { AgentStateV3 as AgentState } from '../types/stateSlices';
import { getUserId } from '../utils/stateUtils';
import { LlmService } from '../services/llmService';
import { ObservabilityService } from '../services/observabilityService';
import { getUpdateChatPrompt } from '../config/promptsConfig';
import type { AIMessage } from '../types';

/**
 * Zod schema for system prompt update
 * Used for structured output from LLM
 */
const promptUpdateSchema = z.object({
  updatedInstructions: z.string().nullable(),
  reasoning: z.string().nullable(),
  activatedTools: z.array(z.string()).nullable(),
});

// Type inference from the Zod schema
type PromptUpdateResult = z.infer<typeof promptUpdateSchema>;

/**
 * Node: edit_system_prompt
 * ------------------------------------------------------------------
 * 1. Use UPDATE_PROMPT to modify instructions and activated tools
 * 2. Return state with updated instructions and reasoning
 *
 * This node enhances the system prompt based on the current conversation
 * context and any task-specific requirements identified.
 */
export type EditSystemPromptUpdate = SliceUpdate<'instructions' | 'reasoning' | 'toolRequirements'>;

export const editSystemPrompt = async (
  state: AgentState,
  env: Env,
): Promise<EditSystemPromptUpdate> => {
  const logger = getLogger().child({ node: 'editSystemPrompt' });
  const t0 = performance.now();

  /* --------------------------------------------------------------- */
  /*  1. Initialize observability                                    */
  /* --------------------------------------------------------------- */
  const userId = getUserId(state);
  const traceId = state.metadata?.traceId ?? ObservabilityService.initTrace(env, userId, state);
  const spanId = ObservabilityService.startSpan(env, traceId, 'editSystemPrompt', state);
  const logEvt = (e: string, p: Record<string, unknown>) =>
    ObservabilityService.logEvent(env, traceId, spanId, e, p);

  logEvt('edit_system_prompt_start', {
    currentInstructions: state.instructions || 'no instructions',
    taskEntitiesCount: Object.keys(state.taskEntities || {}).length,
  });

  try {
    /* --------------------------------------------------------------- */
    /*  2. Extract information about tasks and tools                   */
    /* --------------------------------------------------------------- */
    const tasks = Object.values(state.taskEntities || {});
    const requiredTools = new Set<string>();

    // Collect all required tools from tasks
    tasks.forEach(task => {
      if (task.requiredTools) {
        task.requiredTools.forEach(tool => requiredTools.add(tool));
      }
    });

    const toolsArray = Array.from(requiredTools);
    const taskDefinitions = tasks
      .map(task => task.definition || task.originalQuery)
      .filter(Boolean);

    /* --------------------------------------------------------------- */
    /*  3. Use LLM to update system prompt                             */
    /* --------------------------------------------------------------- */
    // Create messages for the LLM
    const messages: AIMessage[] = [
      { role: 'system', content: getUpdateChatPrompt() },
      {
        role: 'user',
        content: JSON.stringify({
          currentInstructions: state.instructions || '',
          tasks: taskDefinitions,
          tools: toolsArray,
        }),
      },
    ];

    // Schema is already defined with zod above

    // Call LLM with structured output schema
    const result = await LlmService.invokeStructured<PromptUpdateResult>(env, messages, {
      schema: promptUpdateSchema,
      schemaInstructions: 'Update the system instructions based on the tasks and available tools.',
    });

    /* --------------------------------------------------------------- */
    /*  4. Log completion and metrics                                  */
    /* --------------------------------------------------------------- */
    const elapsed = performance.now() - t0;
    logEvt('edit_system_prompt_complete', {
      updatedInstructions: result.updatedInstructions,
      activatedToolsCount: result.activatedTools?.length || 0,
      reasoning: result.reasoning,
      elapsedMs: elapsed,
    });

    ObservabilityService.endSpan(env, traceId, spanId, 'editSystemPrompt', state, state, elapsed);

    logger.info(
      {
        toolsCount: result.activatedTools?.length || 0,
        elapsedMs: elapsed,
      },
      'editSystemPrompt done',
    );

    /* --------------------------------------------------------------- */
    /*  5. Return updated slices                                       */
    /* --------------------------------------------------------------- */
    return {
      instructions: result.updatedInstructions === null ? '' : result.updatedInstructions || '',
      reasoning: [
        ...(state.reasoning || []),
        result.reasoning === null
          ? 'System prompt updated.'
          : result.reasoning || 'System prompt updated.',
      ],
      // Store required tools in toolRequirements slice
      toolRequirements: {
        ...(state.toolRequirements || {}),
        requiredTools: result.activatedTools === null ? toolsArray : result.activatedTools,
      },
      metadata: {
        ...state.metadata,
        traceId,
        spanId,
        currentNode: 'edit_system_prompt',
        nodeTimings: {
          ...state.metadata?.nodeTimings,
          editSystemPrompt: elapsed,
        },
      },
    };
  } catch (error) {
    const domeError = toDomeError(
      error instanceof Error
        ? error
        : new NodeError('Error in editSystemPrompt', {
            node: 'editSystemPrompt',
          }),
    );

    logger.error({ error: domeError }, 'Error in editSystemPrompt');

    // Handle error case
    const errorMsg = domeError.message;
    const elapsed = performance.now() - t0;

    // Add error to metadata before ending span
    const stateWithError = {
      ...state,
      metadata: {
        ...state.metadata,
        errors: [
          ...(state.metadata?.errors || []),
          {
            node: 'editSystemPrompt',
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
      'editSystemPrompt',
      state,
      stateWithError,
      elapsed,
    );

    return {
      reasoning: [...(state.reasoning || []), `Error updating system prompt: ${errorMsg}`],
      metadata: {
        ...state.metadata,
        traceId,
        spanId,
        currentNode: 'edit_system_prompt',
        nodeTimings: {
          ...state.metadata?.nodeTimings,
          editSystemPrompt: elapsed,
        },
        errors: [
          ...(state.metadata?.errors || []),
          {
            node: 'editSystemPrompt',
            message: errorMsg,
            timestamp: Date.now(),
          },
        ],
      },
    };
  }
};
