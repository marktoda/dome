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
}));

vi.mock('../src/utils/logging', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../src/utils/metrics', () => ({
  metrics: {
    increment: vi.fn(),
    gauge: vi.fn(),
    timing: vi.fn(),
    startTimer: vi.fn(() => ({
      stop: vi.fn(),
    })),
  },
}));

// Mock drizzle-orm/d1
vi.mock('drizzle-orm/d1', () => ({
  drizzle: vi.fn().mockReturnValue({
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockResolvedValue({}),
    }),
  }),
}));

// Import mocks after they've been defined
import { metrics } from '../src/utils/metrics';

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
    it('simplePut should store content and metadata', async () => {
      // Mock the necessary methods
      mockEnv.BUCKET = {
        put: vi.fn().mockResolvedValue({}),
      };
      
      mockEnv.DB = {
        prepare: vi.fn().mockReturnValue({
          bind: vi.fn().mockReturnThis(),
          run: vi.fn().mockResolvedValue({}),
        }),
      };
      
      // The drizzle mock is already set up globally
      
      const testData = {
        contentType: 'note',
        content: 'Test content',
        userId: 'user123',
      };
      
      const result = await silo.simplePut(testData);
      
      // Verify the result has expected properties
      expect(result).toHaveProperty('id');
      expect(result).toHaveProperty('contentType', 'note');
      expect(result).toHaveProperty('size');
      expect(result).toHaveProperty('createdAt');
      
      // Verify R2 bucket put was called
      expect(mockEnv.BUCKET.put).toHaveBeenCalled();
      
      // Verify metrics were recorded
      expect(metrics.increment).toHaveBeenCalledWith('silo.upload.bytes', expect.any(Number));
      expect(metrics.timing).toHaveBeenCalledWith('silo.db.write.latency_ms', expect.any(Number));
    });
    
    it('simplePut should validate input parameters', async () => {
      // Test with empty content
      const emptyData = {
        contentType: 'note',
        content: '',
      };
      
      await expect(silo.simplePut(emptyData)).rejects.toThrow('Content cannot be empty');
      
      // Test with content exceeding size limit
      const largeContent = new Array(1024 * 1024 + 1).fill('a').join('');
      const largeData = {
        contentType: 'note',
        content: largeContent,
      };
      
      await expect(silo.simplePut(largeData)).rejects.toThrow('Content size exceeds maximum allowed size');
    });

    describe('createUpload', () => {
      beforeEach(() => {
        // Mock the R2 bucket's createPresignedPost method
        mockEnv.BUCKET = {
          createPresignedPost: vi.fn().mockResolvedValue({
            url: 'https://example.com/upload',
            formData: {
              key: 'upload/test-id',
              'x-amz-algorithm': 'AWS4-HMAC-SHA256',
              'x-amz-credential': 'test-credential',
              'x-amz-date': '20250419T000000Z',
              'x-amz-signature': 'test-signature',
              policy: 'test-policy'
            }
          })
        };
      });

      it('should generate pre-signed POST policy with default settings', async () => {
        const testData = {
          contentType: 'note',
          size: 1024,
          userId: 'user123'
        };
        
        const result = await silo.createUpload(testData);
        
        // Verify the result has expected properties
        expect(result).toHaveProperty('id');
        expect(result).toHaveProperty('uploadUrl', 'https://example.com/upload');
        expect(result).toHaveProperty('formData');
        expect(result).toHaveProperty('expiresIn', 900); // Default 15 minutes
        
        // Verify R2 bucket createPresignedPost was called with correct parameters
        expect(mockEnv.BUCKET.createPresignedPost).toHaveBeenCalledWith({
          key: expect.stringMatching(/^upload\/.+/),
          metadata: {
            'x-user-id': 'user123',
            'x-content-type': 'note'
          },
          conditions: [
            ['content-length-range', 0, 100 * 1024 * 1024]
          ],
          expiration: 900
        });
        
        // Verify metrics were recorded
        expect(metrics.increment).toHaveBeenCalledWith('silo.presigned_post.created', 1);
        expect(metrics.timing).toHaveBeenCalledWith('silo.presigned_post.latency_ms', expect.any(Number));
      });
      
      it('should handle custom expiration time', async () => {
        const testData = {
          contentType: 'note',
          size: 1024,
          expirationSeconds: 3600 // 1 hour
        };
        
        const result = await silo.createUpload(testData);
        
        expect(result.expiresIn).toBe(3600);
        expect(mockEnv.BUCKET.createPresignedPost).toHaveBeenCalledWith(
          expect.objectContaining({
            expiration: 3600
          })
        );
      });
      
      it('should include optional metadata and SHA256 hash', async () => {
        const testData = {
          contentType: 'note',
          size: 1024,
          metadata: { title: 'Test Note', tags: ['test', 'note'] },
          sha256: 'abcdef1234567890'
        };
        
        await silo.createUpload(testData);
        
        expect(mockEnv.BUCKET.createPresignedPost).toHaveBeenCalledWith(
          expect.objectContaining({
            metadata: expect.objectContaining({
              'x-metadata': JSON.stringify(testData.metadata),
              'x-sha256': 'abcdef1234567890'
            })
          })
        );
      });
      
      it('should validate size parameter', async () => {
        // Test with missing size
        await expect(silo.createUpload({ contentType: 'note' }))
          .rejects.toThrow(/size/i);
        
        // Test with negative size
        await expect(silo.createUpload({ contentType: 'note', size: -10 }))
          .rejects.toThrow(/positive/i);
        
        // Test with size exceeding maximum
        const oversizedData = {
          contentType: 'note',
          size: 101 * 1024 * 1024 // 101 MiB
        };
        
        await expect(silo.createUpload(oversizedData))
          .rejects.toThrow(/exceeds maximum allowed size/i);
      });
      
      it('should validate expiration time', async () => {
        // Test with expiration time too short
        await expect(silo.createUpload({
          contentType: 'note',
          size: 1024,
          expirationSeconds: 30 // Too short
        })).rejects.toThrow(/minimum/i);
        
        // Test with expiration time too long
        await expect(silo.createUpload({
          contentType: 'note',
          size: 1024,
          expirationSeconds: 7200 // Too long
        })).rejects.toThrow(/maximum/i);
      });
    });

    it('batchGet should throw NotImplementedError', async () => {
      await expect(silo.batchGet({})).rejects.toThrow(NotImplementedError);
    });

    it('delete should throw NotImplementedError', async () => {
      await expect(silo.delete({})).rejects.toThrow(NotImplementedError);
    });

    it('stats should throw NotImplementedError', async () => {
      await expect(silo.stats({})).rejects.toThrow(NotImplementedError);
    });
  });

  describe('Queue Consumer', () => {
    it('should process queue messages', async () => {
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

      await silo.queue(mockBatch as any);
      
      // Verify metrics were recorded
      expect(metrics.gauge).toHaveBeenCalledWith(
        'silo.queue.batch_size',
        1
      );
      expect(metrics.timing).toHaveBeenCalledWith(
        'silo.queue.process_time_ms',
        expect.any(Number)
      );
    });
  });
});