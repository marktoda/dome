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

    this.logChunkingStart(text);
    const normalized = this.normalize(text);

    // If text is smaller than max chunk size, return as single chunk
    if (normalized.length <= this.config.maxChunkSize) {
      getLogger().debug('Text is smaller than max chunk size, returning as single chunk');
      return [normalized];
    }

    return this.createChunks(normalized);
  }

  /**
   * Log information about the chunking process start
   * @param text Text to be chunked
   * @private
   */
  private logChunkingStart(text: string): void {
    getLogger().debug(
      {
        textLength: text.length,
        maxChunkSize: this.config.maxChunkSize,
        minChunkSize: this.config.minChunkSize,
        overlapSize: this.config.overlapSize,
      },
      'Starting text chunking process',
    );
  }

  /**
   * Create chunks from normalized text
   * @param normalized Normalized text to chunk
   * @returns Array of text chunks
   * @private
   */
  private createChunks(normalized: string): string[] {
    const chunks: string[] = [];
    let startPos = 0;
    let chunkCount = 0;

    while (startPos < normalized.length) {
      // Calculate initial end position for this chunk
      let endPos = startPos + this.config.maxChunkSize;

      this.logChunkProcessingStart(chunkCount, startPos, endPos, normalized);

      // Find appropriate end position for the chunk
      endPos = this.findChunkEndPosition(normalized, startPos, endPos);

      // Extract and process the chunk
      const chunk = normalized.substring(startPos, endPos).trim();
      this.processExtractedChunk(chunk, chunks, chunkCount);

      // Update position for next chunk
      startPos = this.updateStartPosition(endPos, normalized);

      // Increment chunk counter if we added a chunk
      if (chunk.length >= this.config.minChunkSize) {
        chunkCount++;
      }

      // Ensure we're making forward progress
      if (startPos <= 0 || startPos >= normalized.length - this.config.minChunkSize) {
        break;
      }
    }

    getLogger().debug(`Split text into ${chunks.length} chunks`);
    return chunks;
  }

  /**
   * Log information about the start of processing a chunk
   * @param chunkCount Current chunk number
   * @param startPos Start position in the text
   * @param endPos Initial end position in the text
   * @param normalized The normalized text
   * @private
   */
  private logChunkProcessingStart(
    chunkCount: number,
    startPos: number,
    endPos: number,
    normalized: string,
  ): void {
    getLogger().debug(
      {
        chunkNumber: chunkCount + 1,
        startPos,
        initialEndPos: endPos,
        remainingText: normalized.length - startPos,
      },
      'Processing chunk',
    );
  }

  /**
   * Find the appropriate end position for a chunk
   * @param text Normalized text
   * @param startPos Start position in the text
   * @param endPos Initial end position in the text
   * @returns Adjusted end position
   * @private
   */
  private findChunkEndPosition(text: string, startPos: number, endPos: number): number {
    // If we're at the end of the text, return the text length
    if (endPos >= text.length) {
      getLogger().debug('Reached end of text');
      return text.length;
    }

    // Try to find a natural break point
    const adjustedEndPos = this.findNaturalBreakPoint(text, startPos, endPos);

    // If no natural break point was found, try to find a space
    if (adjustedEndPos === endPos && endPos > startPos + this.config.maxChunkSize - 10) {
      return this.findSpaceBreakPoint(text, startPos, endPos);
    }

    return adjustedEndPos;
  }

  /**
   * Find a natural break point in the text
   * @param text Normalized text
   * @param startPos Start position in the text
   * @param endPos Initial end position in the text
   * @returns Adjusted end position
   * @private
   */
  private findNaturalBreakPoint(text: string, startPos: number, endPos: number): number {
    // Look for natural break points: sentence end, paragraph, etc.
    const breakPoints = ['. ', '! ', '? ', '\n\n', '\n'];

    for (const breakPoint of breakPoints) {
      const lastBreakPos = text.lastIndexOf(breakPoint, endPos);

      // If we found a break point that's not too far back, use it
      if (lastBreakPos > startPos && lastBreakPos > endPos - 100) {
        const oldEndPos = endPos;
        const newEndPos = lastBreakPos + 1; // Include the break character

        getLogger().debug(
          {
            breakPoint,
            breakPointPosition: lastBreakPos,
            oldEndPos,
            newEndPos,
          },
          'Found natural break point',
        );

        return newEndPos;
      }
    }

    // No suitable break point found
    return endPos;
  }

  /**
   * Find a space to break the text if no natural break point was found
   * @param text Normalized text
   * @param startPos Start position in the text
   * @param endPos Initial end position in the text
   * @returns Adjusted end position
   * @private
   */
  private findSpaceBreakPoint(text: string, startPos: number, endPos: number): number {
    const lastSpacePos = text.lastIndexOf(' ', endPos);

    if (lastSpacePos > startPos) {
      const oldEndPos = endPos;
      const newEndPos = lastSpacePos + 1;

      getLogger().debug(
        {
          fallbackToSpace: true,
          spacePosition: lastSpacePos,
          oldEndPos,
          newEndPos,
        },
        'No natural break point found, using space',
      );

      return newEndPos;
    }

    return endPos;
  }

  /**
   * Process an extracted chunk and add it to the chunks array if it meets size requirements
   * @param chunk The extracted chunk
   * @param chunks Array to add the chunk to
   * @param chunkCount Current chunk count
   * @private
   */
  private processExtractedChunk(chunk: string, chunks: string[], chunkCount: number): void {
    // Only add chunks that meet the minimum size requirement
    if (chunk.length >= this.config.minChunkSize) {
      chunks.push(chunk);

      getLogger().debug(
        {
          chunkNumber: chunkCount + 1,
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
  }

  /**
   * Update the start position for the next chunk
   * @param endPos End position of the current chunk
   * @param text The normalized text
   * @returns New start position
   * @private
   */
  private updateStartPosition(endPos: number, text: string): number {
    const newStartPos = endPos - this.config.overlapSize;

    getLogger().debug(
      {
        newStartPos,
        overlap: this.config.overlapSize,
        remainingText: text.length - newStartPos,
      },
      'Updated position for next chunk',
    );

    return newStartPos;
  }

  /**
   * Process text for embedding by normalizing and chunking
   * @param text Raw text to process
   * @returns Array of processed text chunks ready for embedding
   */
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

      this.logProcessingStart(text);
      const chunks = this.chunk(text);
      this.logProcessingComplete(chunks);

      return chunks;
    } catch (error) {
      return this.handleProcessingError(error, text);
    }
  }

  /**
   * Log information about the start of text processing
   * @param text Text to be processed
   * @private
   */
  private logProcessingStart(text: string): void {
    getLogger().debug(
      {
        textLength: text.length,
        textSample: text.substring(0, 50) + (text.length > 50 ? '...' : ''),
      },
      'Starting text processing for embedding',
    );
  }

  /**
   * Log information about completed text processing
   * @param chunks The processed chunks
   * @private
   */
  private logProcessingComplete(chunks: string[]): void {
    const totalChars = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const averageSize = chunks.length > 0 ? Math.round(totalChars / chunks.length) : 0;

    getLogger().debug(
      {
        chunkCount: chunks.length,
        totalCharsInChunks: totalChars,
        averageChunkSize: averageSize,
        chunkSizes: chunks.map(c => c.length),
      },
      'Text processing complete',
    );
  }

  /**
   * Handle errors during text processing
   * @param error The error that occurred
   * @param text The original text
   * @returns Fallback chunk array
   * @private
   */
  private handleProcessingError(error: unknown, text: string): string[] {
    const errorMessage = error instanceof Error ? error.message : String(error);

    getLogger().error(
      {
        error,
        errorMessage,
        textLength: text?.length || 0,
      },
      'Error processing text',
    );

    // Create a fallback chunk from the original text
    return this.createFallbackChunk(text);
  }

  /**
   * Create a fallback chunk when processing fails
   * @param text The original text
   * @returns Array with a single fallback chunk
   * @private
   */
  private createFallbackChunk(text: string): string[] {
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

/**
 * Create a default text preprocessor instance
 */
export const createPreprocessor = (config?: Partial<PreprocessorConfig>): TextPreprocessor => {
  return new TextPreprocessor(config);
};
