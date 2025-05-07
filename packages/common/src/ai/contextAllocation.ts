/**
 * Context Allocation Utilities
 *
 * This module provides utilities for allocating tokens within a model's context window.
 * It helps determine how many tokens to allocate for different components like
 * system prompts, user messages, retrieved documents, and response generation.
 */

import { ContextAllocation, TokenLimits, BaseModelConfig } from './types';
import { modelRegistry } from '.';

/**
 * Default context allocation strategy
 */
export const DEFAULT_CONTEXT_ALLOCATION: ContextAllocation = {
  systemPromptPercentage: 0.15, // 15% for system prompt
  userMessagesPercentage: 0.25, // 25% for user messages
  documentsPercentage: 0.4, // 40% for retrieved documents
  responsePercentage: 0.2, // 20% for response generation
  maxPerDocumentPercentage: 0.15, // Maximum 15% per document
};

/**
 * Safety margin to add to token allocations to prevent hitting exact limits
 */
const TOKEN_SAFETY_MARGIN = 100;

/**
 * Calculate token limits for various components based on model configuration
 * and allocation strategy
 *
 * @param modelConfig Model configuration or model ID string
 * @param allocation Custom context allocation strategy (optional)
 * @returns Object with token limits for different components
 */
export function calculateContextLimits(
  modelConfig: BaseModelConfig | string,
  allocation: Partial<ContextAllocation> = {},
): TokenLimits {
  // Merge custom allocation with defaults
  const alloc: ContextAllocation = {
    ...DEFAULT_CONTEXT_ALLOCATION,
    ...allocation,
  };

  // Get model configuration if string was provided
  const config =
    typeof modelConfig === 'string' ? modelRegistry.getModel(modelConfig) : modelConfig;

  // Calculate token limits for each component
  const maxContextTokens = config.maxContextTokens;

  // Apply safety margin to overall context to prevent edge cases
  const adjustedMaxContext = maxContextTokens - TOKEN_SAFETY_MARGIN;

  // Calculate individual component limits
  const maxSystemPromptTokens = Math.floor(adjustedMaxContext * alloc.systemPromptPercentage);
  const maxUserMessagesTokens = Math.floor(adjustedMaxContext * alloc.userMessagesPercentage);
  const maxDocumentsTokens = Math.floor(adjustedMaxContext * alloc.documentsPercentage);
  const maxResponseTokens = Math.floor(adjustedMaxContext * alloc.responsePercentage);

  // Return the calculated limits
  return {
    maxContextTokens,
    maxResponseTokens,
    maxSystemPromptTokens,
    maxUserMessagesTokens,
    maxDocumentsTokens,
  };
}

/**
 * Calculate the maximum response tokens allowed based on current input tokens
 * and model configuration.
 *
 * @param modelConfig Model configuration or model ID string
 * @param inputTokens Number of tokens in the input (prompt + messages + context)
 * @param requestedMaxTokens Optional requested maximum tokens for the response
 * @returns Maximum response tokens allowed
 */
export function calculateResponseTokens(
  modelConfig: BaseModelConfig | string,
  inputTokens: number,
  requestedMaxTokens?: number,
): number {
  // Get model configuration if string was provided
  const config =
    typeof modelConfig === 'string' ? modelRegistry.getModel(modelConfig) : modelConfig;

  // Use requested max tokens or model default
  const defaultMaxTokens = requestedMaxTokens || config.defaultMaxTokens;

  // Calculate available tokens in the context window
  const availableTokens = Math.max(0, config.maxContextTokens - inputTokens - TOKEN_SAFETY_MARGIN);

  // Return the smaller of the requested/default tokens and available tokens
  return Math.min(defaultMaxTokens, availableTokens);
}

/**
 * Calculate token limits for a model with the current input tokens
 *
 * @param modelConfig Model configuration or model ID string
 * @param inputTokens Number of tokens in the input (prompt + messages + system)
 * @param requestedMaxTokens Optional requested maximum tokens for the response
 * @returns TokenLimits object with calculated limits
 */
export function calculateTokenLimits(
  modelConfig: BaseModelConfig | string,
  inputTokens: number,
  requestedMaxTokens?: number,
): TokenLimits {
  // Get model configuration if string was provided
  const config =
    typeof modelConfig === 'string' ? modelRegistry.getModel(modelConfig) : modelConfig;

  // Calculate response tokens based on input
  const maxResponseTokens = calculateResponseTokens(config, inputTokens, requestedMaxTokens);

  // Return limits
  return {
    maxContextTokens: config.maxContextTokens,
    maxResponseTokens,
  };
}

/**
 * Safely truncate text to fit within a specified token limit
 *
 * @param text Text to truncate
 * @param tokenLimit Maximum tokens allowed
 * @param countTokensFn Function to count tokens in text
 * @returns Truncated text with ellipsis if needed
 */
export function truncateToTokenLimit(
  text: string,
  tokenLimit: number,
  countTokensFn: (text: string) => number,
): string {
  const currentTokens = countTokensFn(text);

  // If already under limit, return as is
  if (currentTokens <= tokenLimit) {
    return text;
  }

  // Calculate approximate character limit
  const avgTokenSize = text.length / currentTokens;
  const approxCharLimit = Math.floor(tokenLimit * avgTokenSize);

  // Truncate with a buffer to ensure we're under the limit
  let truncated = text.slice(0, Math.max(0, approxCharLimit - 10));

  // Add ellipsis
  truncated += '...';

  // Verify we're under the limit
  if (countTokensFn(truncated) > tokenLimit) {
    // If still over limit, recursively truncate more
    return truncateToTokenLimit(
      truncated.slice(0, Math.floor(truncated.length * 0.9)),
      tokenLimit,
      countTokensFn,
    );
  }

  return truncated;
}
