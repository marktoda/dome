/**
 * Text Preprocessing Service
 *
 * Handles text chunking and preparation for embedding.
 */

import { getLogger } from '@dome/logging';

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
      getLogger().warn('Empty text provided for normalization');
      return '';
    }

    getLogger().debug(
      {
        originalLength: text.length,
        originalSample: text.substring(0, 50) + (text.length > 50 ? '...' : ''),
      },
      'Starting text normalization',
    );

    // Trim whitespace
    let normalized = text.trim();

    // Replace multiple spaces with a single space
    normalized = normalized.replace(/\s+/g, ' ');

    // Replace multiple newlines with a single newline
    normalized = normalized.replace(/\n+/g, '\n');

    // Remove special characters that might affect embedding quality
    normalized = normalized.replace(/[^\w\s.,?!;:()\[\]{}"'`-]/g, ' ');

    getLogger().debug(
      {
        normalizedLength: normalized.length,
        normalizedSample: normalized.substring(0, 50) + (normalized.length > 50 ? '...' : ''),
        lengthDifference: text.length - normalized.length,
        percentReduction:
          (((text.length - normalized.length) / text.length) * 100).toFixed(2) + '%',
      },
      'Text normalization complete',
    );

    return normalized;
  }

  /**
   * Split text into chunks of appropriate size for embedding
   * @param text Text to chunk
   * @returns Array of text chunks
   */
  public chunk(text: string): string[] {
    if (!text) {
      getLogger().warn('Empty text provided for chunking');
      return [];
    }

    getLogger().debug(
      {
        textLength: text.length,
        maxChunkSize: this.config.maxChunkSize,
        minChunkSize: this.config.minChunkSize,
        overlapSize: this.config.overlapSize,
      },
      'Starting text chunking process',
    );

    const normalized = this.normalize(text);

    // If text is smaller than max chunk size, return as single chunk
    if (normalized.length <= this.config.maxChunkSize) {
      getLogger().debug('Text is smaller than max chunk size, returning as single chunk');
      return [normalized];
    }

    const chunks: string[] = [];
    let startPos = 0;
    let chunkCount = 0;

    while (startPos < normalized.length) {
      // Calculate end position for this chunk
      let endPos = startPos + this.config.maxChunkSize;

      getLogger().debug(
        {
          chunkNumber: chunkCount + 1,
          startPos,
          initialEndPos: endPos,
          remainingText: normalized.length - startPos,
        },
        'Processing chunk',
      );

      // If we're not at the end of the text, try to find a natural break point
      if (endPos < normalized.length) {
        // Look for natural break points: sentence end, paragraph, etc.
        const breakPoints = ['. ', '! ', '? ', '\n\n', '\n'];
        let breakPointFound = false;
        let usedBreakPoint = '';

        // Try each break point type, starting from the most preferred
        for (const breakPoint of breakPoints) {
          const lastBreakPos = normalized.lastIndexOf(breakPoint, endPos);

          // If we found a break point that's not too far back, use it
          if (lastBreakPos > startPos && lastBreakPos > endPos - 100) {
            const oldEndPos = endPos;
            endPos = lastBreakPos + 1; // Include the break character
            breakPointFound = true;
            usedBreakPoint = breakPoint;

            getLogger().debug(
              {
                breakPoint,
                breakPointPosition: lastBreakPos,
                oldEndPos,
                newEndPos: endPos,
              },
              'Found natural break point',
            );

            break;
          }
        }

        // If no good break point was found, just use a space
        if (!breakPointFound && endPos > startPos + this.config.maxChunkSize - 10) {
          const lastSpacePos = normalized.lastIndexOf(' ', endPos);
          if (lastSpacePos > startPos) {
            const oldEndPos = endPos;
            endPos = lastSpacePos + 1;

            getLogger().debug(
              {
                fallbackToSpace: true,
                spacePosition: lastSpacePos,
                oldEndPos,
                newEndPos: endPos,
              },
              'No natural break point found, using space',
            );
          }
        }
      } else {
        // We're at the end of the text
        endPos = normalized.length;
        getLogger().debug('Reached end of text');
      }

      // Extract the chunk
      const chunk = normalized.substring(startPos, endPos).trim();

      // Only add chunks that meet the minimum size requirement
      if (chunk.length >= this.config.minChunkSize) {
        chunks.push(chunk);
        chunkCount++;

        getLogger().debug(
          {
            chunkNumber: chunkCount,
            chunkLength: chunk.length,
            chunkSample: chunk.substring(0, 50) + (chunk.length > 50 ? '...' : ''),
          },
          'Added chunk',
        );
      } else {
        getLogger().debug(
          {
            chunkLength: chunk.length,
            minChunkSize: this.config.minChunkSize,
          },
          'Chunk too small, skipping',
        );
      }

      // Move start position for next chunk, accounting for overlap
      startPos = endPos - this.config.overlapSize;

      getLogger().debug(
        {
          newStartPos: startPos,
          overlap: this.config.overlapSize,
          remainingText: normalized.length - startPos,
        },
        'Updated position for next chunk',
      );

      // Ensure we're making forward progress
      if (startPos <= 0 || startPos >= normalized.length - this.config.minChunkSize) {
        break;
      }
    }

    getLogger().debug(`Split text into ${chunks.length} chunks`);
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
        getLogger().warn('Empty text provided for processing');
        return [];
      }

      getLogger().debug(
        {
          textLength: text.length,
          textSample: text.substring(0, 50) + (text.length > 50 ? '...' : ''),
        },
        'Starting text processing for embedding',
      );

      const chunks = this.chunk(text);

      getLogger().debug(
        {
          chunkCount: chunks.length,
          totalCharsInChunks: chunks.reduce((sum, chunk) => sum + chunk.length, 0),
          averageChunkSize:
            chunks.length > 0
              ? Math.round(chunks.reduce((sum, chunk) => sum + chunk.length, 0) / chunks.length)
              : 0,
          chunkSizes: chunks.map(c => c.length),
        },
        'Text processing complete',
      );

      return chunks;
    } catch (error) {
      getLogger().error(
        {
          error,
          errorMessage: error instanceof Error ? error.message : String(error),
          textLength: text?.length || 0,
        },
        'Error processing text',
      );

      // Return the original text as a single chunk if processing fails
      const fallbackChunk = this.normalize(text.slice(0, this.config.maxChunkSize));
      getLogger().debug(
        {
          fallbackLength: fallbackChunk.length,
          originalLength: text.length,
          truncated: text.length > this.config.maxChunkSize,
        },
        'Using fallback single chunk due to processing error',
      );

      return [fallbackChunk];
    }
  }
}

/**
 * Create a default text preprocessor instance
 */
export const createPreprocessor = (config?: Partial<PreprocessorConfig>): TextPreprocessor => {
  return new TextPreprocessor(config);
};
