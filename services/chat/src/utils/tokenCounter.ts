import { encoding_for_model } from '@dqbd/tiktoken';
import { logError } from '@dome/logging';
import { CHARS_PER_TOKEN, MESSAGE_FORMAT_TOKENS, approximateTokenCount } from './tokenConstants';

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
    if (
      typeof globalThis.WorkerGlobalScope !== 'undefined' &&
      globalThis instanceof WorkerGlobalScope
    ) {
      // We're in a Cloudflare Worker, use the fallback method
      return approximateTokenCount(text);
    }

    // @ts-ignore - Ignoring type errors for now to make progress
    const encoder = encoding_for_model(model as any);
    const tokens = encoder.encode(text);
    encoder.free();
    return tokens.length;
  } catch (error) {
    // Don't log the full error as it's expected in some environments
    logError(error, 'Error counting tokens, falling back to approximate count');
    // Fallback to approximate count
    return approximateTokenCount(text);
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
  return contentTokens + MESSAGE_FORMAT_TOKENS;
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

/**
 * Estimate token count for a document
 * @param doc Document object with title and body
 * @returns Estimated token count
 */
export function estimateDocumentTokens(doc: { title: string; body: string }): number {
  return approximateTokenCount(doc.title + ' ' + doc.body);
}
