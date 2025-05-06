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

import { getLogger } from '../context';
import { modelRegistry } from './modelRegistry';
import { ALL_MODELS_ARRAY, MODELS } from './providers';
import {
  BaseModelConfig,
  ContextAllocation,
  LlmEnvironment,
  ModelProvider,
  TokenLimits,
} from './types';
import {
  DEFAULT_CONTEXT_ALLOCATION,
  calculateContextLimits,
  calculateResponseTokens,
  calculateTokenLimits,
  truncateToTokenLimit,
} from './contextAllocation';

const logger = getLogger().child({ component: 'LlmConfigSystem' });

/**
 * Initialize the LLM configuration system with all predefined models
 * This function must be called before using any other functions in this module
 */
export function initializeLlmConfig(): void {
  // Register all models from all providers
  modelRegistry.registerMany(ALL_MODELS_ARRAY);
  
  logger.debug(
    { modelCount: ALL_MODELS_ARRAY.length },
    'LLM Configuration System initialized with predefined models'
  );
}

/**
 * Configure the LLM system based on environment variables
 * @param env Environment variables
 */
export function configureLlmSystem(env: LlmEnvironment): void {
  // Set default model if specified in environment
  if (env.DEFAULT_MODEL_ID && typeof env.DEFAULT_MODEL_ID === 'string') {
    try {
      modelRegistry.setDefaultModel(env.DEFAULT_MODEL_ID);
      logger.info(
        { modelId: env.DEFAULT_MODEL_ID },
        'Default LLM model configured from environment'
      );
    } catch (error) {
      logger.warn(
        { modelId: env.DEFAULT_MODEL_ID, error },
        'Failed to set default model from environment, using fallback'
      );
    }
  }
}

/**
 * Get a model configuration by key or ID
 * @param keyOrId Optional model key or ID to retrieve
 * @returns Model configuration (default model if keyOrId not provided)
 */
export function getModelConfig(keyOrId?: string): BaseModelConfig {
  return modelRegistry.getModel(keyOrId);
}

/**
 * Get all available models
 * @param productionOnly Only include production-ready models if true
 * @returns Array of model configurations
 */
export function getAllModels(productionOnly = false): BaseModelConfig[] {
  return modelRegistry.getAll(productionOnly);
}

/**
 * Get models for a specific provider
 * @param provider Provider to get models for
 * @returns Array of model configurations for the specified provider
 */
export function getProviderModels(provider: ModelProvider): BaseModelConfig[] {
  return modelRegistry.getByProvider(provider);
}

/**
 * Get the default model configuration
 * @returns Default model configuration
 */
export function getDefaultModel(): BaseModelConfig {
  return modelRegistry.getDefaultModel();
}

/**
 * Get a flat map of all model IDs to their configurations
 * Useful for quick lookups by model ID
 * @returns Record mapping model IDs to their configurations
 */
export function getModelIdMap(): Record<string, BaseModelConfig> {
  const models = modelRegistry.getAll();
  return models.reduce((acc, model) => {
    acc[model.id] = model;
    return acc;
  }, {} as Record<string, BaseModelConfig>);
}

// Initialize the LLM configuration system immediately
initializeLlmConfig();

// Import tokenizer functions
import { countTokens, countMessageTokens, countMessagesTokens } from './tokenizer';

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
export { modelRegistry };

// Re-export everything from providers
export * from './providers';