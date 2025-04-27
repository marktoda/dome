import { getLogger } from '@dome/logging';
import { AIMessage } from '../types';
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, MessageContent, SystemMessage, AIMessage as LangChainAIMessage } from '@langchain/core/messages';
import { StringOutputParser } from '@langchain/core/output_parsers';
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
const isTest = () => false;
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
/*  LangChain OpenAI implementation                         */
/* -------------------------------------------------------- */
export class LlmService {
  static MODEL = MODEL;

  /**
   * Get a configured ChatOpenAI instance
   */
  private static getClient(
    env: Env,
    opts: { temperature?: number; maxTokens?: number } = {}
  ): ChatOpenAI {
    // Use environment variables to configure the client
    const apiKey = env.OPENAI_API_KEY || 'sk-dummy-key-for-testing';

    return new ChatOpenAI({
      modelName: MODEL,
      temperature: opts.temperature ?? 0.7,
      maxTokens: opts.maxTokens,
      openAIApiKey: apiKey,
      streaming: false,
    });
  }

  /**
   * Get a streaming-enabled ChatOpenAI instance
   */
  private static getStreamingClient(
    env: Env,
    opts: { temperature?: number; maxTokens?: number } = {}
  ): ChatOpenAI {
    // Use environment variables to configure the client
    const apiKey = env.OPENAI_API_KEY || 'sk-dummy-key-for-testing';

    return new ChatOpenAI({
      modelName: MODEL,
      temperature: opts.temperature ?? 0.7,
      maxTokens: opts.maxTokens,
      openAIApiKey: apiKey,
      streaming: true,
    });
  }

  /**
   * Convert our AIMessage format to LangChain message format
   */
  private static convertMessages(messages: AIMessage[]) {
    return messages.map(msg => {
      if (msg.role === 'system') {
        return new SystemMessage(msg.content);
      } else if (msg.role === 'user') {
        return new HumanMessage(msg.content);
      } else {
        return new LangChainAIMessage(msg.content);
      }
    });
  }

  /* ------------------------------------------------------ */
  /*  Low‑level wrappers                                    */
  /* ------------------------------------------------------ */
  static async call(
    env: Env,
    messages: AIMessage[],
    opts: { temperature?: number; maxTokens?: number } = {},
  ): Promise<string> {
    if (isTest()) return mockResponse;

    try {
      // Convert messages to LangChain format
      const langChainMessages = this.convertMessages(messages);

      // Get client and call the model
      const model = this.getClient(env, opts);
      const outputParser = new StringOutputParser();

      const chain = model.pipe(outputParser);
      const response = await withTimeout(chain.invoke(langChainMessages));

      return response || fallbackResponse;
    } catch (e) {
      logger.warn({ err: e }, 'LLM call failed – returning fallback');
      return fallbackResponse;
    }
  }

  static async *stream(
    env: Env,
    messages: AIMessage[],
    opts: { temperature?: number; maxTokens?: number } = {},
  ): AsyncGenerator<MessageContent> {
    if (isTest()) {
      yield mockResponse;
      return;
    }

    try {
      // Convert messages to LangChain format
      const langChainMessages = this.convertMessages(messages);

      // Get streaming-enabled client
      const model = this.getStreamingClient(env, opts);

      // Use LangChain's streaming capability
      const stream = await model.stream(langChainMessages);

      for await (const chunk of stream) {
        if (chunk.content) {
          yield chunk.content;
        }
      }
    } catch (e) {
      logger.warn({ err: e }, 'LLM stream failed – sending fallback');
      yield fallbackResponse;
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
  ): AsyncGenerator<MessageContent> {
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
