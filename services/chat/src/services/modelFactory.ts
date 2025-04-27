/**
 * Model Factory Service
 *
 * Creates properly configured model instances for LangGraph nodes based on the
 * centralized model configuration.
 */

import { getLogger } from '@dome/logging';
import { ChatOpenAI } from '@langchain/openai';
import { CloudflareWorkersAI } from '@langchain/cloudflare';
// Import for Anthropic when ready
// import { ChatAnthropic } from '@langchain/anthropic';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { 
  ModelProvider, 
  getModelConfig, 
  DEFAULT_MODEL,
  ModelConfig
} from '../config/modelConfig';

const logger = getLogger().child({ component: 'ModelFactory' });

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
    const modelConfig = getModelConfig(options.modelId ?? DEFAULT_MODEL.id);
    
    // Log model creation
    logger.info({ 
      modelId: modelConfig.id, 
      provider: modelConfig.provider,
      streaming: options.streaming
    }, 'Creating chat model');
    
    // Ensure we handle the request for streaming capability
    if (options.streaming && !modelConfig.capabilities.streaming) {
      logger.warn({ modelId: modelConfig.id }, 'Model does not support streaming, falling back to non-streaming');
    }
    
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
    modelConfig: ModelConfig, 
    options: ModelOptions
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
    modelConfig: ModelConfig, 
    options: ModelOptions
  ): BaseChatModel {
    // For Cloudflare AI, we need the proper environment configuration
    // If not properly configured, fall back to OpenAI
    if (!('AI' in env)) {
      logger.warn(
        { modelId: modelConfig.id },
        'Workers AI binding not available, falling back to OpenAI'
      );
      return this.createOpenAIModel(env, DEFAULT_MODEL, options);
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
    modelConfig: ModelConfig, 
    options: ModelOptions
  ): BaseChatModel {
    // TODO: Implement Anthropic integration when needed
    logger.warn(
      { modelId: modelConfig.id }, 
      'Anthropic integration not implemented, falling back to OpenAI'
    );
    
    return this.createOpenAIModel(env, DEFAULT_MODEL, options);
    
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
}
