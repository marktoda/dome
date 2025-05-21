import { getLogger } from '@dome/common';
import { LangGraphRunnableConfig } from '@langchain/langgraph';
import { buildMessages } from '../utils';
import { RETRIEVAL_TOOLS } from '../tools';
import { RetrievalToolType } from '../types';
import { AgentStateV3 as AgentState } from '../types/stateSlices';
import type { SliceUpdate } from '../types/stateSlices';
import { LlmService } from '../services/llmService';
import { ObservabilityService } from '../services/observabilityService';
import { toDomeError } from '@dome/common/errors';
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
export type RetrievalSelectorUpdate = SliceUpdate<'retrievals' | 'reasoning' | 'retrievalLoop'>;

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

  // Consolidated loop metadata (v3)
  // If not present, initialize a fresh object. We no longer rely on legacy
  // slices such as `selectorHistory` / `retrievalMeta` / `refinementPlan`.
  const loop = state.retrievalLoop ?? {
    attempt: 0, // will be incremented below so first run becomes 1
    issuedQueries: [],
    refinedQueries: [],
    seenChunkIds: [],
    lastEvaluation: undefined,
  };

  // Helper string builders -------------------------------------------------
  const refinedQueryHintsArr = (loop.refinedQueries || []).slice(-3);
  const refinedQueryHints = refinedQueryHintsArr
    .map((q: string, idx: number) => `  • Hint ${idx + 1}: ${q}`)
    .join('\n');

  // Summarise last evaluator feedback (if any)
  const evaluationFeedback = loop.lastEvaluation
    ? `\nPrevious evaluator feedback (score=${loop.lastEvaluation.overallScore}, adequate=${loop.lastEvaluation.isAdequate}): ${loop.lastEvaluation.reasoning}`
    : '';

  // List of recent queries that the selector should avoid repeating
  const recentQueriesList = (loop.issuedQueries || []).slice(-5);
  const avoidQueriesSection = recentQueriesList.length
    ? `\nDO NOT repeat any of these previous queries:\n${recentQueriesList.map(q => `  • ${q}`).join('\n')}`
    : '';

  // Construct failure stats paragraph – include categories with 2+ consecutive failures
  const failureEntries = Object.entries(loop.categoryFailures || {}).filter(([, n]) => n >= 2);
  const failureSection = failureEntries.length
    ? `\nThese categories have yielded poor results recently:\n${failureEntries
        .map(([cat, n]) => `  • ${cat}: ${n} failed attempts`)
        .join('\n')}\nConsider alternative sources.`
    : '';

  try {
    /* ------------------------------------------------------------------ */
    /*  LLM-based retrieval selection                                     */
    /* ------------------------------------------------------------------ */
    // Get system prompt from centralized config and append any refined query hints
    let systemPrompt =
      getRetrievalSelectionPrompt(availableRetrievalTypes) +
      failureSection +
      evaluationFeedback +
      (refinedQueryHints ? `\nPrevious refined query suggestions:\n${refinedQueryHints}` : '') +
      avoidQueriesSection;
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
      taskCount: result.tasks.length,
      categories: Array.from(new Set(result.tasks.map(t => t.category))),
      reasoningPreview: result.reasoning ? result.reasoning.substring(0, 120) : undefined,
    });

    /* ------------------------------------------------------------------ */
    /*  Finish, log, and return the state update                          */
    /* ------------------------------------------------------------------ */
    const elapsed = performance.now() - t0;
    ObservabilityService.endSpan(env, traceId, spanId, 'retrievalSelector', state, state, elapsed);

    // Remove any tasks whose query was already issued in earlier rounds
    const freshTasksPreDedup = result.tasks.filter(t =>
      !loop.issuedQueries.includes(t.query),
    );

    const uniqueMap = new Map();
    for (const task of freshTasksPreDedup) {
      uniqueMap.set(`${task.category}:${task.query}`, task);
    }
    const deduplicatedTasks = Array.from(uniqueMap.values());

    logger.info(
      {
        elapsedMs: elapsed,
        originalTaskCount: result.tasks.length,
        deduplicatedTaskCount: deduplicatedTasks.length,
        duplicatesRemoved: result.tasks.length - deduplicatedTasks.length,
      },
      'Retrieval selection complete (with deduplication)',
    );

    /* -------- Update retrievalLoop meta ------- */
    const issuedQueries = deduplicatedTasks.map(t => t.query);
    const updatedLoop = {
      ...loop,
      attempt: loop.attempt + 1,
      issuedQueries: Array.from(new Set([...(loop.issuedQueries ?? []), ...issuedQueries])),
      refinedQueries: [], // consumed after selector
    };

    return {
      retrievals: deduplicatedTasks,
      retrievalLoop: updatedLoop,
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
        iteration: updatedLoop.attempt,
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
