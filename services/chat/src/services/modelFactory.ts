/**
 * Model Factory Service
 *
 * Creates properly configured model instances for LangGraph nodes based on the
 * centralized model configuration.
 */

import { getLogger } from '@dome/common';
import { ChatOpenAI } from '@langchain/openai';
import { CloudflareWorkersAI } from '@langchain/cloudflare';
// Import for Anthropic when ready
// import { ChatAnthropic } from '@langchain/anthropic';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { StructuredOutputParser } from '@langchain/core/output_parsers';
import { ChatPromptTemplate } from '@langchain/core/prompts';
import { RunnableSequence } from '@langchain/core/runnables';
import { Tool } from '@langchain/core/tools';
import { ModelProvider, getModelConfig, getDefaultModel, BaseModelConfig } from '@dome/common';

const logger = getLogger().child({ component: 'ModelFactory' });

import { ZodSchema } from 'zod';

/**
 * Model options interface
 */
export interface ModelOptions {
  /** Model ID to use (falls back to configured default if not provided) */
  modelId?: string;
  /** Temperature (randomness) for generation */
  temperature?: number;
  /** Maximum number of tokens to generate */
  maxTokens?: number;
  /** Whether to enable streaming responses */
  streaming?: boolean;
}

export interface StructuredModelOptions extends ModelOptions {
  schema: ZodSchema;
  schemaInstructions: string;
}

/**
 * Model Factory Service
 *
 * Creates and configures models based on the centralized model configuration
 */
export class ModelFactory {
  /**
   * Create a chat model instance based on the provided options
   *
   * @param env Cloudflare environment bindings
   * @param options Model options
   * @returns Configured chat model instance
   */
  static createChatModel(env: Env, options: ModelOptions = {}): BaseChatModel {
    // Get model configuration from centralized config
    const modelConfig = getModelConfig(options.modelId ?? getDefaultModel().id);

    // Log model creation
    logger.info(
      {
        modelId: modelConfig.id,
        provider: modelConfig.provider,
        streaming: options.streaming,
      },
      'Creating chat model',
    );

    // Ensure we handle the request for streaming capability
    if (options.streaming && !modelConfig.capabilities.streaming) {
      logger.warn(
        { modelId: modelConfig.id },
        'Model does not support streaming, falling back to non-streaming',
      );
    }

    getLogger().info({ modelConfig }, '[ModelFactory]: Using Model');

    // Create the appropriate model instance based on provider
    switch (modelConfig.provider) {
      case ModelProvider.OPENAI:
        return this.createOpenAIModel(env, modelConfig, options);

      case ModelProvider.CLOUDFLARE:
        return this.createCloudflareModel(env, modelConfig, options);

      case ModelProvider.ANTHROPIC:
        return this.createAnthropicModel(env, modelConfig, options);

      default:
        // Default to OpenAI if unknown provider
        logger.warn({ provider: modelConfig.provider }, 'Unknown provider, falling back to OpenAI');
        return this.createOpenAIModel(env, modelConfig, options);
    }
  }

  /**
   * Create an OpenAI chat model
   */
  private static createOpenAIModel(
    env: Env,
    modelConfig: BaseModelConfig,
    options: ModelOptions,
  ): ChatOpenAI {
    return new ChatOpenAI({
      modelName: modelConfig.id,
      temperature: options.temperature ?? modelConfig.defaultTemperature,
      maxTokens: options.maxTokens ?? modelConfig.defaultMaxTokens,
      streaming: options.streaming ?? modelConfig.capabilities.streaming,
      openAIApiKey: env.OPENAI_API_KEY || 'sk-dummy-key-for-testing',
    });
  }

  /**
   * Create a Cloudflare Workers AI chat model
   */
  private static createCloudflareModel(
    env: Env,
    modelConfig: BaseModelConfig,
    options: ModelOptions,
  ): BaseChatModel {
    // For Cloudflare AI, we need the proper environment configuration
    // If not properly configured, fall back to OpenAI
    if (!('AI' in env)) {
      logger.warn(
        { modelId: modelConfig.id },
        'Workers AI binding not available, falling back to OpenAI',
      );
      return this.createOpenAIModel(env, getDefaultModel(), options);
    }

    // We need to type cast since the Cloudflare Workers AI implementation
    // may not fully implement the BaseChatModel interface
    return new CloudflareWorkersAI({
      model: modelConfig.id,
      // @ts-ignore - CloudflareWorkersAI has different parameter structure
      temperature: options.temperature ?? modelConfig.defaultTemperature,
      maxTokens: options.maxTokens ?? modelConfig.defaultMaxTokens,
      streaming: options.streaming ?? modelConfig.capabilities.streaming,
      // @ts-ignore - env.AI is defined but not in the type
      binding: env.AI,
    }) as unknown as BaseChatModel;
  }

  /**
   * Create an Anthropic chat model
   * Note: Currently falls back to OpenAI as Anthropic integration is not implemented
   */
  private static createAnthropicModel(
    env: Env,
    modelConfig: BaseModelConfig,
    options: ModelOptions,
  ): BaseChatModel {
    // TODO: Implement Anthropic integration when needed
    logger.warn(
      { modelId: modelConfig.id },
      'Anthropic integration not implemented, falling back to OpenAI',
    );

    return this.createOpenAIModel(env, getDefaultModel(), options);

    // When implementing Anthropic, use something like this:
    /*
    return new ChatAnthropic({
      modelName: modelConfig.id,
      temperature: options.temperature ?? modelConfig.defaultTemperature,
      maxTokens: options.maxTokens ?? modelConfig.defaultMaxTokens,
      streaming: options.streaming ?? modelConfig.capabilities.streaming,
      anthropicApiKey: env.ANTHROPIC_API_KEY ?? 'dummy-key-for-testing',
    });
    */
  }

