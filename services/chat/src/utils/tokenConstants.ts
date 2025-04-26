/**
 * Constants for token counting and management
 */

/**
 * Average number of characters per token (used for approximation)
 * This is a rough approximation used when tiktoken is not available
 */
export const CHARS_PER_TOKEN = 4;

/**
 * Tokens added for message format (role, etc.)
 * This is an approximation and may vary by model
 */
export const MESSAGE_FORMAT_TOKENS = 4;

/**
 * Default maximum tokens for document truncation
 */
export const DEFAULT_MAX_DOC_TOKENS = 1000;

/**
 * Default maximum tokens for all documents combined
 */
export const DEFAULT_MAX_TOTAL_DOC_TOKENS = 15000;

/**
 * Approximate tokens for document metadata
 */
export const DOC_METADATA_TOKENS = 50;

/**
 * Calculate approximate token count from character length
 * @param text The text to count tokens for
 * @returns Approximate token count
 */
export function approximateTokenCount(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}
