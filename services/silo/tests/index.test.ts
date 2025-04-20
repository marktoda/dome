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
vi.mock('@dome/logging', () => ({
  withLogger: vi.fn((_, fn) => fn()),
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
import { metrics } from '@dome/logging';
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
      CONTENT_EVENTS: {},
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
});
