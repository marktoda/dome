/**
 * Vectorize Service Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  VectorizeService,
  DEFAULT_VECTORIZE_CONFIG,
  createVectorizeService,
} from '../../src/services/vectorize';
import { VectorWithMetadata } from '../../src/types';
import { NoteVectorMeta, VectorSearchResult } from '@dome/common';

describe('VectorizeService', () => {
  let mockVectorize: VectorizeIndex;

  beforeEach(() => {
    // Create a mock Vectorize service
    mockVectorize = {
      upsert: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue({
        matches: [
          {
            id: 'note:note1',
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
    } as unknown as VectorizeIndex;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('upsert', () => {
    it('should call Vectorize with the correct vectors', async () => {
      const vectorizeService = new VectorizeService(mockVectorize);

      const vectors: VectorWithMetadata[] = [
        {
          id: 'note:note1',
          values: [0.1, 0.2, 0.3],
          metadata: {
            userId: 'user1',
            noteId: 'note1',
            createdAt: 1650000000,
            version: 1,
          },
        },
      ];

      await vectorizeService.upsert(vectors);

      expect(mockVectorize.upsert).toHaveBeenCalledWith(vectors);
    });

    it('should handle empty input', async () => {
      const vectorizeService = new VectorizeService(mockVectorize);

      await vectorizeService.upsert([]);

      expect(mockVectorize.upsert).not.toHaveBeenCalled();
    });

    it('should split large batches into smaller ones', async () => {
      const vectorizeService = new VectorizeService(mockVectorize, {
        maxBatchSize: 2,
      });

      // Create a batch of 5 vectors
      const vectors: VectorWithMetadata[] = Array(5)
        .fill(0)
        .map((_, i) => ({
          id: `note:note${i}`,
          values: [0.1, 0.2, 0.3],
          metadata: {
            userId: 'user1',
            noteId: `note${i}`,
            createdAt: 1650000000,
            version: 1,
          },
        }));

      await vectorizeService.upsert(vectors);

      // Should have called Vectorize 3 times (for batches of 2, 2, and 1)
      expect(mockVectorize.upsert).toHaveBeenCalledTimes(3);

      // Check that each batch was called with the correct vectors
      expect(mockVectorize.upsert).toHaveBeenNthCalledWith(1, [vectors[0], vectors[1]]);
      expect(mockVectorize.upsert).toHaveBeenNthCalledWith(2, [vectors[2], vectors[3]]);
      expect(mockVectorize.upsert).toHaveBeenNthCalledWith(3, [vectors[4]]);
    });

    it('should retry on failure', async () => {
      const vectorizeService = new VectorizeService(mockVectorize, {
        retryAttempts: 3,
        retryDelay: 10,
      });

      // Mock Vectorize to fail on the first attempt but succeed on the second
      (mockVectorize.upsert as any)
        .mockRejectedValueOnce(new Error('Rate limit exceeded'))
        .mockResolvedValueOnce(undefined);

      const vectors: VectorWithMetadata[] = [
        {
          id: 'note:note1',
          values: [0.1, 0.2, 0.3],
          metadata: {
            userId: 'user1',
            noteId: 'note1',
            createdAt: 1650000000,
            version: 1,
          },
        },
      ];

      await vectorizeService.upsert(vectors);

      // Should have called Vectorize twice (one failure, one success)
      expect(mockVectorize.upsert).toHaveBeenCalledTimes(2);
    });

    it('should throw an error after exhausting all retry attempts', async () => {
      const vectorizeService = new VectorizeService(mockVectorize, {
        retryAttempts: 2,
        retryDelay: 10,
      });

      // Mock Vectorize to always fail
      (mockVectorize.upsert as any).mockRejectedValue(new Error('Rate limit exceeded'));

      const vectors: VectorWithMetadata[] = [
        {
          id: 'note:note1',
          values: [0.1, 0.2, 0.3],
          metadata: {
            userId: 'user1',
            noteId: 'note1',
            createdAt: 1650000000,
            version: 1,
          },
        },
      ];

      await expect(vectorizeService.upsert(vectors)).rejects.toThrow('Rate limit exceeded');

      // Should have called Vectorize twice (both failures)
      expect(mockVectorize.upsert).toHaveBeenCalledTimes(2);
    });
  });

  describe('query', () => {
    it('should call Vectorize with the correct parameters', async () => {
      const vectorizeService = new VectorizeService(mockVectorize);

      const queryVector = [0.1, 0.2, 0.3];
      const filter: Partial<NoteVectorMeta> = { userId: 'user1' };
      const topK = 5;

      await vectorizeService.query(queryVector, filter, topK);

      // Verify the query was called with the correct parameters
      expect(mockVectorize.query).toHaveBeenCalledWith(queryVector, {
        topK,
        filter,
        returnMetadata: true,
      });
    });

    it('should return the search results from Vectorize', async () => {
      const vectorizeService = new VectorizeService(mockVectorize);

      const expectedResults: VectorSearchResult[] = [
        {
          id: 'note:note1',
          score: 0.95,
          metadata: {
            userId: 'user1',
            noteId: 'note1',
            createdAt: 1650000000,
            version: 1,
          },
        },
      ];

      // Mock the query to return the expected format
      (mockVectorize.query as any).mockResolvedValue({
        matches: expectedResults,
        count: expectedResults.length,
      });

      const queryVector = [0.1, 0.2, 0.3];
      const result = await vectorizeService.query(queryVector);

      expect(result).toEqual(expectedResults);
    });

    it('should handle empty input', async () => {
      const vectorizeService = new VectorizeService(mockVectorize);

      const result = await vectorizeService.query([]);

      expect(result).toEqual([]);
      expect(mockVectorize.query).not.toHaveBeenCalled();
    });

    it('should use default values when not provided', async () => {
      const vectorizeService = new VectorizeService(mockVectorize);

      const queryVector = [0.1, 0.2, 0.3];
      await vectorizeService.query(queryVector);

      // Verify the query was called with default values for filter and topK
      expect(mockVectorize.query).toHaveBeenCalledWith(queryVector, {
        topK: 10,
        filter: {},
        returnMetadata: true,
      });
    });
  });

  describe('getStats', () => {
    it('should call Vectorize info method', async () => {
      const vectorizeService = new VectorizeService(mockVectorize);

      await vectorizeService.getStats();

      expect(mockVectorize.describe).toHaveBeenCalled();
    });

    it('should return the formatted stats', async () => {
      const vectorizeService = new VectorizeService(mockVectorize);

      (mockVectorize.describe as any).mockResolvedValue({
        vectorsCount: 100,
        config: {
          dimensions: 384,
        },
      });

      const result = await vectorizeService.getStats();

      expect(result).toEqual({
        vectors: 100,
        dimension: 384,
      });
    });

    it('should handle errors', async () => {
      const vectorizeService = new VectorizeService(mockVectorize);

      (mockVectorize.describe as any).mockRejectedValue(new Error('Failed to get stats'));

      await expect(vectorizeService.getStats()).rejects.toThrow('Failed to get stats');
    });
  });

  describe('createVectorizeService', () => {
    it('should create a vectorize service with default config when no config is provided', () => {
      const vectorizeService = createVectorizeService(mockVectorize);
      expect(vectorizeService).toBeInstanceOf(VectorizeService);
    });
  });
});
