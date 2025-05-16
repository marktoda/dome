import { getLogger, logError } from '@dome/common';
import { z } from 'zod';
import { AgentStateV3 as AgentState, SliceUpdate } from '../types/stateSlices';
import { ObservabilityService } from '../services/observabilityService';
import { LlmService } from '../services/llmService';

export type ImproveRetrievalUpdate = SliceUpdate<'retrievalLoop' | 'reasoning' | 'metadata'>;

// -----------------------------
// 1. Schema & prompt pieces
// -----------------------------
// OpenAI `response_format` only supports a subset of JSON Schema.
//    • No `nullable`, `not`, or other advanced keywords
//    • Descriptive metadata must be omitted
// Keep the schema minimal and validate elaborately on the server side instead.
const refinementSchema = z.object({
  refinedQueries: z.array(z.string()),
  reasoning: z.string(),
  broadenScope: z.boolean().nullable(),
  excludedSources: z.array(z.string()).nullable(),
});
// Type output
type Refinement = z.infer<typeof refinementSchema>;

/**
 * improve_retrieval
 * ------------------
 * Very lightweight first version that only increments an iteration counter and
 * records an explanatory note so that downstream nodes (retrieval_selector)
 * can try a fresh strategy.  In future this node can:
 *  • inject hints into the query
 *  • alter retrieval parameters (e.g. expand synonyms)
 *  • downgrade thresholds, etc.
 */
export const improveRetrieval = async (
  state: AgentState,
  env: Env,
): Promise<ImproveRetrievalUpdate> => {
  const log = getLogger().child({ node: 'improveRetrieval' });
  const t0 = performance.now();

  /* ------------------------------------------------------------------ */
  /*  Retrieve and increment loop meta                                   */
  /* ------------------------------------------------------------------ */
  const loopPrev = state.retrievalLoop ?? {
    attempt: 1,
    issuedQueries: [],
    refinedQueries: [],
    seenChunkIds: [],
    lastEvaluation: undefined,
  };

  const attempt = loopPrev.attempt;

  /* ------------------------------------------------------------------ */
  /*  Build context for the LLM                                          */
  /* ------------------------------------------------------------------ */
  const question = state.messages[state.messages.length - 1]?.content ?? '';
  const evaluation = loopPrev.lastEvaluation;

  if (!evaluation) {
    // No evaluation available – likely the first pass. Propagate loop without changes.
    return {
      retrievalLoop: { ...loopPrev },
      reasoning: [
        ...(state.reasoning ?? []),
        'No retrieval evaluation available in state; proceeding without refinement.',
      ],
      metadata: {
        ...state.metadata,
        currentNode: 'improve_retrieval',
      },
    };
  }

  /* ----------------  Prompt ----------------------------------------- */
  const prevQueriesList = loopPrev.issuedQueries
    .map((q: string, i: number) => `  • ${i + 1}. "${q}"`)
    .join('\n');
  const systemPrompt =
    `You are an expert information-retrieval strategist.\n\n` +
    `Question: ${question}\n` +
    `Attempt #: ${attempt}\n` +
    `Previous queries:\n${prevQueriesList || '  • (none)'}\n\n` +
    `Evaluator feedback: "${evaluation.reasoning}" (adequate=${evaluation.isAdequate}, score=${evaluation.overallScore})\n\n` +
    `Task: Propose up to three improved search queries or directives that will likely surface NEW and MORE relevant information. ` +
    `Avoid repeating identical chunks already seen. Return JSON matching the schema.`;

  const messages = [{ role: 'system' as const, content: systemPrompt }];

  /* ------------------------------------------------------------------ */
  /*  Invoke LLM                                                         */
  /* ------------------------------------------------------------------ */
  let refinement: Refinement;
  try {
    refinement = await LlmService.invokeStructured<Refinement>(env, messages, {
      temperature: 0.4,
      schema: refinementSchema,
      schemaInstructions: 'Respond ONLY with valid JSON matching the schema.',
      task: 'generation',
    });
  } catch (err) {
    // Fallback: simple heuristic – reuse question with "explain in depth"
    logError(err, 'Refinement LLM failed; using heuristic');
    refinement = {
      refinedQueries: [question + ' in more detail'],
      broadenScope: true,
      excludedSources: null,
      reasoning: 'Heuristic fallback – broadened query.',
    };
  }

  /* ------------------------------------------------------------------ */
  /*  Assemble updated meta & state                                      */
  /* ------------------------------------------------------------------ */
  const updatedLoop = {
    ...loopPrev,
    refinedQueries: refinement.refinedQueries,
    lastEvaluation: undefined,
  };

  /* Observability */
  const traceId = state.metadata?.traceId ?? crypto.randomUUID();
  const spanId = ObservabilityService.startSpan(env, traceId, 'improveRetrieval', state);
  ObservabilityService.logEvent(env, traceId, spanId, 'retrieval_refinement', {
    attempt,
    refinedQueries: refinement.refinedQueries,
    broadenScope: refinement.broadenScope,
  });
  const elapsed = performance.now() - t0;
  try {
    ObservabilityService.endSpan(env, traceId, spanId, 'improveRetrieval', state, state, elapsed);
  } catch (e) {
    logError(e, 'Failed to end observability span in improveRetrieval');
  }

  return {
    retrievalLoop: updatedLoop,
    reasoning: [...(state.reasoning ?? []), refinement.reasoning],
    metadata: {
      ...state.metadata,
      nodeTimings: { ...state.metadata?.nodeTimings, improveRetrieval: elapsed },
      currentNode: 'improve_retrieval',
    },
  };
};
