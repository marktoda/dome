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
import { VectorMeta, VectorSearchResult, PUBLIC_USER_ID } from '@dome/common';

// Mock the logger and metrics
// vi.mock('@dome/common', () => ({ // Removed local mock to use global setup.js mock
//   getLogger: vi.fn().mockReturnValue({
//     debug: vi.fn(),
//     info: vi.fn(),
//     warn: vi.fn(),
//     error: vi.fn(),
//   }),
//   metrics: {
//     increment: vi.fn(),
//     gauge: vi.fn(),
//     timing: vi.fn(),
//     startTimer: vi.fn().mockReturnValue({
//       stop: vi.fn(),
//     }),
//   },
//   // Add the missing function
//   createServiceMetrics: vi.fn(serviceName => ({
//     increment: vi.fn(),
//     decrement: vi.fn(),
//     gauge: vi.fn(),
//     timing: vi.fn(),
//     startTimer: vi.fn(() => ({ stop: vi.fn(() => 100) })),
//     trackOperation: vi.fn(),
//     getCounter: vi.fn(() => 0),
//     getGauge: vi.fn(() => 0),
//     reset: vi.fn(),
//   })),
// }));

vi.mock('../../src/utils/metrics', () => ({
  metrics: {
    increment: vi.fn(),
    gauge: vi.fn(),
    startTimer: vi.fn(() => ({
      stop: vi.fn(),
    })),
  },
}));

// Temporarily skip all tests to resolve memory issues
describe('VectorizeService', () => {
  // Unskipped this describe block
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
              contentId: 'note1',
              category: 'note',
              mimeType: 'text/markdown',
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
            contentId: 'note1',
            category: 'note',
            mimeType: 'text/markdown',
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
            contentId: `note${i}`,
            category: 'note',
            mimeType: 'text/markdown',
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
            contentId: 'note1',
            category: 'note',
            mimeType: 'text/markdown',
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
            contentId: 'note1',
            category: 'note',
            mimeType: 'text/markdown',
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
    it('should call Vectorize with the correct parameters for non-userId filters', async () => {
      const vectorizeService = new VectorizeService(mockVectorize);

      const queryVector = [0.1, 0.2, 0.3];
      const filter: Partial<VectorMeta> = { category: 'note' };
      const topK = 5;

      await vectorizeService.query(queryVector, filter, topK);

      // Verify the query was called with the correct parameters
      expect(mockVectorize.query).toHaveBeenCalledWith(queryVector, {
        topK,
        filter,
        returnMetadata: true,
      });
    });

    it('should modify the filter to include public content when userId is specified', async () => {
      const vectorizeService = new VectorizeService(mockVectorize);

      const queryVector = [0.1, 0.2, 0.3];
      const filter: Partial<VectorMeta> = { userId: 'user1', category: 'note' };
      const topK = 5;

      await vectorizeService.query(queryVector, filter, topK);

      // Verify the query was called with the modified filter that includes public content
      expect(mockVectorize.query).toHaveBeenCalledWith(queryVector, {
        topK,
        filter: {
          category: 'note',
          userId: { $in: ['user1', PUBLIC_USER_ID] },
        },
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
            contentId: 'note1',
            category: 'note',
            mimeType: 'text/markdown',
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

      // Expect the service to throw a ValidationError (or a specific error type if defined)
      // The actual error comes from assertValid in vectorize.ts, which might be a generic HttpError
      // or a more specific ValidationError if @dome/common provides it and it's used.
      // For now, let's expect it to throw an error that includes the message.
      await expect(vectorizeService.query([])).rejects.toThrow('Vector must not be empty');

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

  describe('public content handling', () => {
    it('should handle public content vectors in query results', async () => {
      const vectorizeService = new VectorizeService(mockVectorize);

      // Mock query to return both user-specific and public vectors
      (mockVectorize.query as any).mockResolvedValue({
        matches: [
          {
            id: 'note:user1-note',
            score: 0.95,
            metadata: {
              userId: 'user1',
              contentId: 'user1-note',
              category: 'note',
              mimeType: 'text/markdown',
              createdAt: 1650000000,
              version: 1,
            },
          },
          {
            id: 'note:public-note',
            score: 0.9,
            metadata: {
              userId: PUBLIC_USER_ID, // Use the new constant
              contentId: 'public-note',
              category: 'note',
              mimeType: 'text/markdown',
              createdAt: 1650000000,
              version: 1,
            },
          },
        ],
        count: 2,
      });

      const queryVector = [0.1, 0.2, 0.3];
      const filter: Partial<VectorMeta> = { userId: 'user1' };

      const results = await vectorizeService.query(queryVector, filter);

      // Should return both user-specific and public vectors
      expect(results.length).toBe(2);
      expect(results[0].metadata.userId).toBe('user1');
      expect(results[1].metadata.userId).toBe(PUBLIC_USER_ID);
    });

    it('should handle query with only public content results', async () => {
      const vectorizeService = new VectorizeService(mockVectorize);

      // Mock query to return only public vectors
      (mockVectorize.query as any).mockResolvedValue({
        matches: [
          {
            id: 'note:public-note1',
            score: 0.95,
            metadata: {
              userId: PUBLIC_USER_ID,
              contentId: 'public-note1',
              category: 'note',
              mimeType: 'text/markdown',
              createdAt: 1650000000,
              version: 1,
            },
          },
          {
            id: 'note:public-note2',
            score: 0.9,
            metadata: {
              userId: PUBLIC_USER_ID,
              contentId: 'public-note2',
              category: 'note',
              mimeType: 'text/markdown',
              createdAt: 1650000000,
              version: 1,
            },
          },
        ],
        count: 2,
      });

      const queryVector = [0.1, 0.2, 0.3];
      const filter: Partial<VectorMeta> = { userId: 'user1' };

      const results = await vectorizeService.query(queryVector, filter);

      // Should return only public vectors
      expect(results.length).toBe(2);
      expect(results.every(r => r.metadata.userId === PUBLIC_USER_ID)).toBe(true);
    });

    it('should handle query with only user-specific content results', async () => {
      const vectorizeService = new VectorizeService(mockVectorize);

      // Mock query to return only user-specific vectors
      (mockVectorize.query as any).mockResolvedValue({
        matches: [
          {
            id: 'note:user1-note1',
            score: 0.95,
            metadata: {
              userId: 'user1',
              contentId: 'user1-note1',
              category: 'note',
              mimeType: 'text/markdown',
              createdAt: 1650000000,
              version: 1,
            },
          },
          {
            id: 'note:user1-note2',
            score: 0.9,
            metadata: {
              userId: 'user1',
              contentId: 'user1-note2',
              category: 'note',
              mimeType: 'text/markdown',
              createdAt: 1650000000,
              version: 1,
            },
          },
        ],
        count: 2,
      });

      const queryVector = [0.1, 0.2, 0.3];
      const filter: Partial<VectorMeta> = { userId: 'user1' };

      const results = await vectorizeService.query(queryVector, filter);

      // Should return only user-specific vectors
      expect(results.length).toBe(2);
      expect(results.every(r => r.metadata.userId === 'user1')).toBe(true);
    });
  });
});
