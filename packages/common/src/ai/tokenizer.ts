/**
 * Tokenization utilities for LLMs
 * 
 * This module provides utilities for counting tokens in text for various LLM models.
 * It uses tiktoken for OpenAI models and provides estimates for other models.
 */

import { getLogger } from '../context';

const logger = getLogger().child({ component: 'Tokenizer' });

// Mapping of model families to their encoding names for tiktoken
const MODEL_ENCODING_MAP: Record<string, string> = {
  'gpt-3.5': 'cl100k_base',
  'gpt-4': 'cl100k_base',
  'claude': 'cl100k_base', // using OpenAI's encoding as an approximation
  'llama': 'cl100k_base',   // using OpenAI's encoding as an approximation
  'mistral': 'cl100k_base', // using OpenAI's encoding as an approximation
};

/**
 * Get the appropriate encoding name for tiktoken based on model ID
 * @param modelId Model ID
 * @returns Encoding name for tiktoken
 */
function getEncodingForModel(modelId: string): string {
  // Default to cl100k_base (GPT-4) encoding
  let encodingName = 'cl100k_base';
  
  // Match model ID to a known family
  for (const [family, encoding] of Object.entries(MODEL_ENCODING_MAP)) {
    if (modelId.includes(family)) {
      encodingName = encoding;
      break;
    }
  }
  
  return encodingName;
}

/**
 * Estimate token count based on character count
 * This is a fallback method when tiktoken is not available
 * @param text Text to count tokens for
 * @returns Estimated token count
 */
function estimateTokenCount(text: string): number {
  // A reasonable approximation is 1 token ≈ 4 characters for English text
  const estimatedTokens = Math.ceil(text.length / 4);
  return estimatedTokens;
}

/**
 * Count tokens in text for a specific model
 * @param text Text to count tokens for
 * @param modelId Model ID to use for tokenization
 * @returns Number of tokens
 */
export function countTokens(text: string, modelId = 'gpt-4'): number {
  if (!text) return 0;
  
  try {
    // Try to use tiktoken if available (in Node.js environment)
    // Check for Node.js environment in a way that works with TypeScript
    if (typeof process !== 'undefined' && process.versions && process.versions.node) {
      try {
        // Dynamic import to avoid bundling issues
        const { encoding_for_model } = require('@dqbd/tiktoken');
        
        // Get the appropriate encoding for the model
        const encodingName = getEncodingForModel(modelId);
        const encoder = encoding_for_model(encodingName as any);
        const tokens = encoder.encode(text);
        
        return tokens.length;
      } catch (error) {
        logger.warn(
          { error: (error as Error).message },
          'Failed to use tiktoken, falling back to estimation'
        );
        return estimateTokenCount(text);
      }
    }
    
    // If in browser or tiktoken failed, use estimation
    return estimateTokenCount(text);
  } catch (error) {
    logger.warn(
      { error: (error as Error).message },
      'Error counting tokens, using estimation'
    );
    return estimateTokenCount(text);
  }
}

/**
 * Count tokens in a message object for a specific model
 * @param message Message object with role and content
 * @param modelId Model ID to use for tokenization
 * @returns Number of tokens
 */
export function countMessageTokens(
  message: { role: string; content: string },
  modelId = 'gpt-4',
): number {
  // Count tokens in the message content
  const contentTokens = countTokens(message.content, modelId);
  
  // Add tokens for role formatting (approximate)
  // Different models have different message formatting
  const roleFormatTokens = 4; // A reasonable approximation for most models
  
  return contentTokens + roleFormatTokens;
}

/**
 * Count tokens in an array of messages for a specific model
 * @param messages Array of messages
 * @param modelId Model ID to use for tokenization
 * @returns Total number of tokens
 */
export function countMessagesTokens(
  messages: Array<{ role: string; content: string }>,
  modelId = 'gpt-4',
): number {
  if (!messages || messages.length === 0) return 0;
  
  // Sum tokens for all messages
  return messages.reduce((total, message) => total + countMessageTokens(message, modelId), 0);
}