/**
 * LLM Configuration System
 *
 * This is the main entry point for the LLM configuration system.
 * It provides a unified API for:
 * - Getting model configurations
 * - Initializing models from environment variables
 * - Calculating token limits
 * - Managing context allocation
 *
 * This system serves as a single source of truth for all LLM model
 * configurations across different services.
 */

import { getLogger } from '../context/index.js';
import { ModelRegistry } from './modelRegistry.js';
import { ALL_MODELS_ARRAY, MODELS } from './providers/index.js';
import {
  BaseModelConfig,
  ContextAllocation,
  LlmEnvironment,
  ModelProvider,
  TokenLimits,
} from './types.js';
import {
  DEFAULT_CONTEXT_ALLOCATION,
  calculateContextLimits,
  calculateResponseTokens,
  calculateTokenLimits,
  truncateToTokenLimit,
} from './contextAllocation.js';

const logger = getLogger().child({ component: 'LlmConfigSystem' });

const defaultModelRegistry = new ModelRegistry(ALL_MODELS_ARRAY);

/**
 * Get a model configuration by key or ID
 * @param keyOrId Optional model key or ID to retrieve
 * @returns Model configuration (default model if keyOrId not provided)
 */
export function getModelConfig(keyOrId?: string): BaseModelConfig {
  return defaultModelRegistry.getModel(keyOrId);
}

/**
 * Get all available models
 * @param productionOnly Only include production-ready models if true
 * @returns Array of model configurations
 */
export function getAllModels(productionOnly = false): BaseModelConfig[] {
  return defaultModelRegistry.getAll(productionOnly);
}

/**
 * Get models for a specific provider
 * @param provider Provider to get models for
 * @returns Array of model configurations for the specified provider
 */
export function getProviderModels(provider: ModelProvider): BaseModelConfig[] {
  return defaultModelRegistry.getByProvider(provider);
}

/**
 * Get the default model configuration
 * @returns Default model configuration
 */
export function getDefaultModel(): BaseModelConfig {
  return defaultModelRegistry.getDefaultModel();
}

/**
 * Get a flat map of all model IDs to their configurations
 * Useful for quick lookups by model ID
 * @returns Record mapping model IDs to their configurations
 */
export function getModelIdMap(): Record<string, BaseModelConfig> {
  const models = defaultModelRegistry.getAll();
  return models.reduce((acc, model) => {
    acc[model.id] = model;
    return acc;
  }, {} as Record<string, BaseModelConfig>);
}

// Import tokenizer functions
import { countTokens, countMessageTokens, countMessagesTokens } from './tokenizer.js';

// Export everything from this module
export {
  BaseModelConfig,
  ContextAllocation,
  LlmEnvironment,
  ModelProvider,
  TokenLimits,
  MODELS,
  DEFAULT_CONTEXT_ALLOCATION,
  calculateContextLimits,
  calculateResponseTokens,
  calculateTokenLimits,
  truncateToTokenLimit,

  // Export tokenizer functions
  countTokens,
  countMessageTokens,
  countMessagesTokens,
};

// Export the model registry for advanced use cases
export { defaultModelRegistry as modelRegistry, ModelRegistry };

// Re-export everything from providers
export * from './providers/index.js';

export * from './modelChooser.js';
export * from './contextUtils.js';
