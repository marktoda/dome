import { getLogger, logError } from '@dome/common';
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
  MODELS,
  ALL_MODELS_ARRAY,
  getDefaultModel,
  ModelRegistry,
  ModelProvider,
} from '@dome/common';

// Get prompts from local config for now (these aren't part of the common package yet)
import { getTimeoutConfig } from '../config';
import { ALL } from 'node:dns';

const DEFAULT_MODEL_ID = MODELS.OPENAI.GPT_4_TURBO.id;
const DEFAULT_STRUCTURED_MODEL_ID = MODELS.OPENAI.GPT_4o.id;
export const MODEL_REGISTRY = new ModelRegistry(ALL_MODELS_ARRAY);
MODEL_REGISTRY.setDefaultModel(DEFAULT_MODEL_ID);
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

/* -------------------------------------------------------- */
/*  LLM Service implementation                              */
/* -------------------------------------------------------- */
export class LlmService {
  /**
   * Get a configured ChatOpenAI instance
   */
  private static getClient(
    env: Env,
    opts: { temperature?: number; maxTokens?: number; modelId?: string } = {},
  ): ChatOpenAI {
    const model = MODEL_REGISTRY.getModel(opts.modelId);

    // Base client options
    const clientOptions = {
      modelName: model.id,
      temperature: opts.temperature ?? model.defaultTemperature,
      maxTokens: opts.maxTokens,
      streaming: false,
    };

    // Provider-specific configuration
    switch (model.provider) {
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
    const modelConfig = MODEL_REGISTRY.getModel(opts.modelId);

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
    const modelConfig = MODEL_REGISTRY.getModel(opts.modelId);
    const modelId = modelConfig.id;

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
      logError(
        error,
        'Failed to create tool-bound LLM',
        { modelId },
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
        modelId: opts.modelId,
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
      schema: ZodSchema;
      schemaInstructions: string;
    },
  ): Promise<T> {
    if (isTest()) return mockResponse as unknown as T;

    try {
      // Convert messages to LangChain format
      const langChainMessages = LlmService.convertMessages(messages);
      // Get client and call the model
      const modelConfig = MODEL_REGISTRY.getModel(DEFAULT_STRUCTURED_MODEL_ID);
      logger.info(
        {
          modelId: modelConfig.id,
          messageCount: messages.length,
        },
        'Invoking LLM with structured output schema',
      );

      // Create structured output model
      const model = ModelFactory.createStructuredOutputModel<T>(env, {
        modelId: modelConfig.id,
        temperature: opts.temperature,
        schema: opts.schema,
        schemaInstructions: opts.schemaInstructions,
      }).withStructuredOutput(opts.schema);

      // Get the result with timeout
      const result = await withTimeout(model.invoke(langChainMessages));

      return result as T;
    } catch (e: any) {
      logError(e, 'Structured output LLM call failed');
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
      const langChainMessages = LlmService.convertMessages(messages);

      // Get streaming-enabled client
      const model = this.getStreamingClient(env, {
        ...opts,
        modelId: opts.modelId,
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
}
