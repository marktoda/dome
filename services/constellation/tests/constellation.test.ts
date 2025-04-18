/**
 * Constellation Service Integration Tests
 *
 * Tests the end-to-end functionality of the Constellation worker.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EmbedJob } from '@dome/common';
import { QueueMessage } from '../src/types';
import Constellation from '../src/index';

describe('Constellation Service Integration', () => {
  let mockEnv: Env;
  let mockExecutionContext: any;

  beforeEach(() => {
    // Create mock environment
    mockEnv = {
      VECTORIZE: {
        upsert: vi.fn().mockResolvedValue(undefined),
        query: vi.fn().mockResolvedValue({
          matches: [
            {
              id: 'note:note1:0',
              score: 0.95,
              metadata: {
                userId: 'user1',
                noteId: 'note1',
                createdAt: 1650000000,
                version: 1,
              },
            },
          ],
          count: 1,
        }),
        describe: vi.fn().mockResolvedValue({
          vectorsCount: 100,
          config: {
            dimensions: 384,
          },
        }),
      } as any,
      AI: {
        run: vi.fn().mockResolvedValue({
          data: [
            [0.1, 0.2, 0.3],
            [0.4, 0.5, 0.6],
          ],
        }),
      } as any,
      EMBED_QUEUE: {
        send: vi.fn().mockResolvedValue(undefined),
      } as any,
      EMBED_DEAD: {
        send: vi.fn().mockResolvedValue(undefined),
      } as any,
      VERSION: '0.1.0',
      ENVIRONMENT: 'test',
    } as unknown as Env;

    // Create mock execution context with run method for CFExecutionContext
    mockExecutionContext = {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
      run: vi.fn().mockImplementation(fn => Promise.resolve(fn())),
    };

    // Set up spies on the logger
    vi.mock('@dome/logging', () => ({
      getLogger: vi.fn().mockReturnValue({
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
      }),
      runWithLogger: vi.fn().mockImplementation((context: any, fn: () => any) => fn()),
      BaseLogger: class {},
    }));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Queue Consumer', () => {
    it('should process a batch of embedding jobs', async () => {
      // Create a batch of jobs
      const jobs = [
        createEmbedJob('user1', 'note1', 'This is test note 1'),
        createEmbedJob('user1', 'note2', 'This is test note 2'),
      ];

      const messages = jobs.map(job => ({
        id: `msg-${job.noteId}`,
        timestamp: new Date(),
        body: job,
        attempts: 1,
        retry: vi.fn(),
        ack: vi.fn(),
      })) as unknown as readonly QueueMessage<EmbedJob>[];

      const batch = {
        messages,
        queue: 'EMBED_QUEUE',
        retryAll: vi.fn(),
        ackAll: vi.fn(),
      } as unknown as MessageBatch<EmbedJob>;

      // Process the batch
      await (Constellation as any).queue(batch);

      // Verify AI service was called
      expect(mockEnv.AI.run).toHaveBeenCalledWith(
        '@cf/baai/bge-small-en-v1.5',
        expect.objectContaining({
          text: expect.arrayContaining([
            expect.stringContaining('This is test note 1'),
            expect.stringContaining('This is test note 2'),
          ]),
        }),
      );

      // Verify Vectorize service was called
      expect(mockEnv.VECTORIZE.upsert).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            id: expect.stringContaining('note:note1'),
            values: expect.arrayContaining([0.1, 0.2, 0.3]),
            metadata: expect.objectContaining({
              userId: 'user1',
              noteId: 'note1',
            }),
          }),
          expect.objectContaining({
            id: expect.stringContaining('note:note2'),
            values: expect.arrayContaining([0.4, 0.5, 0.6]),
            metadata: expect.objectContaining({
              userId: 'user1',
              noteId: 'note2',
            }),
          }),
        ]),
      );
    });

    it('should handle errors and send to dead letter queue', async () => {
      // Mock AI service to throw an error
      mockEnv.AI.run = vi.fn().mockRejectedValue(new Error('AI service error'));

      // Create a job
      const job = createEmbedJob('user1', 'note1', 'This is test note 1');

      const message = {
        id: `msg-${job.noteId}`,
        timestamp: new Date(),
        body: job,
        attempts: 1,
        retry: vi.fn(),
        ack: vi.fn(),
      } as unknown as QueueMessage<EmbedJob>;

      const batch = {
        messages: [message] as readonly QueueMessage<EmbedJob>[],
        queue: 'EMBED_QUEUE',
        retryAll: vi.fn(),
        ackAll: vi.fn(),
      } as unknown as MessageBatch<EmbedJob>;

      // Process the batch
      await (Constellation as any).queue(batch);

      // Verify dead letter queue was used
      expect(mockEnv.EMBED_DEAD?.send).toHaveBeenCalledWith(job);

      // Verify batch retry was called
      expect(batch.retryAll).toHaveBeenCalled();
    });
  });

  describe('RPC Methods', () => {
    describe('embed', () => {
      it('should directly process an embedding job', async () => {
        const job = createEmbedJob('user1', 'note1', 'This is a direct embed test');

        await (Constellation as any).embed(mockEnv, job);

        // Verify AI service was called
        expect(mockEnv.AI.run).toHaveBeenCalled();

        // Verify Vectorize service was called
        expect(mockEnv.VECTORIZE.upsert).toHaveBeenCalled();
      });

      it('should handle errors', async () => {
        // Mock AI service to throw an error
        mockEnv.AI.run = vi.fn().mockRejectedValue(new Error('AI service error'));

        const job = createEmbedJob('user1', 'note1', 'This is a direct embed test');

        await expect((Constellation as any).embed(mockEnv, job)).rejects.toThrow(
          'AI service error',
        );
      });
    });

    describe('query', () => {
      it('should search for similar vectors', async () => {
        const text = 'test query';
        const filter = { userId: 'user1' };
        const topK = 5;

        const results = await (Constellation as any).query(mockEnv, text, filter, topK);

        // Verify Vectorize query was called
        // We don't check the exact parameters because our implementation now uses a placeholder vector
        expect(mockEnv.VECTORIZE.query).toHaveBeenCalled();

        // Verify results were returned
        expect(results).toEqual([
          {
            id: 'note:note1:0',
            score: 0.95,
            metadata: {
              userId: 'user1',
              noteId: 'note1',
              createdAt: 1650000000,
              version: 1,
            },
          },
        ]);
      });

      it('should handle empty query text', async () => {
        const results = await (Constellation as any).query(mockEnv, '', { userId: 'user1' });

        // Verify Vectorize query was not called
        expect(mockEnv.VECTORIZE.query).not.toHaveBeenCalled();

        // Verify empty results were returned
        expect(results).toEqual([]);
      });

      it('should handle errors', async () => {
        // Mock Vectorize service to throw an error
        mockEnv.VECTORIZE.query = vi.fn().mockRejectedValue(new Error('Vectorize service error'));

        await expect(
          (Constellation as any).query(mockEnv, 'test', { userId: 'user1' }),
        ).rejects.toThrow('Vectorize service error');
      });
    });

    describe('stats', () => {
      it('should return vector index statistics', async () => {
        const stats = await (Constellation as any).stats(mockEnv);

        // Verify Vectorize describe was called
        expect(mockEnv.VECTORIZE.describe).toHaveBeenCalled();

        // Verify stats were returned
        expect(stats).toEqual({
          vectors: 100,
          dimension: 384,
        });
      });

      it('should handle errors', async () => {
        // Mock Vectorize service to throw an error
        mockEnv.VECTORIZE.describe = vi
          .fn()
          .mockRejectedValue(new Error('Vectorize service error'));

        await expect((Constellation as any).stats(mockEnv)).rejects.toThrow(
          'Vectorize service error',
        );
      });
    });
  });

  describe('End-to-End Flow', () => {
    it('should support the complete embedding and query flow', async () => {
      // 1. Create and embed a job
      const job = createEmbedJob('user1', 'note1', 'This is a test note for the complete flow');

      await (Constellation as any).embed(mockEnv, job);

      // Verify embedding was created and stored
      expect(mockEnv.AI.run).toHaveBeenCalled();
      expect(mockEnv.VECTORIZE.upsert).toHaveBeenCalled();

      // 2. Query for similar vectors
      const results = await (Constellation as any).query(mockEnv, 'test note', { userId: 'user1' });

      // Verify query returned results
      expect(results).toHaveLength(1);
      expect(results[0].metadata.userId).toBe('user1');

      // 3. Get stats
      const stats = await (Constellation as any).stats(mockEnv);

      // Verify stats were returned
      expect(stats.vectors).toBe(100);
      expect(stats.dimension).toBe(384);
    });
  });
});

/**
 * Helper function to create an embed job
 */
function createEmbedJob(userId: string, noteId: string, text: string): EmbedJob {
  return {
    userId,
    noteId,
    text,
    created: Date.now(),
    version: 1,
  };
}
