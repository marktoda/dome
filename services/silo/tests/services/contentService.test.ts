import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContentService, createContentService } from '../../src/services/contentService';
import { ContentRepository } from '../../src/repositories/contentRepository';

describe('ContentService', () => {
  let contentService: ContentService;
  let mockEnv: any;
  let mockContentRepository: ContentRepository;

  beforeEach(() => {
    mockEnv = {
      BUCKET: {
        put: vi.fn().mockResolvedValue({}),
        delete: vi.fn().mockResolvedValue({}),
        createPresignedPost: vi.fn().mockResolvedValue({
          url: 'https://example.com/upload',
          formData: {
            key: 'upload/test-id',
            'x-amz-algorithm': 'AWS4-HMAC-SHA256',
          }
        }),
      },
      NEW_CONTENT: {
        send: vi.fn().mockResolvedValue({}),
      },
    };

    mockContentRepository = {
      insertContent: vi.fn().mockResolvedValue({}),
      getContentById: vi.fn(),
      getContentByIds: vi.fn(),
      deleteContent: vi.fn().mockResolvedValue({}),
      getStats: vi.fn(),
    } as unknown as ContentRepository;

    contentService = createContentService(mockEnv, mockContentRepository);

    vi.clearAllMocks();
  });

  describe('simplePut', () => {
    it('should store content in R2 and metadata in repository', async () => {
      const testData = {
        contentType: 'note',
        content: 'Test content',
        userId: 'user123',
      };

      const result = await contentService.simplePut(testData);

      // Verify R2 bucket put was called
      expect(mockEnv.BUCKET.put).toHaveBeenCalled();
      expect(mockEnv.BUCKET.put.mock.calls[0][0]).toMatch(/^content\/.+/);
      expect(mockEnv.BUCKET.put.mock.calls[0][1]).toBe('Test content');

      // Verify repository insertContent was called
      expect(mockContentRepository.insertContent).toHaveBeenCalled();
      const insertCall = mockContentRepository.insertContent.mock.calls[0][0];
      expect(insertCall.contentType).toBe('note');
      expect(insertCall.userId).toBe('user123');
      expect(insertCall.r2Key).toMatch(/^content\/.+/);

      // Verify the result has expected properties
      expect(result).toHaveProperty('id');
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

      await expect(contentService.simplePut(largeData)).rejects.toThrow(/exceeds maximum allowed size/);
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

      const result = await contentService.createUpload(testData);

      // Verify R2 bucket createPresignedPost was called with correct parameters
      expect(mockEnv.BUCKET.createPresignedPost).toHaveBeenCalled();
      const callArgs = mockEnv.BUCKET.createPresignedPost.mock.calls[0][0];
      expect(callArgs.key).toMatch(/^upload\/.+/);
      expect(callArgs.metadata['x-user-id']).toBe('user123');
      expect(callArgs.metadata['x-content-type']).toBe('note');
      expect(callArgs.expiration).toBe(900);

      // Verify the result has expected properties
      expect(result).toHaveProperty('id');
      expect(result).toHaveProperty('uploadUrl', 'https://example.com/upload');
      expect(result).toHaveProperty('formData');
      expect(result).toHaveProperty('expiresIn', 900);
    });

    it('should validate size parameter', async () => {
      // Test with size exceeding maximum
      const oversizedData = {
        contentType: 'note',
        size: 101 * 1024 * 1024, // 101 MiB
      };

      await expect(contentService.createUpload(oversizedData)).rejects.toThrow(/exceeds maximum allowed size/);
    });
  });

  describe('batchGet', () => {
    it('should retrieve content metadata from repository', async () => {
      const testIds = ['id1', 'id2'];
      const mockMetadata = [
        { id: 'id1', userId: null, contentType: 'note', size: 10, r2Key: 'content/id1', createdAt: 100, version: 1 },
        { id: 'id2', userId: 'user123', contentType: 'code', size: 20, r2Key: 'content/id2', createdAt: 200, version: 1 },
      ];

      mockContentRepository.getContentByIds.mockResolvedValue(mockMetadata);
      
      // Mock BUCKET.get to return content for id1 and a URL for id2
      mockEnv.BUCKET.get = vi.fn().mockImplementation((key) => {
        if (key === 'content/id1') {
          return { text: async () => 'content1' };
        }
        return { text: async () => 'content2' };
      });
      
      mockEnv.BUCKET.createPresignedUrl = vi.fn().mockResolvedValue('https://example.com/id2');

      const result = await contentService.batchGet({ ids: testIds, userId: 'user123' });

      // Verify repository was called
      expect(mockContentRepository.getContentByIds).toHaveBeenCalledWith(testIds);
      
      // Verify result contains both items
      expect(result.items).toHaveLength(2);
      expect(result.items[0].id).toBe('id1');
      expect(result.items[1].id).toBe('id2');
      
      // Verify content was fetched
      expect(mockEnv.BUCKET.get).toHaveBeenCalledWith('content/id1');
      expect(mockEnv.BUCKET.get).toHaveBeenCalledWith('content/id2');
    });
  });

  describe('delete', () => {
    it('should delete content from R2 and repository', async () => {
      const testId = 'id1';
      const mockMetadata = { id: 'id1', userId: 'user123', r2Key: 'content/id1', contentType: 'note', size: 10, createdAt: 100, version: 1 };
      
      mockContentRepository.getContentById.mockResolvedValue(mockMetadata);

      const result = await contentService.delete({ id: testId, userId: 'user123' });

      // Verify repository methods were called
      expect(mockContentRepository.getContentById).toHaveBeenCalledWith(testId);
      expect(mockContentRepository.deleteContent).toHaveBeenCalledWith(testId);
      
      // Verify R2 delete was called
      expect(mockEnv.BUCKET.delete).toHaveBeenCalledWith('content/id1');
      
      // Verify notification was sent
      expect(mockEnv.NEW_CONTENT.send).toHaveBeenCalledWith({
        id: testId,
        userId: 'user123',
        deleted: true
      });
      
      // Verify result
      expect(result).toEqual({ success: true });
    });

    it('should throw error if content not found', async () => {
      mockContentRepository.getContentById.mockResolvedValue(null);

      await expect(contentService.delete({ id: 'nonexistent', userId: 'user123' }))
        .rejects.toThrow('Content not found');
    });

    it('should throw error if unauthorized', async () => {
      const mockMetadata = { id: 'id1', userId: 'user123', r2Key: 'content/id1', contentType: 'note', size: 10, createdAt: 100, version: 1 };
      
      mockContentRepository.getContentById.mockResolvedValue(mockMetadata);

      await expect(contentService.delete({ id: 'id1', userId: 'different-user' }))
        .rejects.toThrow('Unauthorized');
    });
  });
});