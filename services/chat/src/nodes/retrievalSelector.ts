import { getLogger } from '@dome/common';
import { LangGraphRunnableConfig } from '@langchain/langgraph';
import { buildMessages } from '../utils';
import { ContentCategory, ContentCategoryEnum } from '@dome/common';
import { RETRIEVAL_TOOLS } from '../tools';
import { RetrievalToolType, Message } from '../types';
import { AgentStateV3 as AgentState } from '../types/stateSlices';
import type { SliceUpdate } from '../types/stateSlices';
import { LlmService } from '../services/llmService';
import { ObservabilityService } from '../services/observabilityService';
import { toDomeError } from '../utils/errors';
import { z } from 'zod';
import { getRetrievalSelectionPrompt } from '../config/promptsConfig';

/**
 * Zod schema for task extraction
 * Used for structured output from LLM
 */
const retrievalTasksSchema = z.object({
  tasks: z.array(
    z.object({
      category: z.nativeEnum(RetrievalToolType),
      query: z.string(),
    }),
  ),
  reasoning: z.string().nullable(),
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
export type RetrievalSelectorUpdate = SliceUpdate<'retrievals' | 'reasoning' | 'selectorHistory' | 'refinementPlan'>;

export async function retrievalSelector(
  state: AgentState,
  cfg: LangGraphRunnableConfig,
  env: Env,
): Promise<RetrievalSelectorUpdate> {
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

  logger.info(
    {
      lastUserMsg,
    },
    'Starting retrieval selection process',
  );

  /* ------------------------------------------------------------------ */
  /*  Trace / logging setup                                             */
  /* ------------------------------------------------------------------ */
  const traceId = state.metadata?.traceId ?? crypto.randomUUID();
  const spanId = ObservabilityService.startSpan(env, traceId, 'retrievalSelector', state);
  const logEvt = (e: string, p: Record<string, unknown>) =>
    ObservabilityService.logEvent(env, traceId, spanId, e, p);

  let availableRetrievalTypes = '';
  for (const tool of Object.values(RETRIEVAL_TOOLS)) {
    availableRetrievalTypes += `
    ${tool.name}: ${tool.description}
  `;
  }

  // If we have refined queries from previous iteration, surface them as hints
  const refinedQueryHintsArr = (state.refinementPlan?.refinedQueries || []).slice(-3);
  const refinedQueryHints = refinedQueryHintsArr
    .map((q: string, idx: number) => `  • Hint ${idx + 1}: ${q}`)
    .join('\n');

  try {
    /* ------------------------------------------------------------------ */
    /*  LLM-based retrieval selection                                     */
    /* ------------------------------------------------------------------ */
    // Get system prompt from centralized config and append any refined query hints
    let systemPrompt = getRetrievalSelectionPrompt(availableRetrievalTypes);
    if (refinedQueryHints) {
      systemPrompt += `\nPrevious refined query suggestions:\n${refinedQueryHints}`;
    }
    logger.debug(
      { promptLength: systemPrompt.length },
      'System prompt for retrieval selection (length only)',
    );

    // Call LLM to decide which retrievers are appropriate for this task
    const messages = buildMessages(systemPrompt, state.chatHistory, lastUserMsg.content);

    // Get structured output from LLM
    const result = await LlmService.invokeStructured<RetrievalTasks>(env, messages, {
      temperature: 0.7,
      schema: retrievalTasksSchema,
      schemaInstructions: 'Return a JSON object selected retrievals',
      task: 'tool_router',
    });

    // Log the selection that was made
    logEvt('retrieval_selection', {
      retrievalTasks: result.tasks,
      reasoning: result.reasoning,
    });

    /* ------------------------------------------------------------------ */
    /*  Finish, log, and return the state update                          */
    /* ------------------------------------------------------------------ */
    const elapsed = performance.now() - t0;
    ObservabilityService.endSpan(env, traceId, spanId, 'retrievalSelector', state, state, elapsed);

    // Deduplicate tasks by category and query
    const uniqueTasks = new Map();
    for (const task of result.tasks) {
      const key = `${task.category}:${task.query}`;
      uniqueTasks.set(key, task);
    }

    const deduplicatedTasks = Array.from(uniqueTasks.values());
    logger.info(
      {
        elapsedMs: elapsed,
        originalTaskCount: result.tasks.length,
        deduplicatedTaskCount: deduplicatedTasks.length,
        duplicatesRemoved: result.tasks.length - deduplicatedTasks.length,
      },
      'Retrieval selection complete (with deduplication)',
    );

    /* -------- Update selectorHistory & consume refinementPlan ------- */
    const prevHistory = (state as any).selectorHistory ?? {
      attempt: 1,
      issuedQueries: [],
      seenChunkIds: [],
    };

    const plan = (state as any).refinementPlan ?? { refinedQueries: [] };

    const issuedQueries = deduplicatedTasks.map(t => t.query);
    const updatedHistory = {
      ...prevHistory,
      attempt: prevHistory.attempt + 1,
      issuedQueries: Array.from(new Set([...prevHistory.issuedQueries, ...issuedQueries])),
    };

    const clearedPlan = { ...plan, refinedQueries: [] };

    return {
      retrievals: deduplicatedTasks,
      selectorHistory: updatedHistory,
      refinementPlan: clearedPlan,
      reasoning: [
        ...(state.reasoning || []),
        result.reasoning || 'Selected appropriate retrieval sources based on the task.',
      ],
      metadata: {
        currentNode: 'retrievalSelector',
        executionTimeMs: elapsed,
        nodeTimings: {
          ...state.metadata?.nodeTimings,
          retrievalSelector: elapsed,
        },
      },
    };
  } catch (error) {
    // Handle errors
    const domeError = toDomeError(error);
    logger.error({ err: domeError }, 'Error in retrievalSelector node');

    // Format error with required properties
    const formattedError = {
      node: 'retrievalSelector',
      message: domeError.message || 'Error in retrievalSelector node',
      timestamp: Date.now(),
    };

    const elapsed = performance.now() - t0;
    ObservabilityService.endSpan(
      env,
      traceId,
      spanId,
      'retrievalSelector',
      state,
      { ...state, metadata: { ...state.metadata, errors: [formattedError] } },
      elapsed,
    );

    return {
      metadata: {
        currentNode: 'retrievalSelector',
        executionTimeMs: elapsed,
        errors: [formattedError],
        nodeTimings: {
          ...state.metadata?.nodeTimings,
          retrievalSelector: elapsed,
        },
      },
    };
  }
}
