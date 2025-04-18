import { Bindings } from '../types';
import { ServiceError, EmbedJob, VectorSearchResult } from '@dome/common';

/**
 * Configuration constants for the embedding service
 */
const MAX_TEXT_LENGTH = 8192;
const MIN_TEXT_LENGTH = 3;

/**
 * Service for generating text embeddings using the Constellation service
 */
export class EmbeddingService {
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
  async queryEmbeddings(
    env: Bindings,
    text: string,
    filter?: Record<string, any>,
    topK: number = 10,
  ): Promise<VectorSearchResult[]> {
    try {
      const processedText = this.preprocess(text);

      // Use the query method from the ConstellationService interface
      return await env.CONSTELLATION!.query(processedText, filter, topK);
    } catch (error) {
      throw new ServiceError('Failed to query embeddings', {
        cause: error instanceof Error ? error : new Error(String(error)),
        context: { textLength: text.length, filter, topK },
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
}

/**
 * Singleton instance of the embedding service
 */
export const embeddingService = new EmbeddingService();
