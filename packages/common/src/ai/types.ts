/**
 * Core types for the LLM configuration system
 *
 * This file defines the core interfaces and types used throughout the LLM
 * configuration system. These types are designed to be provider-agnostic
 * and focus on the capabilities and parameters that are common across
 * different LLM providers.
 */

/**
 * Supported LLM providers
 */
export enum ModelProvider {
  OPENAI = 'openai',
  ANTHROPIC = 'anthropic',
  CLOUDFLARE = 'cloudflare',
  CUSTOM = 'custom',
}

/**
 * Model capabilities that define what features an LLM supports
 */
export interface ModelCapabilities {
  /** Whether the model supports streaming responses */
  streaming: boolean;

  /** Whether the model supports function calling */
  functionCalling: boolean;

  /** Whether the model supports tool use (e.g. external API calls) */
  toolUse: boolean;

  /** Whether the model supports returning structured outputs directly */
  structuredOutput: boolean;

  /** Whether the model supports vision/image inputs */
  vision?: boolean;

  /** Whether the model supports embeddings */
  embeddings?: boolean;
}

/**
 * Common model configuration shared across all providers
 */
export interface BaseModelConfig {
  /** Unique key used internally to reference this model */
  key: string;

  /** Model identifier used when making API calls */
  id: string;

  /** Human-readable name of the model */
  name: string;

  /** The provider of this model */
  provider: ModelProvider;

  /** Maximum context window size in tokens */
  maxContextTokens: number;

  /** Default maximum number of tokens to generate */
  defaultMaxTokens: number;

  /** Default sampling temperature */
  defaultTemperature: number;

  /** Model capabilities */
  capabilities: ModelCapabilities;

  /** Whether to make this model available in production */
  productionReady?: boolean;

  /** Provider-specific parameters */
  providerParams?: Record<string, any>;
}

/**
 * Configuration for token allocation within the context window
 */
export interface ContextAllocation {
  /** Percentage of context window to allocate for system prompt */
  systemPromptPercentage: number;

  /** Percentage of context window to allocate for user messages */
  userMessagesPercentage: number;

  /** Percentage of context window to allocate for retrieved documents */
  documentsPercentage: number;

  /** Percentage of context window to allocate for response generation */
  responsePercentage: number;

  /** Maximum percentage allocation per document (for truncation) */
  maxPerDocumentPercentage: number;
}

/**
 * Options for creating an LLM client
 */
export interface LlmClientOptions {
  /** Model ID to use */
  modelId: string;

  /** Temperature for sampling (0.0 to 1.0) */
  temperature?: number;

  /** Maximum tokens to generate */
  maxTokens?: number;

  /** Whether to stream the response */
  streaming?: boolean;

  /** Custom provider options */
  providerOptions?: Record<string, any>;
}

/**
 * Token calculation result
 */
export interface TokenLimits {
  /** Maximum context tokens allowed by the model */
  maxContextTokens: number;

  /** Maximum tokens to allocate for the response */
  maxResponseTokens: number;

  /** Maximum tokens to allocate for the system prompt */
  maxSystemPromptTokens?: number;

  /** Maximum tokens to allocate for user messages */
  maxUserMessagesTokens?: number;

  /** Maximum tokens to allocate for documents */
  maxDocumentsTokens?: number;
}

/**
 * Environment variables needed for LLM providers
 */
export interface LlmEnvironment {
  /** OpenAI API key */
  OPENAI_API_KEY?: string;

  /** Anthropic API key */
  ANTHROPIC_API_KEY?: string;

  /** Default model ID to use */
  DEFAULT_MODEL_ID?: string;

  /** Environment name (development, staging, production) */
  ENVIRONMENT?: string;

  /** Workers AI binding for Cloudflare */
  AI?: any;

  /** Any other environment variables */
  [key: string]: any;
}

/**
 * Type guard to check if an object is a valid BaseModelConfig
 */
export function isModelConfig(obj: any): obj is BaseModelConfig {
  return (
    obj &&
    typeof obj.key === 'string' &&
    typeof obj.id === 'string' &&
    typeof obj.name === 'string' &&
    typeof obj.provider === 'string' &&
    typeof obj.maxContextTokens === 'number' &&
    typeof obj.defaultMaxTokens === 'number' &&
    typeof obj.defaultTemperature === 'number' &&
    typeof obj.capabilities === 'object'
  );
}
