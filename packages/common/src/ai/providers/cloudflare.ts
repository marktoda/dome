/**
 * Cloudflare Workers AI model configurations
 *
 * This file defines all Cloudflare Workers AI models available in the system along with
 * their capabilities, context windows, and other parameters.
 */

import { BaseModelConfig, ModelProvider, ModelCapabilities } from '../types.js';

// Common capabilities for Cloudflare LLM models
const CLOUDFLARE_LLM_CAPABILITIES: ModelCapabilities = {
  streaming: true,
  functionCalling: false,
  toolUse: false,
  structuredOutput: false,
  vision: false,
  embeddings: false,
};

// Embedding model capabilities
const CLOUDFLARE_EMBEDDING_CAPABILITIES: ModelCapabilities = {
  streaming: false,
  functionCalling: false,
  toolUse: false,
  structuredOutput: false,
  vision: false,
  embeddings: true,
};

/**
 * Cloudflare Workers AI model configurations
 */
export const CLOUDFLARE_MODELS: Record<string, BaseModelConfig> = {
  // LLMs
  GEMMA_3: {
    key: 'GEMMA_3',
    id: '@cf/google/gemma-3-12b-it',
    name: 'Gemma 3',
    provider: ModelProvider.CLOUDFLARE,
    maxContextTokens: 80000,
    defaultMaxTokens: 1024,
    defaultTemperature: 0.7,
    capabilities: CLOUDFLARE_LLM_CAPABILITIES,
    productionReady: true,
  },

  LLAMA_2_7B: {
    key: 'LLAMA_2_7B',
    id: '@cf/meta/llama-2-7b-chat-int8',
    name: 'Llama 2 7B',
    provider: ModelProvider.CLOUDFLARE,
    maxContextTokens: 4096,
    defaultMaxTokens: 256,
    defaultTemperature: 0.7,
    capabilities: CLOUDFLARE_LLM_CAPABILITIES,
    productionReady: true,
  },

  LLAMA_2_13B: {
    key: 'LLAMA_2_13B',
    id: '@cf/meta/llama-2-13b-chat-int8',
    name: 'Llama 2 13B',
    provider: ModelProvider.CLOUDFLARE,
    maxContextTokens: 4096,
    defaultMaxTokens: 512,
    defaultTemperature: 0.7,
    capabilities: CLOUDFLARE_LLM_CAPABILITIES,
    productionReady: true,
  },

  MISTRAL_7B: {
    key: 'MISTRAL_7B',
    id: '@cf/mistral/mistral-7b-instruct-v0.1',
    name: 'Mistral 7B',
    provider: ModelProvider.CLOUDFLARE,
    maxContextTokens: 8192,
    defaultMaxTokens: 512,
    defaultTemperature: 0.7,
    capabilities: CLOUDFLARE_LLM_CAPABILITIES,
    productionReady: true,
  },

  // Embedding models
  E5_LARGE_V2: {
    key: 'E5_LARGE_V2',
    id: '@cf/baai/bge-large-en-v1.5',
    name: 'E5 Large v2',
    provider: ModelProvider.CLOUDFLARE,
    maxContextTokens: 512,
    defaultMaxTokens: 0,
    defaultTemperature: 0,
    capabilities: CLOUDFLARE_EMBEDDING_CAPABILITIES,
    productionReady: true,
  },

  E5_SMALL_V2: {
    key: 'E5_SMALL_V2',
    id: '@cf/baai/bge-small-en-v1.5',
    name: 'E5 Small v2',
    provider: ModelProvider.CLOUDFLARE,
    maxContextTokens: 512,
    defaultMaxTokens: 0,
    defaultTemperature: 0,
    capabilities: CLOUDFLARE_EMBEDDING_CAPABILITIES,
    productionReady: true,
  },
};

// Export all models as an array
export const CLOUDFLARE_MODELS_ARRAY = Object.values(CLOUDFLARE_MODELS);
