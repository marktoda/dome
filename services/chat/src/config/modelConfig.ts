/**
 * AI Model Configuration
 *
 * This file contains configuration for all AI models used in the system,
 * organized by provider. It includes context window sizes, temperature settings,
 * and other model-specific parameters.
 *
 * This is the single source of truth for all LLM model configurations.
 */

/**
 * Model provider enum
 */
export enum ModelProvider {
  OPENAI = 'openai',
  CLOUDFLARE = 'cloudflare',
  ANTHROPIC = 'anthropic',
}

/**
 * Model capability flags
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
 * Model configuration interface
 */
export interface ModelConfig {
  /** Model identifier used when making API calls */
  id: string;
  /** Human-readable name */
  name: string;
  /** Model provider */
  provider: ModelProvider;
  /** Maximum context window size in tokens */
  maxContextTokens: number;
  /** Default maximum tokens for generation */
  defaultMaxTokens: number;
  /** Default temperature */
  defaultTemperature: number;
  /** Model capabilities */
  capabilities: ModelCapabilities;
  /** Whether to make this model available in production */
  productionReady?: boolean;
}

/**
 * All available AI models grouped by provider
 */
export const MODELS = {
  // OpenAI models
  OPENAI: {
    GPT_4_TURBO: {
      id: 'gpt-4-turbo',
      name: 'GPT-4 Turbo',
      provider: ModelProvider.OPENAI,
      maxContextTokens: 128000,
      defaultMaxTokens: 1000,
      defaultTemperature: 0.7,
      capabilities: {
        streaming: true,
        functionCalling: true,
        toolUse: true,
        structuredOutput: true,
        vision: false,
      },
      productionReady: true,
    },
    GPT_4o: {
      id: 'gpt-4o',
      name: 'GPT-4',
      provider: ModelProvider.OPENAI,
      maxContextTokens: 128000,
      defaultMaxTokens: 1000,
      defaultTemperature: 0.7,
      capabilities: {
        streaming: true,
        functionCalling: true,
        toolUse: true,
        structuredOutput: true,
        vision: false,
      },
      productionReady: true,
    },
    GPT_3_5_TURBO: {
      id: 'gpt-3.5-turbo',
      name: 'GPT-3.5 Turbo',
      provider: ModelProvider.OPENAI,
      maxContextTokens: 16000,
      defaultMaxTokens: 1000,
      defaultTemperature: 0.7,
      capabilities: {
        streaming: true,
        functionCalling: true,
        toolUse: true,
        structuredOutput: true,
        vision: false,
      },
      productionReady: true,
    },
  },

  // Cloudflare Workers AI models
  CLOUDFLARE: {
    LLAMA_3_70B: {
      id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
      name: 'Llama 3 70B (Cloudflare Workers AI)',
      provider: ModelProvider.CLOUDFLARE,
      maxContextTokens: 24000,
      defaultMaxTokens: 1000,
      defaultTemperature: 0.7,
      capabilities: {
        streaming: true,
        functionCalling: false,
        toolUse: false,
        structuredOutput: false,
        vision: false,
      },
      productionReady: true,
    },
    LLAMA_3_8B: {
      id: '@cf/meta/llama-3.1-8b-instruct-fp8-fast',
      name: 'Llama 3 8B (Cloudflare Workers AI)',
      provider: ModelProvider.CLOUDFLARE,
      maxContextTokens: 16000,
      defaultMaxTokens: 1000,
      defaultTemperature: 0.7,
      capabilities: {
        streaming: true,
        functionCalling: false,
        toolUse: false,
        structuredOutput: false,
        vision: false,
      },
      productionReady: true,
    },
  },

  // Anthropic models
  ANTHROPIC: {
    CLAUDE_3_OPUS: {
      id: 'claude-3-opus-20240229',
      name: 'Claude 3 Opus',
      provider: ModelProvider.ANTHROPIC,
      maxContextTokens: 200000,
      defaultMaxTokens: 1000,
      defaultTemperature: 0.7,
      capabilities: {
        streaming: true,
        functionCalling: true,
        toolUse: true,
        structuredOutput: true,
        vision: true,
      },
      productionReady: false, // Set to true when integration is ready
    },
    CLAUDE_3_SONNET: {
      id: 'claude-3-sonnet-20240229',
      name: 'Claude 3 Sonnet',
      provider: ModelProvider.ANTHROPIC,
      maxContextTokens: 200000,
      defaultMaxTokens: 1000,
      defaultTemperature: 0.7,
      capabilities: {
        streaming: true,
        functionCalling: true,
        toolUse: true,
        structuredOutput: true,
        vision: true,
      },
      productionReady: false, // Set to true when integration is ready
    },
  },
} as const;

