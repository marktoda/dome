import { Bindings, ConstellationService as ConstellationBinding } from '../types';
import {
  ServiceError,
  EmbedJob,
  NoteVectorMeta,
  VectorSearchResult,
  VectorIndexStats,
} from '@dome/common';
import { getLogger } from '@dome/logging';
import { Note } from '../models/note';
import { contentMapperService } from './contentMapperService';

/**
 * Configuration constants for text processing
 */
const MAX_TEXT_LENGTH = 8192;
const MIN_TEXT_LENGTH = 3;
const DEFAULT_TOP_K = 10;

/**
 * Service for interacting with the Constellation service
 * This service is the single point of contact with Constellation and handles:
 * - Type conversion between domain types and Constellation types
 * - Consistent error handling and logging
 * - Text preprocessing
 */
export class ConstellationService {
  private logger = getLogger();

  /**
   * Enqueues a text for asynchronous embedding via Constellation
   *
   * @param env - Cloudflare Workers environment bindings
   * @param userId - User ID associated with the text
   * @param noteId - Note ID associated with the text
   * @param text - Text to embed
   * @returns Promise resolving when the job is enqueued
   */
  async enqueueEmbedding(
    env: Bindings,
    userId: string,
    noteId: string,
    text: string,
  ): Promise<void> {
    try {
      this.logger.debug('Enqueuing embedding job', { userId, noteId, textLength: text.length });

      const job: EmbedJob = {
        userId,
        noteId,
        text: this.preprocess(text),
        created: Date.now(),
        version: 1,
      };

      await env.EMBED_QUEUE!.send(job);

      this.logger.debug('Successfully enqueued embedding job', { userId, noteId });
    } catch (error) {
      this.logger.error('Failed to enqueue embedding job', {
        userId,
        noteId,
        error: error instanceof Error ? error.message : String(error),
      });

      throw new ServiceError('Failed to enqueue embedding job', {
        cause: error instanceof Error ? error : new Error(String(error)),
        context: { userId, noteId },
      });
    }
  }

  /**
   * Directly embeds text using Constellation (use sparingly)
   *
   * @param env - Cloudflare Workers environment bindings
   * @param userId - User ID associated with the text
   * @param noteId - Note ID associated with the text
   * @param text - Text to embed
   * @returns Promise resolving when the embedding is complete
   */
  async embedDirectly(env: Bindings, userId: string, noteId: string, text: string): Promise<void> {
    try {
      this.validateConstellationBinding(env.CONSTELLATION);
      this.logger.debug('Embedding text directly', {
        userId,
        noteId,
        textLength: text.length,
      });

      const job: EmbedJob = {
        userId,
        noteId,
        text: this.preprocess(text),
        created: Date.now(),
        version: 1,
      };

      await env.CONSTELLATION!.embed(job);

      this.logger.debug('Successfully embedded text directly', { userId, noteId });
    } catch (error) {
      this.logger.error('Failed to embed directly', {
        userId,
        noteId,
        error: error instanceof Error ? error.message : String(error),
      });

      throw new ServiceError('Failed to embed directly', {
        cause: error instanceof Error ? error : new Error(String(error)),
        context: { userId, noteId },
      });
    }
  }

  /**
   * Query for similar embeddings using the Constellation service
   *
   * @param env - Cloudflare Workers environment bindings
   * @param text - Query text
   * @param filter - Optional metadata filter
   * @param topK - Optional number of results to return
   * @returns Promise resolving to search results
   */
  async query(
    env: Bindings,
    text: string,
    filter?: Partial<NoteVectorMeta>,
    topK: number = DEFAULT_TOP_K,
  ): Promise<VectorSearchResult[]> {
    try {
      this.validateConstellationBinding(env.CONSTELLATION);

      const processedText = this.preprocess(text);
      this.logger.debug('Querying embeddings', {
        textLength: text.length,
        filter,
        topK,
      });

      const results = await env.CONSTELLATION!.query(processedText, filter, topK);

      this.logger.debug('Successfully queried embeddings', {
        resultCount: results.length,
      });

      return results;
    } catch (error) {
      this.logger.error('Failed to query embeddings', {
        textLength: text.length,
        filter,
        topK,
        error: error instanceof Error ? error.message : String(error),
      });

      throw new ServiceError('Failed to query embeddings', {
        cause: error instanceof Error ? error : new Error(String(error)),
        context: { textLength: text.length, filter, topK },
      });
    }
  }

  /**
   * Get vector index statistics
   *
   * @param env - Cloudflare Workers environment bindings
   * @returns Promise resolving to vector index statistics
   */
  async getStats(env: Bindings): Promise<VectorIndexStats> {
    try {
      this.validateConstellationBinding(env.CONSTELLATION);

      this.logger.debug('Getting vector index statistics');

      const stats = await env.CONSTELLATION!.stats();

      this.logger.debug('Successfully got vector index statistics', {
        vectors: stats.vectors,
      });

      return stats;
    } catch (error) {
      this.logger.error('Failed to get vector index statistics', {
        error: error instanceof Error ? error.message : String(error),
      });

      throw new ServiceError('Failed to get vector index statistics', {
        cause: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  /**
   * Search for similar notes using semantic search
   *
   * @param env - Cloudflare Workers environment bindings
   * @param query - Search query text
   * @param userId - User ID to filter results by
   * @param topK - Number of results to return
   * @returns Promise resolving to search results with note IDs and scores
   */
  async searchNotes(
    env: Bindings,
    query: string,
    userId: string,
    topK: number = DEFAULT_TOP_K,
  ): Promise<Array<{ noteId: string; score: number }>> {
    try {
      const filter: Partial<NoteVectorMeta> = { userId };

      const results = await this.query(env, query, filter, topK);

      return contentMapperService.mapVectorResultsToNoteIds(results);
    } catch (error) {
      this.logger.error('Failed to search notes', {
        query,
        userId,
        topK,
        error: error instanceof Error ? error.message : String(error),
      });

      throw new ServiceError('Failed to search notes', {
        cause: error instanceof Error ? error : new Error(String(error)),
        context: { query, userId, topK },
      });
    }
  }

  /**
   * Preprocesses text for embedding generation
   *
   * @param text - The raw text to preprocess
   * @returns Processed text ready for embedding
   */
  private preprocess(text: string): string {
    // Normalize whitespace
    let processed = text.trim().replace(/\s+/g, ' ');

    // Handle very short inputs
    if (processed.length < MIN_TEXT_LENGTH) {
      processed = `${processed} ${processed} query search`;
    }

    // Truncate if too long
    if (processed.length > MAX_TEXT_LENGTH) {
      processed = processed.slice(0, MAX_TEXT_LENGTH);
    }

    return processed;
  }

  /**
   * Validates that the Constellation binding is available
   *
   * @param binding - The Constellation binding to validate
   * @throws ServiceError if the binding is not available
   */
  private validateConstellationBinding(binding?: ConstellationBinding): void {
    if (!binding) {
      throw new ServiceError('Constellation service is not available', {
        context: { message: 'CONSTELLATION binding is missing' },
      });
    }
  }
}

/**
 * Singleton instance of the constellation service
 */
export const constellationService = new ConstellationService();
