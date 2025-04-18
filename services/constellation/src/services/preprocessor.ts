/**
 * Text Preprocessing Service
 *
 * Handles text chunking and preparation for embedding.
 */

import { logger } from '../utils/logging';

/**
 * Configuration for text preprocessing
 */
export interface PreprocessorConfig {
  maxChunkSize: number;
  overlapSize: number;
  minChunkSize: number;
}

/**
 * Default configuration values
 */
export const DEFAULT_PREPROCESSOR_CONFIG: PreprocessorConfig = {
  maxChunkSize: 8000, // Maximum characters per chunk (Workers AI limit)
  overlapSize: 200, // Character overlap between chunks
  minChunkSize: 100, // Minimum chunk size to process
};

/**
 * Preprocessor service for text normalization and chunking
 */
export class TextPreprocessor {
  private config: PreprocessorConfig;

  constructor(config: Partial<PreprocessorConfig> = {}) {
    this.config = {
      ...DEFAULT_PREPROCESSOR_CONFIG,
      ...config,
    };
  }

  /**
   * Normalize text by removing excessive whitespace and special characters
   * @param text Raw text to normalize
   * @returns Normalized text
   */
  public normalize(text: string): string {
    if (!text) {
      logger.warn('Empty text provided for normalization');
      return '';
    }

    // Trim whitespace
    let normalized = text.trim();

    // Replace multiple spaces with a single space
    normalized = normalized.replace(/\s+/g, ' ');

    // Replace multiple newlines with a single newline
    normalized = normalized.replace(/\n+/g, '\n');

    // Remove special characters that might affect embedding quality
    normalized = normalized.replace(/[^\w\s.,?!;:()\[\]{}"'`-]/g, ' ');

    return normalized;
  }

  /**
   * Split text into chunks of appropriate size for embedding
   * @param text Text to chunk
   * @returns Array of text chunks
   */
  public chunk(text: string): string[] {
    if (!text) {
      logger.warn('Empty text provided for chunking');
      return [];
    }

    const normalized = this.normalize(text);

    // If text is smaller than max chunk size, return as single chunk
    if (normalized.length <= this.config.maxChunkSize) {
      return [normalized];
    }

    const chunks: string[] = [];
    let startPos = 0;

    while (startPos < normalized.length) {
      // Calculate end position for this chunk
      let endPos = startPos + this.config.maxChunkSize;

      // If we're not at the end of the text, try to find a natural break point
      if (endPos < normalized.length) {
        // Look for natural break points: sentence end, paragraph, etc.
        const breakPoints = ['. ', '! ', '? ', '\n\n', '\n'];

        // Try each break point type, starting from the most preferred
        for (const breakPoint of breakPoints) {
          const lastBreakPos = normalized.lastIndexOf(breakPoint, endPos);

          // If we found a break point that's not too far back, use it
          if (lastBreakPos > startPos && lastBreakPos > endPos - 100) {
            endPos = lastBreakPos + 1; // Include the break character
            break;
          }
        }

        // If no good break point was found, just use a space
        if (endPos > startPos + this.config.maxChunkSize - 10) {
          const lastSpacePos = normalized.lastIndexOf(' ', endPos);
          if (lastSpacePos > startPos) {
            endPos = lastSpacePos + 1;
          }
        }
      } else {
        // We're at the end of the text
        endPos = normalized.length;
      }

      // Extract the chunk
      const chunk = normalized.substring(startPos, endPos).trim();

      // Only add chunks that meet the minimum size requirement
      if (chunk.length >= this.config.minChunkSize) {
        chunks.push(chunk);
      }

      // Move start position for next chunk, accounting for overlap
      startPos = endPos - this.config.overlapSize;

      // Ensure we're making forward progress
      if (startPos <= 0 || startPos >= normalized.length - this.config.minChunkSize) {
        break;
      }
    }

    logger.debug(`Split text into ${chunks.length} chunks`);
    return chunks;
  }

  /**
   * Process text for embedding by normalizing and chunking
   * @param text Raw text to process
   * @returns Array of processed text chunks ready for embedding
   */
  public process(text: string): string[] {
    try {
      if (!text) {
        logger.warn('Empty text provided for processing');
        return [];
      }

      const chunks = this.chunk(text);
      return chunks;
    } catch (error) {
      logger.error({ error }, 'Error processing text');
      // Return the original text as a single chunk if processing fails
      return [this.normalize(text.slice(0, this.config.maxChunkSize))];
    }
  }
}

/**
 * Create a default text preprocessor instance
 */
export const createPreprocessor = (config?: Partial<PreprocessorConfig>): TextPreprocessor => {
  return new TextPreprocessor(config);
};