/**
 * Type for model identifiers
 */
export type ModelId = keyof typeof MODELS.OPENAI | keyof typeof MODELS.CLOUDFLARE | keyof typeof MODELS.ANTHROPIC;

/**
 * Get the default model configuration based on environment or settings
 * Falls back to GPT-4 Turbo if not specified
 *
 * @param modelKey Optional model key to use as default
 * @returns The model configuration to use as default
 */
export function getDefaultModel(modelKey?: string): ModelConfig {
  // If a specific model key is provided, try to use it
  if (modelKey) {
    // First check OpenAI models
    if (modelKey in MODELS.OPENAI) {
      return MODELS.OPENAI[modelKey as keyof typeof MODELS.OPENAI];
    }

    // Then check Cloudflare models
    if (modelKey in MODELS.CLOUDFLARE) {
      return MODELS.CLOUDFLARE[modelKey as keyof typeof MODELS.CLOUDFLARE];
    }

    // Then check Anthropic models
    if (modelKey in MODELS.ANTHROPIC) {
      return MODELS.ANTHROPIC[modelKey as keyof typeof MODELS.ANTHROPIC];
    }
  }

  // Fall back to GPT-4 Turbo
  return MODELS.OPENAI.GPT_4o;
}

/**
 * Default model to use
 * Note: To be configured with environment variables when the service starts
 */
export const DEFAULT_MODEL = getDefaultModel();

/**
 * Configure the default model based on environment variables
 * This should be called during service initialization
 *
 * @param env Environment object containing the DEFAULT_MODEL_ID
 */
export function configureDefaultModel(env: Record<string, unknown>): void {
  // This function should be called during service initialization
  // to set the default model based on environment variables
  if (env.DEFAULT_MODEL_ID && typeof env.DEFAULT_MODEL_ID === 'string') {
    // Update the exported DEFAULT_MODEL
    Object.assign(DEFAULT_MODEL, getDefaultModel(env.DEFAULT_MODEL_ID));
  }
}

/**
 * Get a flat array of all available models
 * @param productionOnly Only include production-ready models if true
 */
export function getAllModels(productionOnly = false): ModelConfig[] {
  const allModels = [
    ...Object.values(MODELS.OPENAI),
    ...Object.values(MODELS.CLOUDFLARE),
    ...Object.values(MODELS.ANTHROPIC),
  ];

  return productionOnly
    ? allModels.filter(model => model.productionReady)
    : allModels;
}

/**
 * Get model configuration by ID
 * @param modelId Model ID (API identifier)
 * @returns Model configuration or default model if not found
 */
export function getModelConfig(modelId?: string): ModelConfig {
  if (!modelId) {
    return DEFAULT_MODEL;
  }

  // Search through all models across providers
  const allModels = getAllModels();
  const model = allModels.find(m => m.id === modelId);
  return model || DEFAULT_MODEL;
}

/**
 * Get model configuration by internal key
 * @param modelKey Internal model key (e.g., 'GPT_4_TURBO')
 * @returns Model configuration or default model if not found
 */
export function getModelByKey(modelKey: string): ModelConfig {
  // Check each provider's models
  for (const provider of Object.values(MODELS)) {
    if (modelKey in provider) {
      return provider[modelKey as keyof typeof provider];
    }
  }

  return DEFAULT_MODEL;
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
