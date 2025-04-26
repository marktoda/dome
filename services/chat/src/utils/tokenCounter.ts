import { encoding_for_model } from '@dqbd/tiktoken';
import { logError } from '@dome/logging';

/**
 * Count the number of tokens in a string using tiktoken
 * @param text The text to count tokens for
 * @param model The model to use for token counting (default: gpt-4)
 * @returns The number of tokens
 */
export function countTokens(text: string, model = 'gpt-4'): number {
  if (!text) return 0;

  try {
    // Skip tiktoken in Cloudflare Workers environment due to WebAssembly compatibility issues
    if (typeof globalThis.WorkerGlobalScope !== 'undefined' && globalThis instanceof WorkerGlobalScope) {
      // We're in a Cloudflare Worker, use the fallback method
      return Math.ceil(text.length / 4);
    }

    // @ts-ignore - Ignoring type errors for now to make progress
    const encoder = encoding_for_model(model as any);
    const tokens = encoder.encode(text);
    encoder.free();
    return tokens.length;
  } catch (error) {
    // Don't log the full error as it's expected in some environments
    logError(error, 'Error counting tokens, falling back to approximate count');
    // Fallback to approximate count (roughly 4 characters per token)
    return Math.ceil(text.length / 4);
  }
}

/**
 * Count tokens in a message object
 * @param message The message to count tokens for
 * @param model The model to use for token counting
 * @returns The number of tokens
 */
export function countMessageTokens(
  message: { role: string; content: string },
  model = 'gpt-4',
): number {
  // Count tokens in the message content
  const contentTokens = countTokens(message.content, model);

  // Add tokens for message format (role, etc.)
  // This is an approximation and may vary by model
  const formatTokens = 4; // ~4 tokens for role formatting

  return contentTokens + formatTokens;
}

/**
 * Count tokens in an array of messages
 * @param messages The messages to count tokens for
 * @param model The model to use for token counting
 * @returns The total number of tokens
 */
export function countMessagesTokens(
  messages: Array<{ role: string; content: string }>,
  model = 'gpt-4',
): number {
  if (!messages || messages.length === 0) return 0;

  // Sum tokens for all messages
  return messages.reduce((total, message) => total + countMessageTokens(message, model), 0);
}
