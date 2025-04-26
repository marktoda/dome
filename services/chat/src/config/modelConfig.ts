/**
 * AI Model Configuration
 *
 * This file contains configuration for different AI models,
 * including their context window sizes and other parameters.
 */

/**
 * Model configuration interface
 */
export interface ModelConfig {
  /** Model identifier */
  id: string;
  /** Human-readable name */
  name: string;
  /** Maximum context window size in tokens */
  maxContextTokens: number;
  /** Default maximum tokens for generation */
  defaultMaxTokens: number;
  /** Default temperature */
  defaultTemperature: number;
  /** Whether the model supports streaming */
  supportsStreaming: boolean;
}

/**
 * Available AI models
 */
export const MODELS = {
  // Cloudflare Workers AI models
  LLAMA_3_70B: {
    id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    name: 'Llama 3 70B (Cloudflare Workers AI)',
    maxContextTokens: 24000,
    defaultMaxTokens: 1000,
    defaultTemperature: 0.7,
    supportsStreaming: true,
  },
  LLAMA_3_8B: {
    id: '@cf/meta/llama-3.1-8b-instruct-fp8-fast',
    name: 'Llama 3 8B (Cloudflare Workers AI)',
    maxContextTokens: 16000,
    defaultMaxTokens: 1000,
    defaultTemperature: 0.7,
    supportsStreaming: true,
  },
  // OpenAI models
  GPT_4: {
    id: 'gpt-4-turbo',
    name: 'GPT-4 Turbo',
    maxContextTokens: 128000,
    defaultMaxTokens: 1000,
    defaultTemperature: 0.7,
    supportsStreaming: true,
  },
  GPT_3_5: {
    id: 'gpt-3.5-turbo',
    name: 'GPT-3.5 Turbo',
    maxContextTokens: 16000,
    defaultMaxTokens: 1000,
    defaultTemperature: 0.7,
    supportsStreaming: true,
  },
} as const;

/**
 * Default model to use
 */
export const DEFAULT_MODEL = MODELS.LLAMA_3_70B;

/**
 * Get model configuration by ID
 * @param modelId Model ID
 * @returns Model configuration or default model if not found
 */
export function getModelConfig(modelId?: string): ModelConfig {
  if (!modelId) {
    return DEFAULT_MODEL;
  }

  // Find model by ID
  const model = Object.values(MODELS).find(m => m.id === modelId);
  return model || DEFAULT_MODEL;
}

/**
 * Calculate token limits for context and response
 * @param modelConfig Model configuration
 * @param inputTokens Number of tokens in the input (prompt + messages)
 * @param requestedMaxTokens Requested maximum tokens for response
 * @returns Object with maxContextTokens and maxResponseTokens
 */
export function calculateTokenLimits(
  modelConfig: ModelConfig,
  inputTokens: number,
  requestedMaxTokens?: number,
): { maxContextTokens: number; maxResponseTokens: number } {
  // Reserve tokens for the response
  const defaultMaxTokens = requestedMaxTokens || modelConfig.defaultMaxTokens;

  // Calculate maximum response tokens based on available context window
  // Leave a small buffer (100 tokens) for safety
  const availableTokens = Math.max(500, modelConfig.maxContextTokens - inputTokens - 100);
  const maxResponseTokens = Math.min(defaultMaxTokens, availableTokens);

  return {
    maxContextTokens: modelConfig.maxContextTokens,
    maxResponseTokens,
  };
}
