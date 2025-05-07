/**
 * Model Providers Index
 *
 * This file consolidates all model configurations from different providers
 * and exports them as a unified collection.
 */

import { OPENAI_MODELS, OPENAI_MODELS_ARRAY } from './openai';
import { ANTHROPIC_MODELS, ANTHROPIC_MODELS_ARRAY } from './anthropic';
import { CLOUDFLARE_MODELS, CLOUDFLARE_MODELS_ARRAY } from './cloudflare';
import { BaseModelConfig } from '../types';

/**
 * All available AI models grouped by provider
 */
export const MODELS = {
  OPENAI: OPENAI_MODELS,
  ANTHROPIC: ANTHROPIC_MODELS,
  CLOUDFLARE: CLOUDFLARE_MODELS,
};

/**
 * All available models as a flat array
 */
export const ALL_MODELS_ARRAY: BaseModelConfig[] = [
  ...OPENAI_MODELS_ARRAY,
  ...ANTHROPIC_MODELS_ARRAY,
  ...CLOUDFLARE_MODELS_ARRAY,
];

// Export all provider-specific models
export * from './openai';
export * from './anthropic';
export * from './cloudflare';
