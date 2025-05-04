/**
 * Context Window Configuration
 *
 * This file defines constants and utilities for managing context windows and token limits
 * across different parts of the application.
 * 
 * It centralizes the context allocation strategies to ensure consistency and proper use
 * of available token budget based on the selected model.
 */

import { ModelConfig, getModelConfig } from './modelConfig';

/**
 * Context allocation configuration
 * Defines how much of the model's context window should be allocated to different components
 */
export interface ContextAllocation {
  /** Maximum percentage of context window for all documents (0-1) */
  maxDocumentsPercentage: number;
  
  /** Maximum percentage of context window per individual document (0-1) */
  maxPerDocumentPercentage: number;
  
  /** Percentage of context window to reserve for the response (0-1) */
  responseReservePercentage: number;
  
  /** Percentage of context window to reserve for the system prompt (0-1) */
  systemPromptPercentage: number;
  
  /** Percentage of context window to reserve for chat history (0-1) */
  chatHistoryPercentage: number;
  
  /** Buffer tokens to ensure we don't exceed context window (fixed token count) */
  safetyBufferTokens: number;
}

/**
 * Default context allocation strategy
 */
export const DEFAULT_CONTEXT_ALLOCATION: ContextAllocation = {
  maxDocumentsPercentage: 0.5,      // 50% of context window for all documents
  maxPerDocumentPercentage: 0.1,    // 10% of context window per document
  responseReservePercentage: 0.25,  // 25% of context window for response
  systemPromptPercentage: 0.15,     // 15% of context window for system prompt
  chatHistoryPercentage: 0.3,       // 30% of context window for chat history
  safetyBufferTokens: 100,          // 100 tokens buffer for safety
};

/**
 * Calculates token limits for various components based on model configuration and allocation strategy
 * 
 * @param modelConfig Model configuration or model ID
 * @param allocation Context allocation strategy (optional, defaults to DEFAULT_CONTEXT_ALLOCATION)
 * @returns Token limits for different components
 */
export function calculateContextLimits(
  modelConfig: ModelConfig | string,
  allocation: Partial<ContextAllocation> = {},
): {
  maxContextTokens: number;
  maxDocumentsTokens: number;
  maxPerDocumentTokens: number;
  maxResponseTokens: number;
  maxSystemPromptTokens: number;
  maxChatHistoryTokens: number;
} {
  // Get the model configuration if string was provided
  const config = typeof modelConfig === 'string' ? getModelConfig(modelConfig) : modelConfig;
  
  // Merge with default allocation
  const alloc = { ...DEFAULT_CONTEXT_ALLOCATION, ...allocation };
  
  // Get the total context window size
  const maxContextTokens = config.maxContextTokens;
  
  // Calculate token limits for different components
  const maxDocumentsTokens = Math.floor(maxContextTokens * alloc.maxDocumentsPercentage);
  const maxPerDocumentTokens = Math.floor(maxContextTokens * alloc.maxPerDocumentPercentage);
  const maxResponseTokens = Math.floor(maxContextTokens * alloc.responseReservePercentage);
  const maxSystemPromptTokens = Math.floor(maxContextTokens * alloc.systemPromptPercentage);
  const maxChatHistoryTokens = Math.floor(maxContextTokens * alloc.chatHistoryPercentage);
  
  return {
    maxContextTokens,
    maxDocumentsTokens,
    maxPerDocumentTokens,
    maxResponseTokens,
    maxSystemPromptTokens,
    maxChatHistoryTokens,
  };
}

/**
 * Calculates token limits for response based on current input token count
 * 
 * @param modelConfig Model configuration or model ID
 * @param inputTokens Current input tokens (prompt + messages + context)
 * @param requestedMaxTokens Optional requested max tokens for response
 * @param bufferTokens Optional safety buffer (defaults to DEFAULT_CONTEXT_ALLOCATION.safetyBufferTokens)
 * @returns Maximum tokens for response
 */
export function calculateResponseTokens(
  modelConfig: ModelConfig | string,
  inputTokens: number,
  requestedMaxTokens?: number,
  bufferTokens?: number,
): number {
  // Get the model configuration if string was provided
  const config = typeof modelConfig === 'string' ? getModelConfig(modelConfig) : modelConfig;
  
  // Use requested max tokens or model default
  const defaultMaxTokens = requestedMaxTokens || config.defaultMaxTokens;
  
  // Use provided buffer or default
  const buffer = bufferTokens ?? DEFAULT_CONTEXT_ALLOCATION.safetyBufferTokens;
  
  // Calculate available tokens for response
  const availableTokens = Math.max(
    500, // Minimum reasonable response size
    config.maxContextTokens - inputTokens - buffer
  );
  
  // Return the smaller of default or available tokens
  return Math.min(defaultMaxTokens, availableTokens);
}

/**
 * Dynamically allocates tokens for different components based on a fixed input budget
 * Useful when you need to fit components within a specific token limit
 * 
 * @param totalBudget Total token budget available
 * @param components Object defining the components and their weights
 * @returns Object with the same keys but with allocated token values
 */
export function allocateTokenBudget<T extends Record<string, number>>(
  totalBudget: number,
  components: T
): { [K in keyof T]: number } {
  // Calculate total weight
  const totalWeight = Object.values(components).reduce((sum, weight) => sum + weight, 0);
  
  // Allocate tokens based on weights
  const result = {} as { [K in keyof T]: number };
  
  for (const [key, weight] of Object.entries(components)) {
    result[key as keyof T] = Math.floor((weight / totalWeight) * totalBudget);
  }
  
  return result;
}