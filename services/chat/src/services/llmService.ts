import { getLogger } from '@dome/logging';
import { AIMessage, WorkersAiMessage, WorkersAi } from '../types';
import {
  DEFAULT_MODEL,
  getModelConfig,
  calculateTokenLimits,
  getTimeoutConfig,
  getQueryRewritingPrompt,
  getQueryComplexityAnalysisPrompt,
  getResponseGenerationPrompt,
} from '../config';

export const MODEL = DEFAULT_MODEL.id;
const logger = getLogger();

/* -------------------------------------------------------- */
/*  Core helpers                                            */
/* -------------------------------------------------------- */
const isTest = () => process.env.NODE_ENV === 'test' || !!process.env.VITEST;
const mockResponse = 'This is a mock response for testing purposes.';
const fallbackResponse =
  "I'm sorry, but I couldn't process that just now – please try again.";

function withTimeout<T>(p: Promise<T>, ms = getTimeoutConfig().llmServiceTimeout) {
  return Promise.race<T>([
    p,
    new Promise<T>((_, rej) =>
      setTimeout(() => rej(new Error(`LLM call timed out after ${ms} ms`)), ms),
    ),
  ]);
}

function truncateContext(context: string, cfg: ReturnType<typeof getModelConfig>): string {
  const ctxTokens = Math.ceil(context.length / 4);
  const maxCtx = Math.floor(cfg.maxContextTokens * 0.5);
  if (ctxTokens <= maxCtx) return context;
  const ratio = maxCtx / ctxTokens;
  return context.slice(0, Math.floor(context.length * ratio)) + '…';
}

/* -------------------------------------------------------- */
/*  Thin Workers-AI wrapper                                 */
/* -------------------------------------------------------- */
export class LlmService {
  static MODEL = MODEL;

  /* ------------------------------------------------------ */
  /*  Low‑level wrappers                                    */
  /* ------------------------------------------------------ */
  static async call(
    env: Env,
    messages: AIMessage[],
    opts: { temperature?: number; maxTokens?: number } = {},
  ): Promise<string> {
    if (!env.AI) return isTest() ? mockResponse : fallbackResponse;
    try {
      // Cast messages to WorkersAiMessage[]
      const aiMessages: WorkersAiMessage[] = messages.map(m => ({
        role: m.role,
        content: m.content
      }));

      // Use typed Workers AI
      const { response } = await withTimeout(
        (env.AI as unknown as WorkersAi).run(MODEL, {
          messages: aiMessages,
          ...opts
        })
      ) as { response: string };
      
      return response ?? fallbackResponse;
    } catch (e) {
      logger.warn({ err: e }, 'LLM call failed – returning fallback');
      return fallbackResponse;
    }
  }

  static async *stream(
    env: Env,
    messages: AIMessage[],
    opts: { temperature?: number; maxTokens?: number } = {},
  ): AsyncGenerator<string> {
    if (!env.AI) {
      yield isTest() ? mockResponse : fallbackResponse;
      return;
    }

    let stream: ReadableStream;
    try {
      // Cast messages to WorkersAiMessage[]
      const aiMessages: WorkersAiMessage[] = messages.map(m => ({
        role: m.role,
        content: m.content
      }));

      // Use typed Workers AI
      stream = await withTimeout(
        (env.AI as unknown as WorkersAi).run(MODEL, {
          messages: aiMessages,
          stream: true,
          ...opts
        })
      ) as ReadableStream;
    } catch (e) {
      logger.warn({ err: e }, 'LLM stream failed – sending fallback');
      yield fallbackResponse;
      return;
    }

    const reader = stream.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      yield decoder.decode(value, { stream: true });
    }
  }

  /* ------------------------------------------------------ */
  /*  Higher‑level helpers                                  */
  /* ------------------------------------------------------ */
  static async rewriteQuery(
    env: Env,
    original: string,
    ctx: AIMessage[] = [],
  ): Promise<string> {
    const msgs: AIMessage[] = [
      { role: 'system', content: getQueryRewritingPrompt() },
      ...ctx,
      { role: 'user', content: `Original query: "${original}"` },
    ];
    const out = await this.call(env, msgs);
    const trimmed = out.trim().replace(/^['"]|['"]$/g, '');
    return trimmed.length > 2 * original.length || trimmed.includes('\n') ? original : trimmed;
  }

  static async analyzeQuery(
    env: Env,
    query: string,
  ): Promise<{ isComplex: boolean; shouldSplit: boolean; reason: string; suggested?: string[] }> {
    const msgs: AIMessage[] = [
      { role: 'system', content: getQueryComplexityAnalysisPrompt() },
      { role: 'user', content: `Analyze: "${query}"` },
    ];
    const out = await this.call(env, msgs);
    try {
      const json = JSON.parse(/```(?:json)?\s*([\s\S]*?)\s*```/.exec(out)?.[1] ?? out);
      return {
        isComplex: !!json.isComplex,
        shouldSplit: !!json.shouldSplit,
        reason: json.reason ?? '',
        suggested: Array.isArray(json.suggestedQueries) ? json.suggestedQueries : undefined,
      };
    } catch {
      return { isComplex: false, shouldSplit: false, reason: 'parse_error' };
    }
  }

  /** Build + stream final answer */
  static async *streamAnswer(
    env: Env,
    conv: AIMessage[],
    docs: string,
    opts: {
      temperature?: number;
      maxTokens?: number;
      includeSourceInfo?: boolean;
      modelId?: string;
    } = {},
  ): AsyncGenerator<string> {
    const cfg = getModelConfig(opts.modelId ?? MODEL);
    const ctx = truncateContext(docs, cfg);
    const sysPrompt = getResponseGenerationPrompt(ctx, opts.includeSourceInfo);

    const inTokens = Math.ceil((sysPrompt.length + conv.reduce((n, m) => n + m.content.length, 0)) / 4);
    const { maxResponseTokens } = calculateTokenLimits(cfg, inTokens, opts.maxTokens);

    const messages: AIMessage[] = [{ role: 'system', content: sysPrompt }, ...conv];
    for await (const chunk of this.stream(env, messages, {
      temperature: opts.temperature ?? cfg.defaultTemperature,
      maxTokens: maxResponseTokens,
    })) {
      yield chunk;
    }
  }
}
