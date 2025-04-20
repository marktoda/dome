import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ContentController,
  createContentController,
} from '../../src/controllers/contentController';
import { R2Service } from '../../src/services/r2Service';
import { MetadataService } from '../../src/services/metadataService';
import { QueueService } from '../../src/services/queueService';
import { ulid } from 'ulid';

// Mock ulid to return predictable IDs
vi.mock('ulid', () => ({
  ulid: vi.fn().mockReturnValue('test-id-123456'),
}));

describe('ContentController', () => {
  let contentController: ContentController;
  let mockEnv: any;
  let mockR2Service: R2Service;
  let mockMetadataService: MetadataService;
  let mockQueueService: QueueService;

  beforeEach(() => {
    mockEnv = {
      BUCKET: {},
      DB: {},
      NEW_CONTENT: {},
    };

    // Create mock services with proper typing for vitest mocks
    mockR2Service = {
      putObject: vi.fn().mockResolvedValue(true),
      getObject: vi.fn(),
      deleteObject: vi.fn().mockResolvedValue(true),
      headObject: vi.fn(),
      createPresignedPost: vi.fn().mockResolvedValue({
        url: 'https://example.com/upload',
        formData: {
          key: 'upload/test-id',
          'x-amz-algorithm': 'AWS4-HMAC-SHA256',
        },
      }),
      createPresignedUrl: vi.fn().mockResolvedValue('https://example.com/download'),
    } as unknown as R2Service;

    mockMetadataService = {
      insertMetadata: vi.fn().mockResolvedValue({}),
      getMetadataById: vi.fn(),
      getMetadataByIds: vi.fn(),
      deleteMetadata: vi.fn().mockResolvedValue({}),
      getStats: vi.fn(),
    } as unknown as MetadataService;

    mockQueueService = {
      sendNewContentMessage: vi.fn().mockResolvedValue({}),
    } as unknown as QueueService;

    contentController = createContentController(
      mockEnv,
      mockR2Service,
      mockMetadataService,
      mockQueueService,
    );

    vi.clearAllMocks();
  });

  describe('simplePut', () => {
    it('should store content in R2 and return metadata', async () => {
      const testData = {
        contentType: 'note',
        content: 'Test content',
        userId: 'user123',
      };

      const result = await contentController.simplePut(testData);

      // Verify R2Service.putObject was called with correct parameters
      expect(mockR2Service.putObject).toHaveBeenCalledWith(
        'content/test-id-123456',
        'Test content',
        expect.objectContaining({
          userId: 'user123',
          contentType: 'note',
        }),
      );

      // Verify the result has expected properties
      expect(result).toHaveProperty('id', 'test-id-123456');
      expect(result).toHaveProperty('contentType', 'note');
      expect(result).toHaveProperty('size');
      expect(result).toHaveProperty('createdAt');
    });

    it('should handle content size validation', async () => {
      // Test with content exceeding size limit
      const largeContent = new Array(1024 * 1024 + 1).fill('a').join('');
      const largeData = {
        contentType: 'note',
        content: largeContent,
      };

      await expect(contentController.simplePut(largeData)).rejects.toThrow(
        /exceeds maximum allowed size/,
      );
    });

    it('should handle ArrayBuffer content', async () => {
      const buffer = new ArrayBuffer(100);
      const testData = {
        contentType: 'binary',
        content: buffer,
      };

      const result = await contentController.simplePut(testData);

      expect(mockR2Service.putObject).toHaveBeenCalledWith(
        'content/test-id-123456',
        buffer,
        expect.any(Object),
      );
      expect(result.size).toBe(100);
    });
  });

  describe('createUpload', () => {
    it('should generate pre-signed POST policy', async () => {
      const testData = {
        contentType: 'note',
        size: 1024,
        userId: 'user123',
        expirationSeconds: 900,
      };

      const result = await contentController.createUpload(testData);

      // Verify R2Service.createPresignedPost was called with correct parameters
      expect(mockR2Service.createPresignedPost).toHaveBeenCalledWith(
        expect.objectContaining({
          key: 'upload/test-id-123456',
          metadata: expect.objectContaining({
            'x-user-id': 'user123',
            'x-content-type': 'note',
          }),
          expiration: 900,
        }),
      );

      // Verify the result has expected properties
      expect(result).toHaveProperty('id', 'test-id-123456');
      expect(result).toHaveProperty('uploadUrl', 'https://example.com/upload');
      expect(result).toHaveProperty('formData');
      expect(result).toHaveProperty('expiresIn', 900);
    });

    it('should use default expiration if not provided', async () => {
      const testData = {
        contentType: 'note',
        size: 1024,
      };

      await contentController.createUpload(testData);

      // Verify default expiration of 900 seconds (15 minutes) was used
      expect(mockR2Service.createPresignedPost).toHaveBeenCalledWith(
        expect.objectContaining({
          expiration: 900,
        }),
      );
    });

    it('should validate size parameter', async () => {
      // Test with size exceeding maximum
      const oversizedData = {
        contentType: 'note',
        size: 101 * 1024 * 1024, // 101 MiB
      };

      await expect(contentController.createUpload(oversizedData)).rejects.toThrow(
        /exceeds maximum allowed size/,
      );
    });

    it('should include optional metadata and SHA256 if provided', async () => {
      const testData = {
        contentType: 'note',
        size: 1024,
        metadata: { title: 'Test Note', tags: ['test'] },
        sha256: 'abc123',
      };

      await contentController.createUpload(testData);

      expect(mockR2Service.createPresignedPost).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            'x-metadata': JSON.stringify(testData.metadata),
            'x-sha256': 'abc123',
          }),
        }),
      );
    });
  });

  describe('batchGet', () => {
    it('should retrieve content metadata and filter by ACL', async () => {
      const testIds = ['id1', 'id2', 'id3'];
      const mockMetadata = [
        {
          id: 'id1',
          userId: null,
          contentType: 'note',
          size: 10,
          r2Key: 'content/id1',
          createdAt: 100,
        },
        {
          id: 'id2',
          userId: 'user123',
          contentType: 'code',
          size: 20,
          r2Key: 'content/id2',
          createdAt: 200,
        },
        {
          id: 'id3',
          userId: 'different-user',
          contentType: 'image',
          size: 30,
          r2Key: 'content/id3',
          createdAt: 300,
        },
      ];

      (mockMetadataService.getMetadataByIds as any).mockResolvedValue(mockMetadata);

      // Mock R2Service.getObject to return content for small files
      (mockR2Service.getObject as any).mockImplementation((key: string) => {
        if (key === 'content/id1') {
          return Promise.resolve({ text: () => Promise.resolve('content1') });
        } else if (key === 'content/id2') {
          return Promise.resolve({ text: () => Promise.resolve('content2') });
        }
        return Promise.resolve(null);
      });

      const result = await contentController.batchGet({ ids: testIds, userId: 'user123' });

      // Verify MetadataService was called
      expect(mockMetadataService.getMetadataByIds).toHaveBeenCalledWith(testIds);

      // Verify result contains only items the user has access to (public or owned by user)
      expect(result.items).toHaveLength(2);
      expect(result.items.map(item => item.id)).toContain('id1'); // public
      expect(result.items.map(item => item.id)).toContain('id2'); // owned by user123
      expect(result.items.map(item => item.id)).not.toContain('id3'); // owned by different-user

      // Verify content was fetched
      expect(mockR2Service.getObject).toHaveBeenCalledWith('content/id1');
      expect(mockR2Service.getObject).toHaveBeenCalledWith('content/id2');
      expect(mockR2Service.getObject).not.toHaveBeenCalledWith('content/id3');
    });

    it('should generate signed URLs for large content', async () => {
      const mockMetadata = [
        {
          id: 'id1',
          userId: null,
          contentType: 'note',
          size: 2 * 1024 * 1024,
          r2Key: 'content/id1',
          createdAt: 100,
        },
      ];

      (mockMetadataService.getMetadataByIds as any).mockResolvedValue(mockMetadata);
      (mockR2Service.getObject as any).mockResolvedValue({
        text: () => Promise.resolve('large content'),
      });

      const result = await contentController.batchGet({ ids: ['id1'] });

      // Verify signed URL was generated for large content
      expect(mockR2Service.createPresignedUrl).toHaveBeenCalledWith(
        'content/id1',
        expect.any(Object),
      );
      expect(result.items[0]).toHaveProperty('url', 'https://example.com/download');
      expect(result.items[0]).not.toHaveProperty('body');
    });
  });

  describe('delete', () => {
    it('should delete content from R2 and metadata', async () => {
      const testId = 'id1';
      const mockMetadata = {
        id: 'id1',
        userId: 'user123',
        r2Key: 'content/id1',
        contentType: 'note',
        size: 10,
        createdAt: 100,
      };

      (mockMetadataService.getMetadataById as any).mockResolvedValue(mockMetadata);

      const result = await contentController.delete({ id: testId, userId: 'user123' });

      // Verify MetadataService methods were called
      expect(mockMetadataService.getMetadataById).toHaveBeenCalledWith(testId);
      expect(mockMetadataService.deleteMetadata).toHaveBeenCalledWith(testId);

      // Verify R2Service.deleteObject was called
      expect(mockR2Service.deleteObject).toHaveBeenCalledWith('content/id1');

      // Verify notification was sent
      expect(mockQueueService.sendNewContentMessage).toHaveBeenCalledWith({
        id: testId,
        userId: 'user123',
        deleted: true,
      });

      // Verify result
      expect(result).toEqual({ success: true });
    });

    it('should throw error if content not found', async () => {
      (mockMetadataService.getMetadataById as any).mockResolvedValue(null);

      await expect(
        contentController.delete({ id: 'nonexistent', userId: 'user123' }),
      ).rejects.toThrow('Content not found');
    });

    it('should throw error if unauthorized', async () => {
      const mockMetadata = {
        id: 'id1',
        userId: 'user123',
        r2Key: 'content/id1',
        contentType: 'note',
        size: 10,
        createdAt: 100,
      };

      (mockMetadataService.getMetadataById as any).mockResolvedValue(mockMetadata);

      await expect(
        contentController.delete({ id: 'id1', userId: 'different-user' }),
      ).rejects.toThrow('Unauthorized');
    });
  });

  describe('processR2Event', () => {
    it('should process object created events', async () => {
      const event = {
        type: 'object.created',
        time: new Date().toISOString(),
        eventTime: new Date().toISOString(),
        object: {
          key: 'content/test-id',
          size: 1024,
          etag: 'etag123',
          httpEtag: 'httpEtag123',
        },
      };

      const mockObject = {
        size: 1024,
        customMetadata: {
          'x-user-id': 'user123',
          'x-content-type': 'note',
          'x-metadata': JSON.stringify({ title: 'Test Note' }),
        },
      };

      (mockR2Service.headObject as any).mockResolvedValue(mockObject);

      const result = await contentController.processR2Event(event);

      // Verify R2Service.headObject was called
      expect(mockR2Service.headObject).toHaveBeenCalledWith('content/test-id');

      // Verify MetadataService.insertMetadata was called with correct parameters
      expect(mockMetadataService.insertMetadata).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'test-id',
          userId: 'user123',
          contentType: 'note',
          size: 1024,
          r2Key: 'content/test-id',
        }),
      );

      // Verify QueueService.sendNewContentMessage was called
      expect(mockQueueService.sendNewContentMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'test-id',
          userId: 'user123',
          contentType: 'note',
          size: 1024,
          metadata: { title: 'Test Note' },
        }),
      );

      // Verify result
      expect(result).toHaveProperty('id', 'test-id');
      expect(result).toHaveProperty('contentType', 'note');
      expect(result).toHaveProperty('size', 1024);
      expect(result).toHaveProperty('createdAt');
    });

    it('should handle upload/ prefix in keys', async () => {
      const event = {
        type: 'object.created',
        time: new Date().toISOString(),
        eventTime: new Date().toISOString(),
        object: {
          key: 'upload/test-id',
          size: 1024,
          etag: 'etag123',
          httpEtag: 'httpEtag123',
        },
      };

      const mockObject = {
        size: 1024,
        customMetadata: {
          userId: 'user123',
          contentType: 'note',
        },
      };

      (mockR2Service.headObject as any).mockResolvedValue(mockObject);

      const result = await contentController.processR2Event(event);

      // Verify the ID was extracted correctly from the upload/ prefix
      expect(mockMetadataService.insertMetadata).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'test-id',
        }),
      );

      expect(result).toHaveProperty('id', 'test-id');
    });

    it('should handle missing object', async () => {
      const event = {
        type: 'object.created',
        time: new Date().toISOString(),
        eventTime: new Date().toISOString(),
        object: {
          key: 'content/test-id',
          size: 1024,
          etag: 'etag123',
          httpEtag: 'httpEtag123',
        },
      };

      (mockR2Service.headObject as any).mockResolvedValue(null);

      const result = await contentController.processR2Event(event);

      // Verify no metadata was inserted
      expect(mockMetadataService.insertMetadata).not.toHaveBeenCalled();
      expect(mockQueueService.sendNewContentMessage).not.toHaveBeenCalled();
      expect(result).toBeNull();
    });
  });
});
