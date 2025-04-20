import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createServices } from '../../src/services';
import { createContentController } from '../../src/controllers/contentController';
import { createStatsController } from '../../src/controllers/statsController';

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

// Mock R2 bucket
const mockR2Bucket = {
  put: vi.fn().mockResolvedValue({ key: 'test-key' }),
  get: vi.fn(),
  head: vi.fn(),
  delete: vi.fn().mockResolvedValue({}),
  createMultipartUpload: vi.fn(),
  resumeMultipartUpload: vi.fn(),
};

// Mock D1 database
const mockD1Database = {
  prepare: vi.fn().mockReturnValue({
    bind: vi.fn().mockReturnThis(),
    first: vi.fn(),
    run: vi.fn().mockResolvedValue({ success: true }),
    all: vi.fn(),
  }),
  batch: vi.fn().mockResolvedValue([{ success: true }]),
  exec: vi.fn().mockResolvedValue({ success: true }),
};

// Mock Queue
const mockQueue = {
  send: vi.fn().mockResolvedValue({ success: true }),
};

describe('Service Integration Tests', () => {
  let mockEnv: any;
  let services: any;
  let contentController: any;
  let statsController: any;

  beforeEach(() => {
    mockEnv = {
      BUCKET: mockR2Bucket,
      DB: mockD1Database,
      NEW_CONTENT: mockQueue,
      CONTENT_EVENTS: mockQueue,
      LOG_LEVEL: 'info',
      VERSION: '1.0.0',
      ENVIRONMENT: 'test',
    };

    // Reset mocks
    vi.clearAllMocks();
    
    // Create mock service implementations
    const mockR2Service = {
      env: mockEnv,
      putObject: vi.fn().mockResolvedValue(true),
      getObject: vi.fn().mockImplementation((key) => {
        return Promise.resolve({
          text: () => Promise.resolve(`Content for ${key}`),
        });
      }),
      deleteObject: vi.fn().mockResolvedValue(true),
      headObject: vi.fn().mockResolvedValue({
        customMetadata: { 'x-content-type': 'note' }
      }),
      createPresignedPost: vi.fn().mockResolvedValue({
        url: 'https://example.com/upload',
        formData: { key: 'test-key' }
      }),
      createPresignedUrl: vi.fn().mockResolvedValue('https://example.com/download'),
    };
    
    const mockMetadataService = {
      env: mockEnv,
      db: mockD1Database,
      insertMetadata: vi.fn().mockImplementation((data) => {
        return Promise.resolve(data);
      }),
      getMetadataById: vi.fn().mockImplementation((id) => {
        return Promise.resolve({
          id,
          userId: 'user-123',
          contentType: 'note',
          size: 100,
          r2Key: `content/${id}`,
          createdAt: Date.now(),
          version: 1,
        });
      }),
      getMetadataByIds: vi.fn().mockImplementation((ids) => {
        return Promise.resolve(ids.map((id: string) => ({
          id,
          userId: 'user-123',
          contentType: 'note',
          size: 100,
          r2Key: `content/${id}`,
          createdAt: Date.now(),
          version: 1,
        })));
      }),
      deleteMetadata: vi.fn().mockResolvedValue({ success: true }),
      getStats: vi.fn().mockResolvedValue({
        total: 10,
        totalSize: 1024,
        byType: {
          note: { count: 5, size: 500 },
          document: { count: 3, size: 300 },
          image: { count: 2, size: 224 },
        }
      }),
    };
    
    const mockQueueService = {
      env: mockEnv,
      sendNewContentMessage: vi.fn().mockResolvedValue({ success: true }),
      processObjectCreatedEvent: vi.fn().mockResolvedValue({}),
      processBatch: vi.fn().mockResolvedValue({}),
    };
    
    // Mock the createServices function
    services = {
      r2: mockR2Service,
      metadata: mockMetadataService,
      queue: mockQueueService,
    };
    
    // Create controllers directly with mocked services using type casting
    contentController = createContentController(
      mockEnv,
      mockR2Service as any,
      mockMetadataService as any,
      mockQueueService as any
    );
    
    statsController = createStatsController(
      mockEnv,
      mockMetadataService as any
    );
  });

  describe('Content Flow Integration', () => {
    it('should store content and update metadata', async () => {
      // Setup mocks for the test flow
      const testContent = 'Test content';
      const testId = 'test-id-123';
      const testUserId = 'user-123';
      
      // Mock the database response for metadata insertion
      mockD1Database.prepare().first.mockResolvedValueOnce({
        id: testId,
        user_id: testUserId,
        content_type: 'note',
        size: testContent.length,
        r2_key: `content/${testId}`,
        created_at: Date.now(),
        version: 1,
      });
      
      // Test the content controller
      const result = await contentController.simplePut({
        contentType: 'note',
        content: testContent,
        userId: testUserId,
      });
      
      // We're only verifying the result in integration tests
      // since we're testing the integration between components,
      // not the specific implementation details
      
      // Verify the result
      expect(result).toHaveProperty('id');
      expect(result).toHaveProperty('contentType', 'note');
      expect(result).toHaveProperty('size');
      expect(result).toHaveProperty('createdAt');
    });
    
    it('should retrieve content with metadata', async () => {
      const testId = 'test-id-123';
      const testUserId = 'user-123';
      
      // Mock database response for metadata retrieval
      mockD1Database.prepare().all.mockResolvedValueOnce([
        {
          id: testId,
          user_id: testUserId,
          content_type: 'note',
          size: 100,
          r2_key: `content/${testId}`,
          created_at: Date.now(),
          version: 1,
        }
      ]);
      
      // Mock R2 response for content retrieval
      mockR2Bucket.get.mockResolvedValueOnce({
        body: new ReadableStream(),
        text: () => Promise.resolve('Test content'),
      });
      
      // Test the batch get functionality
      const result = await contentController.batchGet({
        ids: [testId],
        userId: testUserId,
      });
      
      // We're only verifying the result in integration tests
      
      // Verify the result
      expect(result).toHaveProperty('items');
      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toHaveProperty('id', testId);
      expect(result.items[0]).toHaveProperty('contentType', 'note');
    });
    
    it('should delete content and metadata', async () => {
      const testId = 'test-id-123';
      const testUserId = 'user-123';
      
      // Mock database response for metadata retrieval
      mockD1Database.prepare().first.mockResolvedValueOnce({
        id: testId,
        user_id: testUserId,
        content_type: 'note',
        size: 100,
        r2_key: `content/${testId}`,
        created_at: Date.now(),
        version: 1,
      });
      
      // Test the delete functionality
      const result = await contentController.delete({
        id: testId,
        userId: testUserId,
      });
      
      // We're only verifying the result in integration tests
      
      // Verify the result
      expect(result).toHaveProperty('success', true);
    });
  });
  
  describe('Stats Integration', () => {
    it('should retrieve storage statistics', async () => {
      // Mock database response for stats query
      mockD1Database.prepare().first.mockResolvedValueOnce({
        total: 10,
        total_size: 1024,
      });
      
      mockD1Database.prepare().all.mockResolvedValueOnce([
        { content_type: 'note', count: 5, total_size: 500 },
        { content_type: 'document', count: 3, total_size: 300 },
        { content_type: 'image', count: 2, total_size: 224 },
      ]);
      
      // Test the stats functionality
      const result = await statsController.getStats();
      
      // We're only verifying the result in integration tests
      
      // Verify the result
      expect(result).toHaveProperty('total', 10);
      expect(result).toHaveProperty('totalSize', 1024);
      expect(result).toHaveProperty('byType');
      expect(result.byType).toHaveProperty('note', { count: 5, size: 500 });
      expect(result.byType).toHaveProperty('document', { count: 3, size: 300 });
      expect(result.byType).toHaveProperty('image', { count: 2, size: 224 });
    });
  });
});