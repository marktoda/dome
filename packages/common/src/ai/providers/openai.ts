/**
 * OpenAI model configurations
 *
 * This file defines all OpenAI models available in the system along with
 * their capabilities, context windows, and other parameters.
 */

import { BaseModelConfig, ModelProvider, ModelCapabilities } from '../types.js';

// Common capabilities for most OpenAI models
const STANDARD_CAPABILITIES: ModelCapabilities = {
  streaming: true,
  functionCalling: true,
  toolUse: true,
  structuredOutput: true,
  vision: false,
  embeddings: false,
};

// Vision-enabled capabilities
const VISION_CAPABILITIES: ModelCapabilities = {
  ...STANDARD_CAPABILITIES,
  vision: true,
};

/**
 * OpenAI model configurations
 */
export const OPENAI_MODELS: Record<string, BaseModelConfig> = {
  GPT_3_5_TURBO: {
    key: 'GPT_3_5_TURBO',
    id: 'gpt-3.5-turbo',
    name: 'GPT-3.5 Turbo',
    provider: ModelProvider.OPENAI,
    maxContextTokens: 16385,
    defaultMaxTokens: 1024,
    defaultTemperature: 0.7,
    capabilities: STANDARD_CAPABILITIES,
    productionReady: true,
  },

  GPT_3_5_TURBO_16K: {
    key: 'GPT_3_5_TURBO_16K',
    id: 'gpt-3.5-turbo-16k',
    name: 'GPT-3.5 Turbo (16K)',
    provider: ModelProvider.OPENAI,
    maxContextTokens: 16385,
    defaultMaxTokens: 1024,
    defaultTemperature: 0.7,
    capabilities: STANDARD_CAPABILITIES,
    productionReady: true,
  },

  GPT_4: {
    key: 'GPT_4',
    id: 'gpt-4',
    name: 'GPT-4',
    provider: ModelProvider.OPENAI,
    maxContextTokens: 8192,
    defaultMaxTokens: 1024,
    defaultTemperature: 0.7,
    capabilities: STANDARD_CAPABILITIES,
    productionReady: true,
  },

  GPT_4_32K: {
    key: 'GPT_4_32K',
    id: 'gpt-4-32k',
    name: 'GPT-4 (32K)',
    provider: ModelProvider.OPENAI,
    maxContextTokens: 32768,
    defaultMaxTokens: 1024,
    defaultTemperature: 0.7,
    capabilities: STANDARD_CAPABILITIES,
    productionReady: true,
  },

  GPT_4_TURBO: {
    key: 'GPT_4_TURBO',
    id: 'gpt-4-turbo',
    name: 'GPT-4 Turbo',
    provider: ModelProvider.OPENAI,
    maxContextTokens: 128000,
    defaultMaxTokens: 2048,
    defaultTemperature: 0.7,
    capabilities: STANDARD_CAPABILITIES,
    productionReady: true,
  },

  GPT_4_VISION: {
    key: 'GPT_4_VISION',
    id: 'gpt-4-vision-preview',
    name: 'GPT-4 Vision',
    provider: ModelProvider.OPENAI,
    maxContextTokens: 128000,
    defaultMaxTokens: 1024,
    defaultTemperature: 0.7,
    capabilities: VISION_CAPABILITIES,
    productionReady: true,
  },

  GPT_4o: {
    key: 'GPT_4o',
    id: 'gpt-4o',
    name: 'GPT-4',
    provider: ModelProvider.OPENAI,
    maxContextTokens: 128000,
    defaultMaxTokens: 1000,
    defaultTemperature: 0.7,
    capabilities: STANDARD_CAPABILITIES,
    productionReady: true,
  },
};

// Export all models as an array
export const OPENAI_MODELS_ARRAY = Object.values(OPENAI_MODELS);
