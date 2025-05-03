import { getLogger } from '@dome/logging';
import { LangGraphRunnableConfig } from "@langchain/langgraph";
import { ContentCategory, ContentCategoryEnum } from '@dome/common';
import { RETRIEVAL_TOOLS } from '../tools';
import { RetrievalToolType, AgentState, Message } from '../types';
import { LlmService, } from '../services/llmService';
import { ObservabilityService } from '../services/observabilityService';
import { toDomeError } from '../utils/errors';
import { z } from 'zod';
import { getRetrievalSelectionPrompt } from '../config/promptsConfig';

/**
 * Zod schema for task extraction
 * Used for structured output from LLM
 */
const retrievalTasksSchema = z.object({
  tasks: z.array(z.object({
    category: z.nativeEnum(RetrievalToolType),
    query: z.string(),
  })),
  reasoning: z.string(),
});

// Type inference from the Zod schema
type RetrievalTasks = z.infer<typeof retrievalTasksSchema>;

/**
 * Retrieval Selector Node
 *
 * Dynamically selects appropriate retrieval types.
 * Uses LLM-based classification to determine which sources (code, notes, docs)
 * should be queried for each task.
 *
 * @param state Current agent state
 * @param cfg LangGraph runnable configuration
 * @param env Environment variables
 * @returns Updated agent state with retrieval selections
 */
export async function retrievalSelector(
  state: AgentState,
  cfg: LangGraphRunnableConfig,
  env: Env,
): Promise<Partial<AgentState>> {
  const t0 = performance.now();
  const logger = getLogger().child({ component: 'retrievalSelector' });
  const lastUserMsg = [...state.messages].reverse().find(m => m.role === 'user');
  if (!lastUserMsg) {
    logger.warn('No user message found');
    return {
      ...state,
      reasoning: [...(state.reasoning || []), 'No user message found to process.'],
    };
  }


  logger.info({
    lastUserMsg,
  }, "Starting retrieval selection process");

  /* ------------------------------------------------------------------ */
  /*  Trace / logging setup                                             */
  /* ------------------------------------------------------------------ */
  const traceId = state.metadata?.traceId ?? crypto.randomUUID();
  const spanId = ObservabilityService.startSpan(env, traceId, "retrievalSelector", state);
  const logEvt = (e: string, p: Record<string, unknown>) =>
    ObservabilityService.logEvent(env, traceId, spanId, e, p);

  let availableRetrievalTypes = '';
  for (const tool of Object.values(RETRIEVAL_TOOLS)) {
    availableRetrievalTypes += `
    ${tool.name}: ${tool.description}
  `;
  }

  try {
    /* ------------------------------------------------------------------ */
    /*  LLM-based retrieval selection                                     */
    /* ------------------------------------------------------------------ */
    // Get system prompt from centralized config
    const systemPrompt = getRetrievalSelectionPrompt(availableRetrievalTypes);
    logger.info({ systemPrompt }, "System prompt for retrieval selection");

    // Call LLM to decide which retrievers are appropriate for this task
    const messages: Message[] = [
      { role: 'system', content: systemPrompt },
      lastUserMsg,
    ];

    // Get structured output from LLM
    const result = await LlmService.invokeStructured<RetrievalTasks>(
      env,
      messages,
      {
        temperature: 0.7,
        schema: retrievalTasksSchema,
        schemaInstructions: 'Return a JSON object selected retrievals',
      }
    );

    // Log the selection that was made
    logEvt("retrieval_selection", {
      retrievalTasks: result.tasks,
      reasoning: result.reasoning
    });

    /* ------------------------------------------------------------------ */
    /*  Finish, log, and return the state update                          */
    /* ------------------------------------------------------------------ */
    const elapsed = performance.now() - t0;
    ObservabilityService.endSpan(env, traceId, spanId, "retrievalSelector", state, state, elapsed);

    // Deduplicate tasks by category and query
    const uniqueTasks = new Map();
    for (const task of result.tasks) {
      const key = `${task.category}:${task.query}`;
      uniqueTasks.set(key, task);
    }

    const deduplicatedTasks = Array.from(uniqueTasks.values());
    logger.info({
      elapsedMs: elapsed,
      originalTaskCount: result.tasks.length,
      deduplicatedTaskCount: deduplicatedTasks.length,
      duplicatesRemoved: result.tasks.length - deduplicatedTasks.length
    }, "Retrieval selection complete (with deduplication)");

    return {
      retrievals: deduplicatedTasks,
      reasoning: [...(state.reasoning || []), result.reasoning],
      metadata: {
        currentNode: "retrievalSelector",
        executionTimeMs: elapsed,
        nodeTimings: {
          ...state.metadata?.nodeTimings,
          retrievalSelector: elapsed
        }
      }
    };
  } catch (error) {
    // Handle errors
    const domeError = toDomeError(error);
    logger.error({ err: domeError }, "Error in retrievalSelector node");

    // Format error with required properties
    const formattedError = {
      node: "retrievalSelector",
      message: domeError.message || "Error in retrievalSelector node",
      timestamp: Date.now()
    };

    const elapsed = performance.now() - t0;
    ObservabilityService.endSpan(env, traceId, spanId, "retrievalSelector", state,
      { ...state, metadata: { ...state.metadata, errors: [formattedError] } },
      elapsed
    );

    return {
      metadata: {
        currentNode: "retrievalSelector",
        executionTimeMs: elapsed,
        errors: [formattedError],
        nodeTimings: {
          ...state.metadata?.nodeTimings,
          retrievalSelector: elapsed
        }
      }
    };
  }
}
