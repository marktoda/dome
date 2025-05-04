import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import Silo from '../src/index';

// Mock WorkerEntrypoint
vi.mock('cloudflare:workers', () => ({
  WorkerEntrypoint: class {
    protected env: any;
    constructor(ctx: any, env: any) {
      this.env = env;
    }
  },
}));

// Mock dependencies
vi.mock('@dome/common', () => ({
  withContext: vi.fn((_, fn) => fn()),
}));

vi.mock('@dome/common', () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  })),
  metrics: {
    increment: vi.fn(),
    gauge: vi.fn(),
    timing: vi.fn(),
    startTimer: vi.fn(() => ({
      stop: vi.fn(),
    })),
  },
}));

// Mock utils/wrap
vi.mock('../src/utils/wrap', () => ({
  wrap: vi.fn((_, fn) => fn()),
}));

// Mock controllers
vi.mock('../src/controllers/contentController', () => ({
  createContentController: vi.fn(() => mockContentController),
}));

vi.mock('../src/controllers/statsController', () => ({
  createStatsController: vi.fn(() => mockStatsController),
}));

// Mock services
vi.mock('../src/services/r2Service', () => ({
  createR2Service: vi.fn(() => ({})),
}));

vi.mock('../src/services/metadataService', () => ({
  createMetadataService: vi.fn(() => ({})),
}));

vi.mock('../src/services/queueService', () => ({
  createQueueService: vi.fn(() => ({})),
}));

// Create mock controllers
const mockContentController = {
  simplePut: vi.fn(),
  createUpload: vi.fn(),
  batchGet: vi.fn(),
  delete: vi.fn(),
  processR2Event: vi.fn(),
};

const mockStatsController = {
  getStats: vi.fn(),
};

// Import mocks after they've been defined
import { withContext } from '@dome/common';
import { metrics } from '@dome/common';
import { createContentController } from '../src/controllers/contentController';
import { createStatsController } from '../src/controllers/statsController';

