import { Bindings, ConstellationService as ConstellationBinding } from '../types';
import {
  ServiceError,
  EmbedJob,
  NoteVectorMeta,
  VectorSearchResult,
  VectorIndexStats,
} from '@dome/common';

/**
 * Configuration constants for text processing
 */
const MAX_TEXT_LENGTH = 8192;
const MIN_TEXT_LENGTH = 3;

/**
 * Service for interacting with the Constellation service
 * This service directly wraps all Constellation RPC methods and handles:
 * - Type conversion between domain types and Constellation types
 * - Consistent error handling
 * - Text preprocessing
 */
export class ConstellationService {
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
      const job: EmbedJob = {
        userId,
        noteId,
        text: this.preprocess(text),
        created: Date.now(),
        version: 1,
      };

      await env.EMBED_QUEUE!.send(job);
    } catch (error) {
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

      const job: EmbedJob = {
        userId,
        noteId,
        text: this.preprocess(text),
        created: Date.now(),
        version: 1,
      };

      await env.CONSTELLATION!.embed(job);
    } catch (error) {
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
    topK: number = 10,
  ): Promise<VectorSearchResult[]> {
    try {
      this.validateConstellationBinding(env.CONSTELLATION);

      const processedText = this.preprocess(text);
      return await env.CONSTELLATION!.query(processedText, filter, topK);
    } catch (error) {
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

      return await env.CONSTELLATION!.stats();
    } catch (error) {
      throw new ServiceError('Failed to get vector index statistics', {
        cause: error instanceof Error ? error : new Error(String(error)),
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
