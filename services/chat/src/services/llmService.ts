import { getLogger } from '@dome/common';
import { AIMessage } from '../types';
import { ChatOpenAI } from '@langchain/openai';
import {
  HumanMessage,
  MessageContent,
  SystemMessage,
  AIMessage as LangChainAIMessage,
} from '@langchain/core/messages';
import { StringOutputParser } from '@langchain/core/output_parsers';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { Tool } from '@langchain/core/tools';
import { ZodSchema } from 'zod';
import { ModelFactory } from './modelFactory';
import {
  // Import from the new common package instead of local config
  getModelConfig,
  getDefaultModel,
  OPENAI_MODELS,
  calculateTokenLimits,
  configureLlmSystem,
  ModelProvider,
  BaseModelConfig,
  truncateToTokenLimit,
  countTokens,
  calculateContextLimits,
} from '@dome/common';

// Get prompts from local config for now (these aren't part of the common package yet)
import { getTimeoutConfig, getQueryRewritingPrompt, getQueryComplexityAnalysisPrompt } from '../config';

let MODEL = OPENAI_MODELS.GPT_4_TURBO.id;
const logger = getLogger();

/* -------------------------------------------------------- */
/*  Core helpers                                            */
/* -------------------------------------------------------- */
const isTest = () => false;
const mockResponse = 'This is a mock response for testing purposes.';
const fallbackResponse = "I'm sorry, but I couldn't process that just now – please try again.";

function withTimeout<T>(p: Promise<T>, ms = getTimeoutConfig().llmServiceTimeout) {
  return Promise.race<T>([
    p,
    new Promise<T>((_, rej) =>
      setTimeout(() => rej(new Error(`LLM call timed out after ${ms} ms`)), ms),
    ),
  ]);
}

/**
 * Truncates context to fit within the model's context window
 * Using dynamic allocation based on the contextConfig settings
 *
 * @param context Text context to truncate if necessary
 * @param modelId Model ID to use for tokenization and limits
 * @returns Truncated context with ellipsis if needed
 */
function truncateContextToFit(context: string, modelId?: string): string {
  // Get model configuration
  const modelConfig = getModelConfig(modelId);

  // Count tokens in the context using the common package tokenizer
  const ctxTokens = countTokens(context, modelConfig.id);

  // Get context limits using our new configuration system
  const { maxDocumentsTokens } = calculateContextLimits(modelConfig);

  // If context fits within limit, return as is
  if (ctxTokens <= maxDocumentsTokens!) return context;

  // Use the common package's truncation utility with our token counter
  return truncateToTokenLimit(
    context,
    maxDocumentsTokens!,
    (text) => countTokens(text, modelConfig.id)
  );
}

/* -------------------------------------------------------- */
/*  LLM Service implementation                              */
/* -------------------------------------------------------- */
export class LlmService {
  static get MODEL() { return MODEL; }

  /**
   * Initialize the LLM service with environment variables
   * This must be called during service startup
   */
  static initialize(env: Env): void {
    // Use the common package's configureLlmSystem function
    configureLlmSystem(env);

    // Update the static MODEL property to match the configured default
    MODEL = getDefaultModel().id;

    logger.info(
      {
        model: MODEL,
        modelName: getDefaultModel().name,
        provider: getDefaultModel().provider,
      },
      'LLM service initialized'
    );
  }

  /**
   * Get a configured ChatOpenAI instance
   */
  private static getClient(
    env: Env,
    opts: { temperature?: number; maxTokens?: number; modelId?: string } = {},
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
    opts: { temperature?: number; maxTokens?: number; modelId?: string } = {},
  ): ChatOpenAI {
    // Get model config - use specified modelId or default
    const modelConfig = getModelConfig(opts.modelId ?? this.MODEL);

    // Verify the model supports streaming
    if (!modelConfig.capabilities.streaming) {
      logger.warn(
        { modelId: modelConfig.id },
        'Model does not support streaming, using non-streaming client',
      );
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
   * Create an LLM with tools bound
   * @param env Environment variables
   * @param tools Array of tools to bind to the model
   * @param opts Optional parameters (temperature, maxTokens, modelId)
   * @returns A chat model with tools bound
   */
  static createToolBoundLLM(
    env: Env,
    tools: Tool[],
    opts: { temperature?: number; maxTokens?: number; modelId?: string } = {},
  ): BaseChatModel {
    const modelId = opts.modelId ?? this.MODEL;
    const modelConfig = getModelConfig(modelId);

    logger.info(
      {
        modelId,
        toolCount: tools.length,
      },
      'Creating tool-bound LLM',
    );

    try {
      return ModelFactory.createToolBoundModel(env, tools, {
        modelId,
        temperature: opts.temperature,
        maxTokens: opts.maxTokens,
      });
    } catch (error) {
      logger.error(
        {
          err: error,
          modelId,
        },
        'Failed to create tool-bound LLM',
      );

      // Fall back to default model if specified model fails
      if (modelId !== getDefaultModel().id) {
        logger.info('Falling back to default model for tool binding');
        return ModelFactory.createToolBoundModel(env, tools, {
          temperature: opts.temperature,
          maxTokens: opts.maxTokens,
        });
      }
      throw error;
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

      return (response as string) || fallbackResponse;
    } catch (e) {
      logger.warn({ err: e }, 'LLM call failed – returning fallback');
      return fallbackResponse;
    }
  }

  /**
   * Invoke LLM with structured output schema
   * @param env Environment variables
   * @param messages Array of messages for the LLM
   * @param opts Optional parameters (temperature, modelId, schema)
   * @returns Structured output of type T
   */
  static async invokeStructured<T>(
    env: Env,
    messages: AIMessage[],

    opts: {
      temperature?: number;
      modelId?: string;
      schema: ZodSchema;
      schemaInstructions: string;
    },
  ): Promise<T> {
    if (isTest()) return mockResponse as unknown as T;

    try {
      logger.info(
        {
          modelId: opts.modelId ?? this.MODEL,
          messageCount: messages.length,
        },
        'Invoking LLM with structured output schema',
      );

      // Convert messages to LangChain format
      const langChainMessages = this.convertMessages(messages);

      // Create structured output model
      const model = ModelFactory.createStructuredOutputModel<T>(env, {
        modelId: opts.modelId ?? this.MODEL,
        temperature: opts.temperature,
        schema: opts.schema,
        schemaInstructions: opts.schemaInstructions,
      }).withStructuredOutput(opts.schema);

      // Get the result with timeout
      const result = await withTimeout(model.invoke(langChainMessages));

      return result as T;
    } catch (e: any) {
      logger.error({ err: e }, 'Structured output LLM call failed');
      throw new Error(`Failed to get structured output: ${e?.message || 'Unknown error'}`);
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
  static async rewriteQuery(env: Env, original: string, ctx: AIMessage[] = []): Promise<string> {
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
}