describe('Silo Service', () => {
  let silo: Silo;
  let mockEnv: any;
  let mockCtx: any;

  beforeEach(() => {
    mockEnv = {
      CACHE: {},
      BUCKET: {},
      DB: {},
      NEW_CONTENT: {},
      SILO_CONTENT_UPLOADED: {},
      LOG_LEVEL: 'info',
      VERSION: '1.0.0',
      ENVIRONMENT: 'test',
    };

    mockCtx = {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
      props: {},
    };

    silo = new Silo(mockCtx, mockEnv);

    vi.clearAllMocks();
  });

  describe('RPC Methods', () => {
    it('simplePut should delegate to content controller', async () => {
      const testData = { contentType: 'note', content: 'Test content' };
      const expectedResult = {
        id: 'test-id',
        contentType: 'note',
        size: 123,
        createdAt: 1234567890,
      };

      mockContentController.simplePut.mockResolvedValue(expectedResult);

      const result = await silo.simplePut(testData);

      expect(mockContentController.simplePut).toHaveBeenCalledWith(
        expect.objectContaining({
          contentType: 'note',
          content: 'Test content',
        }),
      );
      expect(result).toEqual(expectedResult);
    });

    it('createUpload should delegate to content controller', async () => {
      const testData = { contentType: 'note', size: 1024 };
      const expectedResult = { id: 'test-id', uploadUrl: 'https://example.com' };

      mockContentController.createUpload.mockResolvedValue(expectedResult);

      const result = await silo.createUpload(testData);

      expect(mockContentController.createUpload).toHaveBeenCalledWith(
        expect.objectContaining({
          contentType: 'note',
          size: 1024,
        }),
      );
      expect(result).toEqual(expectedResult);
    });

    it('batchGet should delegate to content controller', async () => {
      const testData = { ids: ['id1', 'id2'] };
      const expectedResult = { items: [{ id: 'id1' }, { id: 'id2' }] };

      mockContentController.batchGet.mockResolvedValue(expectedResult);

      const result = await silo.batchGet(testData);

      expect(mockContentController.batchGet).toHaveBeenCalledWith(
        expect.objectContaining({
          ids: ['id1', 'id2'],
        }),
      );
      expect(result).toEqual(expectedResult);
    });

    it('delete should delegate to content controller', async () => {
      const testData = { id: 'id1' };
      const expectedResult = { success: true };

      mockContentController.delete.mockResolvedValue(expectedResult);

      const result = await silo.delete(testData);

      expect(mockContentController.delete).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'id1',
        }),
      );
      expect(result).toEqual(expectedResult);
    });

    it('stats should delegate to stats controller', async () => {
      const expectedResult = { total: 10, totalSize: 1024, byType: { note: 5 } };

      mockStatsController.getStats.mockResolvedValue(expectedResult);

      const result = await silo.stats({});

      expect(mockStatsController.getStats).toHaveBeenCalled();
      expect(result).toEqual(expectedResult);
    });

    it('should handle validation errors', async () => {
      // Test with invalid data
      const invalidData = { contentType: 123 }; // contentType should be a string

      // Mock Zod error
      vi.spyOn(z.ZodString.prototype, 'parse').mockImplementation(() => {
        throw new z.ZodError([
          {
            code: 'invalid_type',
            expected: 'string',
            received: 'number',
            path: ['contentType'],
            message: 'Expected string, received number',
          },
        ]);
      });

      await expect(silo.simplePut(invalidData as any)).rejects.toThrow('Validation error');

      // Restore mock
      vi.restoreAllMocks();
    });

    it('should handle service errors in simplePut', async () => {
      const testData = { contentType: 'note', content: 'Test content' };
      const serviceError = new Error('Service error');

      mockContentController.simplePut.mockRejectedValue(serviceError);

      await expect(silo.simplePut(testData)).rejects.toThrow('Service error');
      expect(metrics.increment).toHaveBeenCalledWith('silo.rpc.errors', 1, { method: 'simplePut' });
    });

    it('should handle service errors in createUpload', async () => {
      const testData = { contentType: 'note', size: 1024 };
      const serviceError = new Error('Upload service error');

      mockContentController.createUpload.mockRejectedValue(serviceError);

      await expect(silo.createUpload(testData)).rejects.toThrow('Upload service error');
      expect(metrics.increment).toHaveBeenCalledWith('silo.rpc.errors', 1, {
        method: 'createUpload',
      });
    });

    it('should handle service errors in batchGet', async () => {
      const testData = { ids: ['id1', 'id2'] };
      const serviceError = new Error('Batch get error');

      mockContentController.batchGet.mockRejectedValue(serviceError);

      await expect(silo.batchGet(testData)).rejects.toThrow('Batch get error');
      expect(metrics.increment).toHaveBeenCalledWith('silo.rpc.errors', 1, { method: 'batchGet' });
    });

    it('should handle service errors in delete', async () => {
      const testData = { id: 'id1' };
      const serviceError = new Error('Delete error');

      mockContentController.delete.mockRejectedValue(serviceError);

      await expect(silo.delete(testData)).rejects.toThrow('Delete error');
      expect(metrics.increment).toHaveBeenCalledWith('silo.rpc.errors', 1, { method: 'delete' });
    });

    it('should handle service errors in stats', async () => {
      const serviceError = new Error('Stats error');

      mockStatsController.getStats.mockRejectedValue(serviceError);

      await expect(silo.stats({})).rejects.toThrow('Stats error');
      expect(metrics.increment).toHaveBeenCalledWith('silo.rpc.errors', 1, { method: 'stats' });
    });
  });

  describe('Queue Consumer', () => {
    it('should process R2 events', async () => {
      const mockBatch = {
        messages: [
          {
            id: '1',
            timestamp: Date.now(),
            body: {
              type: 'object.created',
              time: new Date().toISOString(),
              eventTime: new Date().toISOString(),
              object: {
                key: 'content/123',
                size: 1024,
                etag: 'etag123',
                httpEtag: 'httpEtag123',
              },
            },
            ack: vi.fn(),
          },
        ],
        queue: 'test-queue',
        retryAll: vi.fn(),
        ackAll: vi.fn(),
      };

      mockContentController.processR2Event.mockResolvedValue({
        id: '123',
        contentType: 'note',
        size: 1024,
        createdAt: 1234567890,
      });

      await silo.queue(mockBatch as any);

      expect(mockContentController.processR2Event).toHaveBeenCalledWith(mockBatch.messages[0].body);
      expect(mockBatch.messages[0].ack).toHaveBeenCalled();
    });
  });

  describe('Error Handling', () => {
    it('should handle queue processing errors', async () => {
      const mockBatch = {
        messages: [
          {
            id: '1',
            timestamp: Date.now(),
            body: {
              type: 'object.created',
              time: new Date().toISOString(),
              eventTime: new Date().toISOString(),
              object: {
                key: 'content/123',
                size: 1024,
                etag: 'etag123',
                httpEtag: 'httpEtag123',
              },
            },
            ack: vi.fn(),
          },
        ],
        queue: 'test-queue',
        retryAll: vi.fn(),
        ackAll: vi.fn(),
      };

      // Simulate an error in processing
      mockContentController.processR2Event.mockRejectedValue(new Error('Processing error'));

      await expect(silo.queue(mockBatch as any)).rejects.toThrow('Processing error');
      expect(metrics.increment).toHaveBeenCalledWith('silo.queue.errors', 1);
      expect(mockBatch.messages[0].ack).not.toHaveBeenCalled();
    });

    it('should handle unsupported event types', async () => {
      const mockBatch = {
        messages: [
          {
            id: '1',
            timestamp: Date.now(),
            body: {
              type: 'object.deleted', // Unsupported event type
              time: new Date().toISOString(),
              eventTime: new Date().toISOString(),
              object: {
                key: 'content/123',
                size: 1024,
                etag: 'etag123',
                httpEtag: 'httpEtag123',
              },
            },
            ack: vi.fn(),
          },
        ],
        queue: 'test-queue',
        retryAll: vi.fn(),
        ackAll: vi.fn(),
      };

      await silo.queue(mockBatch as any);

      // Should acknowledge the message even for unsupported event types
      expect(mockBatch.messages[0].ack).toHaveBeenCalled();
      expect(mockContentController.processR2Event).not.toHaveBeenCalled();
    });
  });
});
