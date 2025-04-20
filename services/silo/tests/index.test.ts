import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotImplementedError } from '@dome/common';
import Silo from '../src/index';

// Mock WorkerEntrypoint
vi.mock('cloudflare:workers', () => ({
  WorkerEntrypoint: class {
    protected env: any;
    constructor(ctx: any, env: any) {
      this.env = env;
    }
  }
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

// Mock services
vi.mock('../src/services', () => {
  const mockContentService = {
    simplePut: vi.fn(),
    createUpload: vi.fn(),
    batchGet: vi.fn(),
    delete: vi.fn(),
  };
  
  const mockQueueService = {
    processBatch: vi.fn(),
    processObjectCreatedEvent: vi.fn(),
  };
  
  const mockStatsService = {
    getStats: vi.fn(),
  };
  
  return {
    createServices: vi.fn(() => ({
      content: mockContentService,
      queue: mockQueueService,
      stats: mockStatsService,
    })),
  };
});

// Import mocks after they've been defined
import { metrics } from '@dome/logging';
import { createServices } from '../src/services';

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
    it('simplePut should delegate to content service', async () => {
      const testData = { contentType: 'note', content: 'Test content' };
      const expectedResult = { id: 'test-id', contentType: 'note', size: 123, createdAt: 1234567890 };
      
      const services = (createServices as any)();
      services.content.simplePut.mockResolvedValue(expectedResult);
      
      const result = await silo.simplePut(testData);
      
      expect(services.content.simplePut).toHaveBeenCalledWith(testData);
      expect(result).toEqual(expectedResult);
    });
    
    it('createUpload should delegate to content service', async () => {
      const testData = { contentType: 'note', size: 1024 };
      const expectedResult = { id: 'test-id', uploadUrl: 'https://example.com' };
      
      const services = (createServices as any)();
      services.content.createUpload.mockResolvedValue(expectedResult);
      
      const result = await silo.createUpload(testData);
      
      expect(services.content.createUpload).toHaveBeenCalledWith(testData);
      expect(result).toEqual(expectedResult);
    });
    
    it('batchGet should delegate to content service', async () => {
      const testData = { ids: ['id1', 'id2'] };
      const expectedResult = { items: [{ id: 'id1' }, { id: 'id2' }] };
      
      const services = (createServices as any)();
      services.content.batchGet.mockResolvedValue(expectedResult);
      
      const result = await silo.batchGet(testData);
      
      expect(services.content.batchGet).toHaveBeenCalledWith(testData);
      expect(result).toEqual(expectedResult);
    });
    
    it('delete should delegate to content service', async () => {
      const testData = { id: 'id1' };
      const expectedResult = { success: true };
      
      const services = (createServices as any)();
      services.content.delete.mockResolvedValue(expectedResult);
      
      const result = await silo.delete(testData);
      
      expect(services.content.delete).toHaveBeenCalledWith(testData);
      expect(result).toEqual(expectedResult);
    });
    
    it('stats should delegate to stats service', async () => {
      const expectedResult = { total: 10, totalSize: 1024, byType: { note: 5 } };
      
      const services = (createServices as any)();
      services.stats.getStats.mockResolvedValue(expectedResult);
      
      const result = await silo.stats({});
      
      expect(services.stats.getStats).toHaveBeenCalled();
      expect(result).toEqual(expectedResult);
    });
  });

  describe('Queue Consumer', () => {
    it('should delegate to queue service', async () => {
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
          },
        ],
        queue: 'test-queue',
        retryAll: vi.fn(),
        ackAll: vi.fn()
      };

      const services = (createServices as any)();
      
      await silo.queue(mockBatch as any);
      
      expect(services.queue.processBatch).toHaveBeenCalledWith(mockBatch);
    });
  });
});