  /**
   * Create a structured output model that returns data in a specific format
   * @param env Environment variables
   * @param options Model options including schema
   * @returns A chat model that produces structured output
   */
  static createStructuredOutputModel<T>(env: Env, options: StructuredModelOptions): BaseChatModel {
    // Get model configuration
    const modelConfig = getModelConfig(options.modelId);

    // Check if model supports structured output
    if (!modelConfig.capabilities.structuredOutput) {
      // Fall back to a model that supports structured output
      logger.warn(
        { requestedModel: modelConfig.id },
        'Model does not support structured output, falling back to suitable model',
      );

      // Find a model that supports structured output
      const fallbackModels = [
        'gpt-4o',
        'gpt-4-turbo',
        'claude-3-opus-20240229',
        'claude-3-sonnet-20240229',
      ];

      // Try each fallback model
      let fallbackModel = modelConfig;
      for (const modelId of fallbackModels) {
        const candidate = getModelConfig(modelId);
        if (candidate.capabilities.structuredOutput) {
          fallbackModel = candidate;
          break;
        }
      }

      logger.info({ fallbackTo: fallbackModel.id }, 'Using fallback model for structured output');

      // Create structured output with fallback model
      return this.createChatModel(env, { modelId: fallbackModel.id, ...options });
    }

    return this.createChatModel(env, { modelId: modelConfig.id, ...options });
  }

  /**
   * Create a chat model with tools bound
   * @param env Environment variables
   * @param tools Array of tools to bind to the model
   * @param options Model options
   * @returns A chat model with tools bound
   */
  static createToolBoundModel(env: Env, tools: Tool[], options: ModelOptions = {}): BaseChatModel {
    // Get model configuration
    const modelConfig = getModelConfig(options.modelId);

    // Check if model supports tool binding
    if (!modelConfig.capabilities.toolUse) {
      // Fall back to a model that supports tool binding
      logger.warn(
        { requestedModel: modelConfig.id },
        'Model does not support tool binding, falling back to suitable model',
      );

      // Find a model that supports tool binding
      const fallbackModels = [
        'gpt-4o',
        'gpt-4-turbo',
        'claude-3-opus-20240229',
        'claude-3-sonnet-20240229',
      ];

      // Try each fallback model
      let fallbackModel = modelConfig;
      for (const modelId of fallbackModels) {
        const candidate = getModelConfig(modelId);
        if (candidate.capabilities.toolUse) {
          fallbackModel = candidate;
          break;
        }
      }

      logger.info({ fallbackTo: fallbackModel.id }, 'Using fallback model for tool binding');

      // Create tool bound model with fallback model
      return this.createToolBoundWithModel(env, tools, fallbackModel, options);
    }

    // Create tool bound model with requested model
    return this.createToolBoundWithModel(env, tools, modelConfig, options);
  }

  /**
   * Helper method to create a tool-bound model with a specific model config
   * @private
   */
  private static createToolBoundWithModel(
    env: Env,
    tools: Tool[],
    modelConfig: BaseModelConfig,
    options: ModelOptions,
  ): BaseChatModel {
    // Create the model based on provider
    switch (modelConfig.provider) {
      case ModelProvider.OPENAI: {
        // For OpenAI, we create a model with tools bound
        const model = this.createOpenAIModel(env, modelConfig, options);
        // Bind tools to the model and cast back to BaseChatModel
        // This is a type workaround as LangChain returns a Runnable
        if (!model.bindTools) {
          logger.warn(
            { modelId: modelConfig.id },
            'Model does not support bindTools method, returning base model',
          );
          return model;
        }
        return model.bindTools(tools) as unknown as BaseChatModel;
      }

      case ModelProvider.ANTHROPIC: {
        // For Anthropic, we create a model with tools bound
        const model = this.createAnthropicModel(env, modelConfig, options);
        // Bind tools to the model and cast back to BaseChatModel
        // This is a type workaround as LangChain returns a Runnable
        if (!model.bindTools) {
          logger.warn(
            { modelId: modelConfig.id },
            'Model does not support bindTools method, returning base model',
          );
          return model;
        }
        return model.bindTools(tools) as unknown as BaseChatModel;
      }

      case ModelProvider.CLOUDFLARE:
      default:
        // Fallback to OpenAI for providers that don't support tool binding well
        logger.warn(
          { provider: modelConfig.provider },
          'Provider does not support tool binding, falling back to OpenAI',
        );
        const openAiModel = getModelConfig('gpt-4o');
        const model = this.createOpenAIModel(env, openAiModel, options);
        // Bind tools to the model and cast back to BaseChatModel
        if (!model.bindTools) {
          logger.warn(
            { modelId: openAiModel.id },
            'Model does not support bindTools method, returning base model',
          );
          return model;
        }
        return model.bindTools(tools) as unknown as BaseChatModel;
    }
  }
}
