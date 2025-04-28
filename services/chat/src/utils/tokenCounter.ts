import { encoding_for_model } from '@dqbd/tiktoken';
import { getLogger, logError } from '@dome/logging';
import { CHARS_PER_TOKEN, MESSAGE_FORMAT_TOKENS, approximateTokenCount } from './tokenConstants';

// Track if we've already logged the tokenizer error to avoid flooding logs
let hasLoggedTokenizerError = false;

/**
 * Detect if we're in a Cloudflare Workers environment
 * This needs to be robust to handle various ways the environment might be identified
 */
function isCloudflareWorkersEnvironment(): boolean {
  return (
    // Standard check for Cloudflare Workers
    (typeof globalThis.WorkerGlobalScope !== 'undefined' &&
     globalThis instanceof WorkerGlobalScope) ||
    // Check for Cloudflare Workers specific globals
    typeof globalThis.caches !== 'undefined' ||
    // WebAssembly support check - another indicator we might be in a restricted environment
    typeof WebAssembly === 'undefined' ||
    // Check if we're in an environment where wasm functions might be missing
    // This addresses the TypeError: wasm.__wbindgen_add_to_stack_pointer is not a function
    (typeof WebAssembly !== 'undefined' && typeof WebAssembly.instantiate === 'undefined')
  );
}

/**
 * Count the number of tokens in a string using tiktoken
 * @param text The text to count tokens for
 * @param model The model to use for token counting (default: gpt-4)
 * @returns The number of tokens
 */
export function countTokens(text: string, model = 'gpt-4'): number {
  if (!text) return 0;

  // First check if we're in a Cloudflare Workers environment
  if (isCloudflareWorkersEnvironment()) {
    // We're in a Cloudflare Worker or restricted environment, use the fallback method
    return approximateTokenCount(text);
  }

  try {
    // @ts-ignore - Ignoring type errors for now to make progress
    const encoder = encoding_for_model(model as any);
    const tokens = encoder.encode(text);
    encoder.free();
    return tokens.length;
  } catch (error) {
    // Only log the first occurrence to avoid flooding logs
    if (!hasLoggedTokenizerError) {
      // Use warning level instead of error since we have a fallback
      const logger = getLogger();
      logger.warn({ error }, 'WebAssembly tokenizer failed, using approximate token count fallback');
      hasLoggedTokenizerError = true;
    }
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
