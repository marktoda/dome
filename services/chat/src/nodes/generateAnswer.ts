import { getLogger, logError } from '@dome/logging';
import { LangGraphRunnableConfig } from "@langchain/langgraph";
import { AgentState, ToolResult, Document } from '../types';
import { countTokens } from '../utils/tokenCounter';
import { formatDocsForPrompt } from '../utils/promptFormatter';
import { LlmService } from '../services/llmService';
import { ObservabilityService } from '../services/observabilityService';
import { ModelFactory } from '../services/modelFactory';
import { getModelConfig, calculateTokenLimits } from '../config/modelConfig';
import { reduceRagContext } from '../utils/ragUtils';
import { transformToSSE } from '../utils/sseTransformer';
import { getRagAnswerPrompt } from '../config/promptsConfig';

/**
 * RAG Answer Generation Node
 *
 * Implements streaming answer generation with document sources and tool outputs.
 * Uses context reduction to fit within token limits while prioritizing the most
 * relevant information.
 *
 * @param state Current agent state
 * @param cfg LangGraph runnable configuration
 * @param env Environment variables
 * @returns Updated agent state with generated answer
 */
export async function generateAnswer(
  state: AgentState,
  cfg: LangGraphRunnableConfig,
  env: Env,
): Promise<Partial<AgentState>> {
  const t0 = performance.now();
  const logger = getLogger().child({ component: 'generateRAG' });
  // Get all tool results from all task entities
  const allToolResults = Object.values(state.taskEntities || {}).flatMap(task => task.toolResults || []);
  logger.info({ messageCount: state.messages.length, hasTools: !!allToolResults.length }, "Starting RAG answer generation");

  /* ------------------------------------------------------------------ */
  /*  Trace / logging helpers                                           */
  /* ------------------------------------------------------------------ */
  const traceId = state.metadata?.traceId ?? crypto.randomUUID();
  const spanId = ObservabilityService.startSpan(env, traceId, "generateAnswer", state);
  const logEvt = (e: string, p: Record<string, unknown>) =>
    ObservabilityService.logEvent(env, traceId, spanId, e, p);

  /* ------------------------------------------------------------------ */
  /*  Context preparation with token-aware reduction                    */
  /* ------------------------------------------------------------------ */
  const includeSources = state.options?.includeSourceInfo ?? true;
  const modelId = state.options?.modelId ?? LlmService.MODEL;
  const modelConfig = getModelConfig(modelId);

  // Context reduction - use token-aware context reduction to fit within limits
  const maxContextTokens = Math.floor(modelConfig.maxContextTokens * 0.5);
  const { docs: reducedDocs, tokenCount: contextTokens } = reduceRagContext(state, maxContextTokens);

  // Format documents for prompt
  const docsFmt = formatDocsForPrompt(
    reducedDocs,
    includeSources,
    maxContextTokens
  );

  // Format tool results if available
  const toolFmt = formatToolResults(allToolResults);

  // Build the RAG-enhanced system prompt
  const systemPrompt = buildRAGSystemPrompt(docsFmt, toolFmt, includeSources);
  const sysTokens = countTokens(systemPrompt);
  const userTokens = state.messages.reduce((t, m) => t + countTokens(m.content), 0);

  // Calculate token limits based on model constraints
  const { maxResponseTokens } = calculateTokenLimits(
    modelConfig,
    sysTokens + userTokens,
    state.options?.maxTokens
  );

  // Prepare chat messages with system prompt
  const chatMessages = [
    { role: "system", content: systemPrompt },
    ...state.messages,
  ];

  // Log context statistics for observability
  logEvt("context_stats", {
    originalDocsCount: state.docs?.length ?? 0,
    reducedDocsCount: reducedDocs.length,
    contextTokens,
    sysTokens,
    userTokens,
    maxResponseTokens
  });

  /* ------------------------------------------------------------------ */
  /*  Streaming setup for response generation                           */
  /* ------------------------------------------------------------------ */

  // Create streaming-enabled model
  const model = ModelFactory.createChatModel(env, {
    modelId: modelId,
    temperature: state.options?.temperature ?? 0.7,
    maxTokens: maxResponseTokens,
  });

  // Start streaming
  const response = await model.invoke(chatMessages.map(m => ({
    role: m.role,
    content: m.content,
  })));


  /* ------------------------------------------------------------------ */
  /*  Finish, log, and return the state update                          */
  /* ------------------------------------------------------------------ */
  const elapsed = performance.now() - t0;
  ObservabilityService.endSpan(env, traceId, spanId, "generateAnswer", state, state, elapsed);
  ObservabilityService.endTrace(env, traceId, state, elapsed);

  logger.info({
    elapsedMs: elapsed,
    responseLength: response.text.length,
    response: response.text,
    docsUsed: reducedDocs.length,
    toolsUsed: allToolResults.length
  }, "RAG answer generation complete");

  return {
    generatedText: response.text,
    metadata: {
      currentNode: "generate_rag",
      isFinalState: true,
      executionTimeMs: elapsed,
      nodeTimings: {
        contextReduction: contextTokens,
        docsCount: reducedDocs.length,
        toolsCount: allToolResults.length
      }
    },
  };
};

/* ---------------------------------------------------------------------- */
/*  Helpers                                                               */
/* ---------------------------------------------------------------------- */

/**
 * Build the RAG-enhanced system prompt with context and tool outputs
 */
function buildRAGSystemPrompt(docs: string, tools: string, includeSrc: boolean): string {
  let p = "You are an AI assistant with access to the user's knowledge base.";
  if (docs) {
    p += `\n\nContext:\n${docs}`;
    if (includeSrc) p += "\nUse bracketed numbers like [1] when citing.";
  }
  if (tools) p += `\n\nTool outputs:\n${tools}`;
  return p + "\n\nGive a concise, helpful answer.";
}

/**
 * Format tool results for inclusion in the prompt
 */
function formatToolResults(results: ToolResult[]): string {
  if (!results || results.length === 0) {
    return "";
  }

  return results
    .map((r, i) => {
      const out = r.error
        ? `Error: ${r.error}`
        : typeof r.output === "string"
          ? r.output
          : JSON.stringify(r.output);
      return `[Tool ${i + 1}] ${r.toolName}\nInput: ${r.input}\nOutput: ${out}`;
    })
    .join("\n\n");
}
