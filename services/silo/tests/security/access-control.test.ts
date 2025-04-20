import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createContentController } from '../../src/controllers/contentController';

// Mock ulid to return predictable IDs
vi.mock('ulid', () => ({
  ulid: vi.fn().mockReturnValue('test-id-123456'),
}));

// Mock logging
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

describe('Silo Security and Access Control', () => {
  let contentController: any;
  let mockEnv: any;
  let mockR2Service: any;
  let mockMetadataService: any;
  let mockQueueService: any;

  beforeEach(() => {
    mockEnv = {
      BUCKET: {},
      DB: {},
      NEW_CONTENT: {},
    };

    // Create mock services
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
    };

    mockMetadataService = {
      insertMetadata: vi.fn().mockResolvedValue({}),
      getMetadataById: vi.fn(),
      getMetadataByIds: vi.fn(),
      deleteMetadata: vi.fn().mockResolvedValue({}),
      getStats: vi.fn(),
    };

    mockQueueService = {
      sendNewContentMessage: vi.fn().mockResolvedValue({}),
    };

    contentController = createContentController(
      mockEnv,
      mockR2Service,
      mockMetadataService,
      mockQueueService,
    );

    vi.clearAllMocks();
  });

  describe('Content Access Control', () => {
    it('should enforce access control for private content', async () => {
      // Setup test data
      const ownerUserId = 'user-123';
      const otherUserId = 'user-456';
      const contentId = 'private-content-123';
      
      // Mock private content metadata
      const privateContentMetadata = {
        id: contentId,
        userId: ownerUserId, // Owned by user-123
        contentType: 'note',
        size: 100,
        r2Key: `content/${contentId}`,
        createdAt: Date.now(),
        version: 1,
      };
      
      // Mock metadata service to return the private content
      mockMetadataService.getMetadataByIds = vi.fn().mockResolvedValue([privateContentMetadata]);
      
      // Test access by owner
      const ownerResult = await contentController.batchGet({
        ids: [contentId],
        userId: ownerUserId,
      });
      
      // Owner should be able to access their content
      expect(ownerResult.items).toHaveLength(1);
      expect(ownerResult.items[0].id).toBe(contentId);
      
      // Test access by another user
      const otherUserResult = await contentController.batchGet({
        ids: [contentId],
        userId: otherUserId,
      });
      
      // Other user should not see the private content
      expect(otherUserResult.items).toHaveLength(0);
    });
    
    it('should enforce authorization for content deletion', async () => {
      // Setup test data
      const ownerUserId = 'user-123';
      const otherUserId = 'user-456';
      const contentId = 'private-content-123';
      
      // Mock private content metadata
      const privateContentMetadata = {
        id: contentId,
        userId: ownerUserId, // Owned by user-123
        contentType: 'note',
        size: 100,
        r2Key: `content/${contentId}`,
        createdAt: Date.now(),
        version: 1,
      };
      
      // Mock metadata service to return the private content
      mockMetadataService.getMetadataById = vi.fn().mockResolvedValue(privateContentMetadata);
      
      // Test deletion by owner
      const deleteByOwner = async () => {
        return await contentController.delete({
          id: contentId,
          userId: ownerUserId,
        });
      };
      
      // Owner should be able to delete their content
      await expect(deleteByOwner()).resolves.toEqual({ success: true });
      expect(mockR2Service.deleteObject).toHaveBeenCalledWith(`content/${contentId}`);
      
      vi.clearAllMocks();
      
      // Test deletion by another user
      const deleteByOtherUser = async () => {
        return await contentController.delete({
          id: contentId,
          userId: otherUserId,
        });
      };
      
      // Other user should not be able to delete the content
      await expect(deleteByOtherUser()).rejects.toThrow('Unauthorized');
      expect(mockR2Service.deleteObject).not.toHaveBeenCalled();
    });
  });
});