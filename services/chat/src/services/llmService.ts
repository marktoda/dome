import { getLogger } from '@dome/logging';
import { AIMessage } from '../types';
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, MessageContent, SystemMessage, AIMessage as LangChainAIMessage } from '@langchain/core/messages';
import { StringOutputParser } from '@langchain/core/output_parsers';
import {
  DEFAULT_MODEL,
  ModelProvider,
  getModelConfig,
  calculateTokenLimits,
  configureDefaultModel,
  getTimeoutConfig,
  getQueryRewritingPrompt,
  getQueryComplexityAnalysisPrompt,
  getResponseGenerationPrompt,
} from '../config';

// Default model ID to use - will be properly initialized during service startup
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
/*  LLM Service implementation                              */
/* -------------------------------------------------------- */
export class LlmService {
  static MODEL = MODEL;
  
  /**
   * Initialize the LLM service with environment variables
   * This must be called during service startup
   */
  static initialize(env: Env): void {
    // Create a safe configuration object from env
    const config: Record<string, unknown> = {};
    
    // Extract model configuration if available
    if ('DEFAULT_MODEL_ID' in env && typeof env.DEFAULT_MODEL_ID === 'string') {
      config.DEFAULT_MODEL_ID = env.DEFAULT_MODEL_ID;
    }
    
    // Configure the default model based on environment variables
    configureDefaultModel(config);
    
    // Update the static MODEL property to match the configured default
    this.MODEL = DEFAULT_MODEL.id;
    
    logger.info({
      model: DEFAULT_MODEL.id,
      modelName: DEFAULT_MODEL.name,
      provider: DEFAULT_MODEL.provider
    }, 'LLM service initialized');
  }

  /**
   * Get a configured ChatOpenAI instance
   */
  private static getClient(
    env: Env,
    opts: { temperature?: number; maxTokens?: number; modelId?: string } = {}
  ): ChatOpenAI {
    // Get model config - use specified modelId or default
    const modelConfig = getModelConfig(opts.modelId ?? this.MODEL);
    
    // Base client options
    const clientOptions = {
      modelName: modelConfig.id,
      temperature: opts.temperature ?? modelConfig.defaultTemperature,
      maxTokens: opts.maxTokens,
      streaming: false,
    };
    
    // Provider-specific configuration
    switch (modelConfig.provider) {
      case ModelProvider.OPENAI:
        return new ChatOpenAI({
          ...clientOptions,
          openAIApiKey: env.OPENAI_API_KEY || 'sk-dummy-key-for-testing',
        });
        
      case ModelProvider.CLOUDFLARE:
        // Cloudflare Workers AI integration would be configured here
        // This might use a different client implementation in the future
        return new ChatOpenAI({
          ...clientOptions,
          openAIApiKey: env.OPENAI_API_KEY || 'sk-dummy-key-for-testing',
        });
        
      case ModelProvider.ANTHROPIC:
        // Anthropic integration would be configured here
        // This would likely use a different client implementation
        return new ChatOpenAI({
          ...clientOptions,
          openAIApiKey: env.OPENAI_API_KEY || 'sk-dummy-key-for-testing',
        });
        
      default:
        // Fall back to OpenAI configuration
        return new ChatOpenAI({
          ...clientOptions,
          openAIApiKey: env.OPENAI_API_KEY || 'sk-dummy-key-for-testing',
        });
    }
  }

  /**
   * Get a streaming-enabled ChatOpenAI instance
   */
  private static getStreamingClient(
    env: Env,
    opts: { temperature?: number; maxTokens?: number; modelId?: string } = {}
  ): ChatOpenAI {
    // Get model config - use specified modelId or default
    const modelConfig = getModelConfig(opts.modelId ?? this.MODEL);
    
    // Verify the model supports streaming
    if (!modelConfig.capabilities.streaming) {
      logger.warn({ modelId: modelConfig.id }, 'Model does not support streaming, using non-streaming client');
    }
    
    // Base client options
    const clientOptions = {
      modelName: modelConfig.id,
      temperature: opts.temperature ?? modelConfig.defaultTemperature,
      maxTokens: opts.maxTokens,
      streaming: true,
    };
    
    // Provider-specific configuration
    switch (modelConfig.provider) {
      case ModelProvider.OPENAI:
        return new ChatOpenAI({
          ...clientOptions,
          openAIApiKey: env.OPENAI_API_KEY || 'sk-dummy-key-for-testing',
        });
        
      case ModelProvider.CLOUDFLARE:
        // Cloudflare Workers AI integration would be configured here
        return new ChatOpenAI({
          ...clientOptions,
          openAIApiKey: env.OPENAI_API_KEY || 'sk-dummy-key-for-testing',
        });
        
      case ModelProvider.ANTHROPIC:
        // Anthropic integration would be configured here
        return new ChatOpenAI({
          ...clientOptions,
          openAIApiKey: env.OPENAI_API_KEY || 'sk-dummy-key-for-testing',
        });
        
      default:
        // Fall back to OpenAI configuration
        return new ChatOpenAI({
          ...clientOptions,
          openAIApiKey: env.OPENAI_API_KEY || 'sk-dummy-key-for-testing',
        });
    }
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
    opts: { temperature?: number; maxTokens?: number; modelId?: string } = {},
  ): Promise<string> {
    if (isTest()) return mockResponse;

    try {
      // Convert messages to LangChain format
      const langChainMessages = this.convertMessages(messages);

      // Get client and call the model
      const model = this.getClient(env, {
        ...opts,
        modelId: opts.modelId ?? this.MODEL,
      });
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
    opts: { temperature?: number; maxTokens?: number; modelId?: string } = {},
  ): AsyncGenerator<MessageContent> {
    if (isTest()) {
      yield mockResponse;
      return;
    }

    try {
      // Convert messages to LangChain format
      const langChainMessages = this.convertMessages(messages);

      // Get streaming-enabled client
      const model = this.getStreamingClient(env, {
        ...opts,
        modelId: opts.modelId ?? this.MODEL,
      });

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
    const cfg = getModelConfig(opts.modelId ?? this.MODEL);
    const ctx = truncateContext(docs, cfg);
    const sysPrompt = getResponseGenerationPrompt(ctx, opts.includeSourceInfo);

    const inTokens = Math.ceil((sysPrompt.length + conv.reduce((n, m) => n + m.content.length, 0)) / 4);
    const { maxResponseTokens } = calculateTokenLimits(cfg, inTokens, opts.maxTokens);

    const messages: AIMessage[] = [{ role: 'system', content: sysPrompt }, ...conv];
    for await (const chunk of this.stream(env, messages, {
      temperature: opts.temperature ?? cfg.defaultTemperature,
      maxTokens: maxResponseTokens,
      modelId: opts.modelId ?? this.MODEL,
    })) {
      yield chunk;
    }
  }
}
