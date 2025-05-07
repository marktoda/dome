/**
 * Anthropic model configurations
 *
 * This file defines all Anthropic (Claude) models available in the system along with
 * their capabilities, context windows, and other parameters.
 */

import { BaseModelConfig, ModelProvider, ModelCapabilities } from '../types';

// Common capabilities for Claude models
const CLAUDE_CAPABILITIES: ModelCapabilities = {
  streaming: true,
  functionCalling: false,
  toolUse: false,
  structuredOutput: true,
  vision: false,
  embeddings: false,
};

// Claude 3 Opus capabilities
const CLAUDE_3_CAPABILITIES: ModelCapabilities = {
  ...CLAUDE_CAPABILITIES,
  functionCalling: true,
  toolUse: true,
};

// Claude Vision capabilities
const CLAUDE_VISION_CAPABILITIES: ModelCapabilities = {
  ...CLAUDE_3_CAPABILITIES,
  vision: true,
};

/**
 * Anthropic model configurations
 */
export const ANTHROPIC_MODELS: Record<string, BaseModelConfig> = {
  CLAUDE_2: {
    key: 'CLAUDE_2',
    id: 'claude-2',
    name: 'Claude 2',
    provider: ModelProvider.ANTHROPIC,
    maxContextTokens: 100000,
    defaultMaxTokens: 1024,
    defaultTemperature: 0.7,
    capabilities: CLAUDE_CAPABILITIES,
    productionReady: true,
  },

  CLAUDE_2_1: {
    key: 'CLAUDE_2_1',
    id: 'claude-2.1',
    name: 'Claude 2.1',
    provider: ModelProvider.ANTHROPIC,
    maxContextTokens: 200000,
    defaultMaxTokens: 1024,
    defaultTemperature: 0.7,
    capabilities: CLAUDE_CAPABILITIES,
    productionReady: true,
  },

  CLAUDE_3_OPUS: {
    key: 'CLAUDE_3_OPUS',
    id: 'claude-3-opus-20240229',
    name: 'Claude 3 Opus',
    provider: ModelProvider.ANTHROPIC,
    maxContextTokens: 200000,
    defaultMaxTokens: 4096,
    defaultTemperature: 0.7,
    capabilities: CLAUDE_VISION_CAPABILITIES,
    productionReady: true,
  },

  CLAUDE_3_SONNET: {
    key: 'CLAUDE_3_SONNET',
    id: 'claude-3-sonnet-20240229',
    name: 'Claude 3 Sonnet',
    provider: ModelProvider.ANTHROPIC,
    maxContextTokens: 200000,
    defaultMaxTokens: 4096,
    defaultTemperature: 0.7,
    capabilities: CLAUDE_VISION_CAPABILITIES,
    productionReady: true,
  },

  CLAUDE_3_HAIKU: {
    key: 'CLAUDE_3_HAIKU',
    id: 'claude-3-haiku-20240307',
    name: 'Claude 3 Haiku',
    provider: ModelProvider.ANTHROPIC,
    maxContextTokens: 200000,
    defaultMaxTokens: 4096,
    defaultTemperature: 0.7,
    capabilities: CLAUDE_VISION_CAPABILITIES,
    productionReady: true,
  },
};

// Export all models as an array
export const ANTHROPIC_MODELS_ARRAY = Object.values(ANTHROPIC_MODELS);
