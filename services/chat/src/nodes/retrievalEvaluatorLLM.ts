import { getLogger } from '@dome/common';
import { LangGraphRunnableConfig } from '@langchain/langgraph';
import { DocumentChunk, RetrievalEvaluation, RetrievalTask } from '../types';
import { AgentStateV3 as AgentState } from '../types/stateSlices';
import { ObservabilityService } from '../services/observabilityService';
import { LlmService } from '../services/llmService';
import { toDomeError } from '@dome/common/errors';
import { getRetrievalEvaluationPrompt } from '../config/promptsConfig';
import type { SliceUpdate } from '../types/stateSlices';
import { z } from 'zod';
import { countTokens, calculateContextLimits } from '@dome/common';
import { chooseModel } from '@dome/common';

/**
 * Retrieval Evaluator LLM Node
 *
 * Evaluates the relevance and sufficiency of retrieved content post-reranking.
 * This node analyzes all retrievals to determine if the retrieved content
 * is adequate for answering the user's query without external tools.
 *
 * The node:
 * 1. Takes retrievals from state (already processed by the reranker)
 * 2. Uses an LLM to assess content relevance and adequacy
 * 3. Produces a structured evaluation with a binary adequacy decision
 * 4. Updates agent state with the evaluation results
 *
 * This evaluation is critical for determining whether to proceed with answering
 * the query using retrieved content or to invoke external tools.
 *
 * @param state Current agent state
 * @param cfg LangGraph runnable configuration
 * @param env Environment bindings
 * @returns Updated agent state with retrieval evaluation results
 */
export type RetrievalEvalUpdate = SliceUpdate<
  'retrievalEvaluation' | 'toolNecessityClassification' | 'retrievalLoop'
>;

// Structured output schema – keeps evaluator responses machine-readable
// Note: `response_format: 'json_object' | 'extract'` accepts a limited JSON schema subset.
//       Remove validation keywords like `minimum`, `maximum`, `maxLength` which are disallowed.
//       We still document expectations via descriptions for future reference.
const retrievalEvalSchema = z.object({
  /* Overall score from 0 to 10 */
  overallScore: z.number().describe('Overall score from 0 (poor) to 10 (excellent)'),
  isAdequate: z.boolean(),
  suggestedAction: z.enum(['use_tools', 'refine_query', 'proceed']),
  /* Reasoning capped in prompt; server side we will truncate if needed */
  reasoning: z.string().describe('Short reasoning sentence (max ~300 chars)'),
});
type RetrievalEvalLLM = z.infer<typeof retrievalEvalSchema>;

