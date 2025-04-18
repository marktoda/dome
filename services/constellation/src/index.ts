import { WorkerEntrypoint } from 'cloudflare:workers';
import type { VectorMetadata } from '@dome/common';
import { embeddingService } from './services/embeddingService';
import { Bindings } from './types';
import { ServiceError } from '@dome/common';
import { logger } from '@dome/logging';

/**
 * Interface for embedding job messages received from the queue
 */
export interface EmbedJob {
  userId: string;
  noteId: string;
  text: string;
  created: number;
  version: number;
}

/**
 * Interface for query match results
 */
export interface QueryMatch {
  id: string;
  score: number;
  metadata: VectorMetadata;
}

/**
 * Constellation Worker Service
 *
 * Provides:
 * 1. Queue consumer for async embedding jobs
 * 2. RPC interface for direct embedding, queries, and stats
 */
export class Constellation extends WorkerEntrypoint {
  /**
   * Queue consumer for processing embedding jobs
   * Processes batches of embedding jobs, generates embeddings, and upserts them to Vectorize
   */
  async queue(batch: MessageBatch<EmbedJob>, env: Bindings): Promise<void> {
    try {
      const jobs = batch.messages.map(m => m.body);
      logger.info(`Processing batch of ${jobs.length} embedding jobs`);
      
      // 1. Preprocess text for each job
      const texts = jobs.map(job => embeddingService.preprocess(job.text));
      
      // 2. Generate embeddings (handled in batches by the service)
      const startEmbed = Date.now();
      const vectors = await embeddingService.generateBatch(env, texts);
      const embedTime = Date.now() - startEmbed;
      logger.info(`Generated ${vectors.length} embeddings in ${embedTime}ms`);
      
      // 3. Prepare vectors for upsert with metadata
      const vectorsWithMeta = vectors.map((vec, i) => ({
        id: `note:${jobs[i].noteId}`,
        values: vec,
        metadata: {
          userId: jobs[i].userId,
          noteId: jobs[i].noteId,
          createdAt: Math.floor(jobs[i].created / 1000),
          version: jobs[i].version,
        } as VectorMetadata,
      }));
      
      // 4. Upsert to Vectorize
      const startUpsert = Date.now();
      await env.VECTORIZE.upsert(vectorsWithMeta);
      const upsertTime = Date.now() - startUpsert;
      
      logger.info(`Upserted ${vectorsWithMeta.length} vectors in ${upsertTime}ms`);
    } catch (error) {
      // Handle rate limiting (429) by retrying the batch
      if (error instanceof Error && error.message.includes('429')) {
        logger.warn('Rate limited by Workers AI, retrying batch');
        batch.retryAll(30); // Retry after 30 seconds
        return;
      }
      
      // Log other errors and let the queue system handle retries
      logger.error('Error processing embedding batch', { error });
      throw error;
    }
  }

  /**
   * Direct embedding RPC method
   * Embeds a single note immediately (rare use case)
   */
  public async embed(env: Bindings, job: EmbedJob): Promise<void> {
    try {
      logger.info(`Direct embedding for noteId: ${job.noteId}`);
      
      // Create a fake batch with a single message
      const fakeBatch = {
        messages: [{ body: job }],
        retryAll: () => {} // No-op for direct embedding
      } as MessageBatch<EmbedJob>;
      
      // Reuse the queue consumer logic
      await this.queue(fakeBatch, env);
    } catch (error) {
      logger.error('Error in direct embedding', { error, noteId: job.noteId });
      throw new ServiceError('Failed to directly embed note', {
        cause: error instanceof Error ? error : new Error(String(error)),
        context: { noteId: job.noteId }
      });
    }
  }

  /**
   * Vector/text similarity search RPC method
   */
  public async query(
    env: Bindings,
    text: string,
    filter: Partial<VectorMetadata>,
    topK = 10,
  ): Promise<QueryMatch[]> {
    try {
      // Preprocess the query text
      const processedText = embeddingService.preprocess(text);
      
      // Execute the query against Vectorize
      const res = await env.VECTORIZE.query(processedText, { topK, filter });
      
      // Return only what callers need
      return res.matches as QueryMatch[];
    } catch (error) {
      logger.error('Error in vector query', { error, filter });
      throw new ServiceError('Failed to execute vector query', {
        cause: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  /**
   * Quick operational stats RPC method
   * Returns information about the Vectorize index
   */
  public async stats(env: Bindings) {
    try {
      const info = await env.VECTORIZE.info();
      return {
        vectors: info.vectorCount,
        dimension: info.dimensions
      };
    } catch (error) {
      logger.error('Error fetching vectorize stats', { error });
      throw new ServiceError('Failed to fetch vectorize stats', {
        cause: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }
}

export default new Constellation();
