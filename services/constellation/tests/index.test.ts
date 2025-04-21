/**
 * Tests for the main Constellation service
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Constellation from '../src/index';
import { SiloEmbedJob, VectorMeta } from '@dome/common';
import { getLogger } from '@dome/logging';

// Define types needed for testing
interface Env {
  AI: any;
  VECTORIZE: any;
  EMBED_QUEUE: any;
  EMBED_DEAD?: any;
  ENVIRONMENT: string;
  VERSION: string;
}

// Use any for Message to avoid type conflicts with the actual Message type
interface TestMessage<T> {
  id: string;
  timestamp: number;
  body: T;
  attempts: number;
  retry: () => void;
  ack: () => void;
}

// Use any for MessageBatch to avoid type conflicts with the actual MessageBatch type
interface TestMessageBatch<T> {
  messages: readonly TestMessage<T>[];
  queue: string;
  retryAll: () => void;
  ackAll: () => void;
}

// Mock dependencies
vi.mock('@dome/logging', () => {
  const mockMetricsService = {
    increment: vi.fn(),
    decrement: vi.fn(),
    gauge: vi.fn(),
    timing: vi.fn(),
    startTimer: vi.fn(() => ({
      stop: vi.fn(() => 100),
    })),
    trackOperation: vi.fn(),
    getCounter: vi.fn(),
    getGauge: vi.fn(),
    reset: vi.fn(),
  };

  return {
    withLogger: vi.fn((_, fn) => fn()),
    getLogger: vi.fn(() => ({
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn().mockReturnValue({
        info: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      }),
    })),
    logMetric: vi.fn(),
    createTimer: vi.fn(() => ({
      stop: vi.fn(() => 100),
    })),
    metrics: mockMetricsService,
    MetricsService: vi.fn(() => mockMetricsService),
  };
});

// Mock cloudflare:workers
vi.mock('cloudflare:workers', () => ({
  WorkerEntrypoint: class WorkerEntrypoint {
    constructor() {}
    fetch() {}
    queue() {}
  },
}));

vi.mock('../src/services/preprocessor', () => ({
  createPreprocessor: vi.fn(() => ({
    process: vi.fn(text => [text]),
    normalize: vi.fn(text => text),
  })),
}));

vi.mock('../src/services/embedder', () => ({
  createEmbedder: vi.fn(() => ({
    embed: vi.fn(texts => Promise.resolve(texts.map(() => new Array(1536).fill(0.1)))),
  })),
}));

vi.mock('../src/services/vectorize', () => ({
  createVectorizeService: vi.fn(() => ({
    upsert: vi.fn(() => Promise.resolve({ success: true })),
    query: vi.fn(() =>
      Promise.resolve([
        {
          id: 'vector-1',
          score: 0.95,
          metadata: {
            userId: 'user-123',
            noteId: 'note-1',
            createdAt: 1617235678,
            version: 1,
          },
        },
      ]),
    ),
    getStats: vi.fn(() => Promise.resolve({ vectors: 100, dimension: 1536 })),
  })),
}));

vi.mock('../src/utils/metrics', () => ({
  metrics: {
    increment: vi.fn(),
    gauge: vi.fn(),
    startTimer: vi.fn(() => ({
      stop: vi.fn(),
    })),
  },
}));

describe('Constellation', () => {
  let constellation: Constellation;
  let mockEnv: Env;

  // Test data
  const testJob: SiloEmbedJob = {
    userId: 'user-123',
    category: 'note',
    mimeType: 'text/markdown',
    contentId: 'note-456',
    text: 'This is a test note for embedding',
    created: Date.now(),
    version: 1,
  };

  const testFilter: Partial<VectorMeta> = {
    userId: 'user-123',
  };

  beforeEach(() => {
    // Reset mocks
    vi.clearAllMocks();

    // Create mock environment
    mockEnv = {
      AI: {
        run: vi.fn(),
      },
      VECTORIZE: {
        query: vi.fn(),
        upsert: vi.fn(),
        delete: vi.fn(),
      },
      EMBED_QUEUE: {
        send: vi.fn(),
      },
      EMBED_DEAD: {
        send: vi.fn(),
      },
      ENVIRONMENT: 'test',
      VERSION: '1.0.0',
    };

    // Create instance with mock env
    // We need to extend the class to test it since it's abstract
    class TestConstellation extends Constellation {
      constructor() {
        // @ts-ignore - We're mocking the constructor for testing
        super();
      }
    }

    constellation = new TestConstellation();
    // @ts-ignore - Accessing protected property for testing
    constellation.env = mockEnv;
  });

  describe('embed', () => {
    it('should process a single embedding job', async () => {
      // Act
      await constellation.embed(testJob);

      // Assert
      expect(getLogger().info).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: testJob.userId,
          contentId: testJob.contentId,
        }),
        expect.any(String),
      );
    });

    it('should handle errors during embedding', async () => {
      // Arrange - Force an error in the embedBatch method
      const error = new Error('Test error');
      vi.spyOn(constellation as any, 'embedBatch').mockRejectedValueOnce(error);

      // Act & Assert
      await expect(constellation.embed(testJob)).rejects.toThrow(error);
      expect(getLogger().error).toHaveBeenCalled();
    });
  });

  describe('query', () => {
    it('should perform a vector search query', async () => {
      // Act
      const results = await constellation.query('test query', testFilter, 10);

      // Assert
      // Check if results is an array (not an error object)
      expect(Array.isArray(results)).toBe(true);

      // Type guard to ensure TypeScript knows we're working with an array
      if (Array.isArray(results)) {
        expect(results).toHaveLength(1);
        expect(results[0].score).toBe(0.95);
        expect(results[0].metadata.userId).toBe('user-123');
      }
    });

    it('should use default topK when not provided', async () => {
      // Act
      await constellation.query('test query', testFilter);

      // Assert
      const { createVectorizeService } = await import('../src/services/vectorize');
      const mockVectorizeService = (createVectorizeService as ReturnType<typeof vi.fn>)() as any;

      expect(mockVectorizeService.query).toHaveBeenCalledWith(
        expect.any(Array),
        testFilter,
        10, // Default topK
      );
    });

    it('should handle empty query text after preprocessing', async () => {
      // Arrange
      const { createPreprocessor } = await import('../src/services/preprocessor');
      const mockPreprocessor = (createPreprocessor as ReturnType<typeof vi.fn>)() as any;
      mockPreprocessor.normalize = vi.fn().mockReturnValueOnce('');

      // Act
      const results = await constellation.query('', testFilter);

      // Assert
      expect(results).toEqual([]);
      expect(getLogger().warn).toHaveBeenCalled();
    });

    it('should handle errors during query', async () => {
      // Arrange
      const { createVectorizeService } = await import('../src/services/vectorize');
      const mockVectorizeService = (createVectorizeService as ReturnType<typeof vi.fn>)() as any;
      mockVectorizeService.query = vi.fn().mockRejectedValueOnce(new Error('Query error'));

      // Act & Assert
      await expect(constellation.query('test query', testFilter)).resolves.toEqual({
        error: expect.any(Object),
      });
      expect(getLogger().error).toHaveBeenCalled();
    });
  });

  describe('stats', () => {
    it('should return vector index statistics', async () => {
      // Act
      const stats = await constellation.stats();

      // Assert
      expect(stats).toEqual({ vectors: 100, dimension: 1536 });
    });

    it('should handle errors when getting stats', async () => {
      // Arrange
      const { createVectorizeService } = await import('../src/services/vectorize');
      const mockVectorizeService = (createVectorizeService as ReturnType<typeof vi.fn>)() as any;
      mockVectorizeService.getStats = vi.fn().mockRejectedValueOnce(new Error('Stats error'));

      // Act & Assert
      await expect(constellation.stats()).resolves.toEqual({ error: expect.any(Object) });
      expect(getLogger().error).toHaveBeenCalled();
    });
  });

  describe('queue', () => {
    it('should process a batch of embedding jobs', async () => {
      // Arrange
      const mockBatch = {
        messages: [
          {
            id: '1',
            timestamp: Date.now(),
            body: testJob,
            attempts: 1,
            retry: vi.fn(),
            ack: vi.fn(),
          },
          {
            id: '2',
            timestamp: Date.now(),
            body: { ...testJob, noteId: 'note-789' },
            attempts: 1,
            retry: vi.fn(),
            ack: vi.fn(),
          },
        ],
        queue: 'test-queue',
        retryAll: vi.fn(),
        ackAll: vi.fn(),
      } as any; // Use type assertion to any to bypass type checking

      // Mock embedBatch to return success count
      vi.spyOn(constellation as any, 'embedBatch').mockResolvedValueOnce(2);

      // Act
      await constellation.queue(mockBatch);

      // Assert
      expect(constellation['embedBatch']).toHaveBeenCalledWith(
        [testJob, { ...testJob, noteId: 'note-789' }],
        expect.any(Function),
      );
    });

    it('should handle errors during batch processing', async () => {
      // Arrange
      const mockBatch = {
        messages: [
          {
            id: '1',
            timestamp: Date.now(),
            body: testJob,
            attempts: 1,
            retry: vi.fn(),
            ack: vi.fn(),
          },
        ],
        queue: 'test-queue',
        retryAll: vi.fn(),
        ackAll: vi.fn(),
      } as any; // Use type assertion to any to bypass type checking

      // Force an error in embedBatch
      vi.spyOn(constellation as any, 'embedBatch').mockRejectedValueOnce(new Error('Batch error'));

      // Act
      await constellation.queue(mockBatch);

      // Assert
      expect(getLogger().error).toHaveBeenCalled();
      expect(mockBatch.retryAll).toHaveBeenCalled();
    });
  });

  describe('embedBatch', () => {
    it('should process multiple embedding jobs', async () => {
      // Arrange
      const jobs = [testJob, { ...testJob, noteId: 'note-789' }];

      // Act
      const successCount = await (constellation as any).embedBatch(jobs);

      // Assert
      expect(successCount).toBe(2);
    });

    it('should handle empty text chunks after preprocessing', async () => {
      // Arrange
      const { createPreprocessor } = await import('../src/services/preprocessor');
      const mockPreprocessor = (createPreprocessor as ReturnType<typeof vi.fn>)() as any;
      mockPreprocessor.process = vi.fn().mockReturnValueOnce([]);

      // Act
      const successCount = await (constellation as any).embedBatch([testJob]);

      // Assert
      expect(successCount).toBe(1);
      expect(getLogger().warn).toHaveBeenCalled();
    });

    it('should send failed jobs to dead letter queue', async () => {
      // Arrange
      const { createEmbedder } = await import('../src/services/embedder');
      const mockEmbedder = (createEmbedder as ReturnType<typeof vi.fn>)() as any;
      mockEmbedder.embed = vi.fn().mockRejectedValueOnce(new Error('Embedding error'));

      const sendToDeadLetter = vi.fn();

      // Act & Assert
      await expect((constellation as any).embedBatch([testJob], sendToDeadLetter)).resolves.toBe(1);
      expect(sendToDeadLetter).toHaveBeenCalledWith(testJob);
    });
  });
});
