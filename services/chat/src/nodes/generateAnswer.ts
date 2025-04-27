import { getLogger, logError } from '@dome/logging';
import { ChatOpenAI } from "@langchain/openai";
import { CloudflareWorkersAI } from "@langchain/cloudflare";
import { LangGraphRunnableConfig } from "@langchain/langgraph";
import { AgentState, ToolResult } from '../types';
import { countTokens } from '../utils/tokenCounter';
import { formatDocsForPrompt } from '../utils/promptFormatter';
import { LlmService } from '../services/llmService';
import { ObservabilityService } from '../services/observabilityService';
import { getModelConfig, calculateTokenLimits } from '../config/modelConfig';

/**
 * Build the node as a *factory* so we can capture `env` once and keep
 * the node signature `(state, cfg)` as LangGraph expects.
 */
export async function generateAnswer(
  state: AgentState,
  cfg: LangGraphRunnableConfig,
  env: Env,
): Promise<Partial<AgentState>> {
  const t0 = performance.now();
  getLogger().info({ messages: state.messages }, "[GenerateAnswer] starting");

  const llm = new ChatOpenAI({
    model: "gpt-4o",
    temperature: 0.7,
    apiKey: env.OPENAI_API_KEY,
  });

  /* ------------------------------------------------------------------ */
  /*  Trace / logging helpers                                           */
  /* ------------------------------------------------------------------ */
  const traceId = state.metadata?.traceId ?? crypto.randomUUID();
  const spanId = ObservabilityService.startSpan(env, traceId, "generateAnswer", state);
  const logEvt = (e: string, p: Record<string, unknown>) =>
    ObservabilityService.logEvent(env, traceId, spanId, e, p);

  /* ------------------------------------------------------------------ */
  /*  Prompt + token-limit setup                                        */
  /* ------------------------------------------------------------------ */
  const includeSources = state.options?.includeSourceInfo ?? true;
  const modelId = state.options?.modelId;

  const docs = state.docs ?? [];
  const docsFmt = formatDocsForPrompt(
    docs,
    includeSources,
    Math.floor(getModelConfig(modelId ?? LlmService.MODEL).maxContextTokens * 0.5)
  );
  const toolFmt = formatToolResults(state.tasks?.toolResults ?? []);

  const systemPrompt = buildSystemPrompt(docsFmt, toolFmt, includeSources);
  const sysTokens = countTokens(systemPrompt);
  const userTokens = state.messages.reduce((t, m) => t + countTokens(m.content), 0);

  const { maxResponseTokens } = calculateTokenLimits(
    getModelConfig(modelId ?? LlmService.MODEL),
    sysTokens + userTokens,
    state.options?.maxTokens
  );

  const chatMessages = [
    { role: "system", content: systemPrompt },   // 👈 context now travels
    ...state.messages,
  ];

  const response = await llm.invoke(chatMessages.map(m => ({
    role: m.role,
    content: m.content,
  })));


  /* ------------------------------------------------------------------ */
  /*  Finish, log, and return the state update                          */
  /* ------------------------------------------------------------------ */
  const elapsed = performance.now() - t0;
  ObservabilityService.endSpan(env, traceId, spanId, "generateAnswer", state, state, elapsed);
  ObservabilityService.endTrace(env, traceId, state, elapsed);
  getLogger().info({ elapsedMs: elapsed, fullLen: response.text.length, content: response.text }, "[GenerateAnswer] done");

  return {
    generatedText: response.text,
    metadata: {
      currentNode: "generate_answer",
      isFinalState: true,
    },
  };
};

/* ---------------------------------------------------------------------- */
/*  Helpers                                                               */
/* ---------------------------------------------------------------------- */

function buildSystemPrompt(docs: string, tools: string, includeSrc: boolean) {
  let p = "You are an AI assistant with access to the user's knowledge base.";
  if (docs) {
    p += `\n\nContext:\n${docs}`;
    if (includeSrc) p += "\nUse bracketed numbers like [1] when citing.";
  }
  if (tools) p += `\n\nTool outputs:\n${tools}`;

  return p + "\n\nGive a concise, helpful answer.";
}

function formatToolResults(results: ToolResult[]): string {
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