export async function retrievalEvaluatorLLM(
  state: AgentState,
  cfg: LangGraphRunnableConfig,
  env: Env,
): Promise<RetrievalEvalUpdate> {
  const t0 = performance.now();
  const logger = getLogger().child({ component: 'retrievalEvaluatorLLM' });

  // Access retrievals from state with type assertion
  const retrievals = (state as any).retrievals || [];

  // Skip if no retrievals available
  if (!Array.isArray(retrievals) || retrievals.length === 0) {
    logger.info('No retrieval tasks found to evaluate');
    return {
      retrievalEvaluation: {
        overallScore: 0.5,
        isAdequate: false,
        reasoning: '',
        suggestedAction: 'use_tools',
      },
      toolNecessityClassification: {
        isToolNeeded: true,
        reasoning: 'No retrievals available',
        confidence: 1,
      },
      retrievalLoop: {
        attempt: 1,
        issuedQueries: [],
        refinedQueries: [],
        seenChunkIds: [],
      },
      metadata: {
        currentNode: 'retrievalEvaluatorLLM',
        executionTimeMs: 0,
        nodeTimings: {
          ...state.metadata?.nodeTimings,
          retrievalEvaluatorLLM: 0,
        },
      },
    };
  }

  // Filter for retrieval tasks that have chunks (these are the reranked ones)
  const retrievalTasks = retrievals.filter(task => task.chunks && task.chunks.length > 0);

  if (retrievalTasks.length === 0) {
    logger.info('No retrieval tasks with chunks found');
    return {
      retrievalEvaluation: {
        overallScore: 0.5,
        isAdequate: false,
        reasoning: '',
        suggestedAction: 'use_tools',
      },
      toolNecessityClassification: {
        isToolNeeded: true,
        reasoning: 'No retrieval tasks with chunks found',
        confidence: 1,
      },
      retrievalLoop: {
        attempt: 1,
        issuedQueries: [],
        refinedQueries: [],
        seenChunkIds: [],
      },
      metadata: {
        currentNode: 'retrievalEvaluatorLLM',
        executionTimeMs: 0,
        nodeTimings: {
          ...state.metadata?.nodeTimings,
          retrievalEvaluatorLLM: 0,
        },
      },
    };
  }

  // Extract last user message to use as query
  const lastUserMessage = [...(state.messages || [])].reverse().find(msg => msg.role === 'user');
  if (!lastUserMessage) {
    logger.warn('No user message found for evaluation context');
    return {
      retrievalEvaluation: {
        overallScore: 0.5,
        isAdequate: false,
        reasoning: '',
        suggestedAction: 'use_tools',
      },
      toolNecessityClassification: {
        isToolNeeded: true,
        reasoning: 'No user message found for evaluation context',
        confidence: 1,
      },
      retrievalLoop: {
        attempt: 1,
        issuedQueries: [],
        refinedQueries: [],
        seenChunkIds: [],
      },
      metadata: {
        currentNode: 'retrievalEvaluatorLLM',
        executionTimeMs: 0,
        nodeTimings: {
          ...state.metadata?.nodeTimings,
          retrievalEvaluatorLLM: 0,
        },
      },
    };
  }

  const query = lastUserMessage.content;

  /* ------------------------------------------------------------------ */
  /*  Trace / logging setup                                             */
  /* ------------------------------------------------------------------ */
  const traceId = state.metadata?.traceId ?? crypto.randomUUID();
  const spanId = ObservabilityService.startSpan(env, traceId, 'retrievalEvaluatorLLM', state);

  try {
    logger.info(
      {
        query,
        taskCount: retrievalTasks.length,
        totalChunks: retrievalTasks.reduce((sum, task) => sum + (task.chunks?.length || 0), 0),
        categories: retrievalTasks.map(task => task.category),
      },
      'Starting retrieval evaluation',
    );

    /* --------------------------------------------------------------- */
    /*  2b. Enforce context budget for docs                             */
    /* --------------------------------------------------------------- */
    // Determine the document token budget based on model limits
    const modelConfig = chooseModel({ task: 'retrieval_eval' });
    const limits = calculateContextLimits(modelConfig);
    const docBudget = limits.maxDocumentsTokens ?? Math.floor(limits.maxContextTokens * 0.4);

    let runningDocTokens = 0;
    const docSections: string[] = [];

    for (const task of retrievalTasks) {
      const sourceType = task.sourceType || task.category;
      for (const chunk of task.chunks || []) {
        const chunkText = `[${sourceType.toUpperCase()} CHUNK]\n${chunk.content}\n`;
        const tokenCount = countTokens(chunkText);
        if (runningDocTokens + tokenCount > docBudget) {
          break;
        }
        docSections.push(chunkText);
        runningDocTokens += tokenCount;
      }
      if (runningDocTokens >= docBudget) break;
    }

    const contentToEvaluate = docSections
      .map((txt, idx) => `CHUNK ${idx + 1}:\n${txt}`)
      .join('\n\n');

    // Build evaluation prompt using the centralized config
    const systemPrompt = getRetrievalEvaluationPrompt(query, contentToEvaluate);

    // Call LLM with structured JSON output enforced by schema
    const evalStructured = await LlmService.invokeStructured<RetrievalEvalLLM>(
      env,
      [{ role: 'system', content: systemPrompt }],
      {
        temperature: 0.2,
        schema: retrievalEvalSchema,
        schemaInstructions: 'Respond ONLY with valid JSON matching the schema.',
        task: 'retrieval_eval',
      },
    );

    const overallScore = Math.min(1, Math.max(0, evalStructured.overallScore / 10));
    const isAdequate = evalStructured.isAdequate;
    const suggestedAction = evalStructured.suggestedAction;

    // Structure the evaluation based on the RetrievalEvaluation interface
    const retrievalEvaluation: RetrievalEvaluation = {
      overallScore,
      isAdequate,
      reasoning: evalStructured.reasoning,
      suggestedAction: suggestedAction as 'use_tools' | 'refine_query' | 'proceed',
    };

    // Derive a simple tool-necessity classification (will replace separate node)
    const toolNecessityClassification: import('../types').ToolNecessityClassification = {
      isToolNeeded: suggestedAction === 'use_tools' || !isAdequate,
      reasoning: `Decision derived from retrievalEvaluatorLLM – suggestedAction="${suggestedAction}" and adequacy=${isAdequate}.`,
      confidence: Math.round((1 - overallScore) * 100) / 100, // rough heuristic
    };

    // Log results
    logger.info(
      {
        overallScore,
        isAdequate,
        suggestedAction,
      },
      'Retrieval evaluation complete',
    );

    // Calculate execution time
    const elapsed = performance.now() - t0;

    // Record LLM call in observability
    ObservabilityService.logLlmCall(
      env,
      traceId,
      spanId,
      'gpt-4', // Assuming model here, ideally would come from config
      [{ role: 'system', content: systemPrompt }],
      evalStructured.reasoning,
      elapsed,
      { prompt: systemPrompt.length / 4, completion: evalStructured.reasoning.length / 4 }, // Rough token estimate
    );

    // Persist evaluation result into the consolidated retrievalLoop slice
    const loopPrev = state.retrievalLoop ?? {
      attempt: 1,
      issuedQueries: [],
      refinedQueries: [],
      seenChunkIds: [],
      lastEvaluation: undefined,
    };

    // update failure counters per category when evaluation is not adequate
    const failuresPrev = loopPrev.categoryFailures ?? {};
    const newFailures: Record<string, number> = { ...failuresPrev };
    for (const cat of Array.from(new Set(retrievalTasks.map(t => t.category)))) {
      if (!isAdequate) {
        newFailures[cat] = (newFailures[cat] ?? 0) + 1;
      } else {
        newFailures[cat] = 0; // reset successes
      }
    }

    const updatedLoop = {
      ...loopPrev,
      lastEvaluation: retrievalEvaluation,
      categoryFailures: newFailures,
    };

    // End span with updated state
    const updatedState = {
      ...state,
      retrievalEvaluation,
      toolNecessityClassification,
      retrievalLoop: updatedLoop,
      metadata: {
        currentNode: 'retrievalEvaluatorLLM',
        executionTimeMs: elapsed,
        nodeTimings: {
          ...state.metadata?.nodeTimings,
          retrievalEvaluatorLLM: elapsed,
        },
      },
    };

    ObservabilityService.endSpan(
      env,
      traceId,
      spanId,
      'retrievalEvaluatorLLM',
      state,
      updatedState as any,
      elapsed,
    );

    // Update state with evaluation results
    return {
      retrievalEvaluation,
      toolNecessityClassification,
      retrievalLoop: updatedLoop,
      metadata: {
        currentNode: 'retrievalEvaluatorLLM',
        executionTimeMs: elapsed,
        nodeTimings: {
          ...state.metadata?.nodeTimings,
          retrievalEvaluatorLLM: elapsed,
        },
      },
    };
  } catch (error) {
    // Handle errors
    const domeError = toDomeError(error);
    logger.error({ err: domeError }, 'Error in retrieval evaluator');

    // Format error
    const formattedError = {
      node: 'retrievalEvaluatorLLM',
      message: domeError.message,
      timestamp: Date.now(),
    };

    const elapsed = performance.now() - t0;
    ObservabilityService.endSpan(
      env,
      traceId,
      spanId,
      'retrievalEvaluatorLLM',
      state,
      {
        ...state,
        metadata: {
          ...state.metadata,
          errors: [...(state.metadata?.errors || []), formattedError],
        },
      },
      elapsed,
    );

    return {
      retrievalEvaluation: {
        overallScore: 0.5,
        isAdequate: false,
        reasoning: '',
        suggestedAction: 'use_tools',
      },
      toolNecessityClassification: {
        isToolNeeded: true,
        reasoning: domeError.message,
        confidence: 1,
      },
      retrievalLoop: {
        attempt: state.retrievalLoop?.attempt ?? 1,
        issuedQueries: state.retrievalLoop?.issuedQueries ?? [],
        refinedQueries: [],
        seenChunkIds: state.retrievalLoop?.seenChunkIds ?? [],
      },
      metadata: {
        currentNode: 'retrievalEvaluatorLLM',
        executionTimeMs: elapsed,
        errors: [...(state.metadata?.errors || []), formattedError],
        nodeTimings: {
          ...state.metadata?.nodeTimings,
          retrievalEvaluatorLLM: elapsed,
        },
      },
    };
  }
}
