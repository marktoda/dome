import { describe, it, expect, vi, beforeEach } from 'vitest';
import { R2Service, createR2Service } from '../../src/services/r2Service';

describe('R2Service', () => {
  let r2Service: R2Service;
  let mockEnv: any;
  let mockBucket: any;

  beforeEach(() => {
    // Create mock bucket with all required methods
    mockBucket = {
      put: vi.fn().mockResolvedValue({}),
      get: vi.fn(),
      delete: vi.fn().mockResolvedValue({}),
      head: vi.fn(),
      createPresignedPost: vi.fn(),
      createPresignedUrl: vi.fn(),
    };

    mockEnv = {
      BUCKET: mockBucket,
    };

    r2Service = createR2Service(mockEnv);

    vi.clearAllMocks();
  });

  describe('putObject', () => {
    it('should store content in R2 bucket', async () => {
      const key = 'content/test-id';
      const content = 'Test content';
      const metadata = { userId: 'user123', contentType: 'note' };

      await r2Service.putObject(key, content, metadata);

      // Verify bucket.put was called with correct parameters
      expect(mockBucket.put).toHaveBeenCalledWith(key, content, {
        httpMetadata: {
          contentType: 'application/octet-stream',
        },
        customMetadata: metadata,
      });
    });

    it('should handle ArrayBuffer content', async () => {
      const key = 'content/test-id';
      const content = new ArrayBuffer(100);
      const metadata = { userId: 'user123', contentType: 'binary' };

      await r2Service.putObject(key, content, metadata);

      expect(mockBucket.put).toHaveBeenCalledWith(key, content, expect.any(Object));
    });

    it('should handle errors', async () => {
      const error = new Error('R2 error');
      mockBucket.put.mockRejectedValue(error);

      await expect(r2Service.putObject('key', 'content')).rejects.toThrow('R2 error');
    });
  });

  describe('getObject', () => {
    it('should retrieve content from R2 bucket', async () => {
      const key = 'content/test-id';
      const mockObject = { text: () => Promise.resolve('Test content') };

      mockBucket.get.mockResolvedValue(mockObject);

      const result = await r2Service.getObject(key);

      // Verify bucket.get was called with correct key
      expect(mockBucket.get).toHaveBeenCalledWith(key);
      expect(result).toBe(mockObject);
    });

    it('should return null if object not found', async () => {
      mockBucket.get.mockResolvedValue(null);

      const result = await r2Service.getObject('nonexistent');

      expect(result).toBeNull();
    });

    it('should handle errors', async () => {
      const error = new Error('R2 error');
      mockBucket.get.mockRejectedValue(error);

      await expect(r2Service.getObject('key')).rejects.toThrow('R2 error');
    });
  });

  describe('deleteObject', () => {
    it('should delete content from R2 bucket', async () => {
      const key = 'content/test-id';

      await r2Service.deleteObject(key);

      // Verify bucket.delete was called with correct key
      expect(mockBucket.delete).toHaveBeenCalledWith(key);
    });

    it('should handle errors', async () => {
      const error = new Error('R2 error');
      mockBucket.delete.mockRejectedValue(error);

      await expect(r2Service.deleteObject('key')).rejects.toThrow('R2 error');
    });
  });

  describe('headObject', () => {
    it('should retrieve object metadata from R2 bucket', async () => {
      const key = 'content/test-id';
      const mockObject = {
        size: 1024,
        customMetadata: { userId: 'user123', contentType: 'note' },
      };

      mockBucket.head.mockResolvedValue(mockObject);

      const result = await r2Service.headObject(key);

      // Verify bucket.head was called with correct key
      expect(mockBucket.head).toHaveBeenCalledWith(key);
      expect(result).toBe(mockObject);
    });

    it('should return null if object not found', async () => {
      mockBucket.head.mockResolvedValue(null);

      const result = await r2Service.headObject('nonexistent');

      expect(result).toBeNull();
    });

    it('should handle errors', async () => {
      const error = new Error('R2 error');
      mockBucket.head.mockRejectedValue(error);

      await expect(r2Service.headObject('key')).rejects.toThrow('R2 error');
    });
  });

  describe('createPresignedPost', () => {
    it('should create pre-signed POST policy', async () => {
      const options = {
        key: 'upload/test-id',
        metadata: { 'x-user-id': 'user123', 'x-content-type': 'note' },
        conditions: [['content-length-range', 0, 1024 * 1024]],
        expiration: 900,
      };

      const mockPolicy = {
        url: 'https://example.com/upload',
        formData: {
          key: 'upload/test-id',
          'x-amz-algorithm': 'AWS4-HMAC-SHA256',
        },
      };

      mockBucket.createPresignedPost.mockResolvedValue(mockPolicy);

      const result = await r2Service.createPresignedPost(options);

      // Verify bucket.createPresignedPost was called with correct options
      expect(mockBucket.createPresignedPost).toHaveBeenCalledWith(options);
      expect(result).toBe(mockPolicy);
    });

    it('should handle errors', async () => {
      const error = new Error('R2 error');
      mockBucket.createPresignedPost.mockRejectedValue(error);

      await expect(r2Service.createPresignedPost({ key: 'key' })).rejects.toThrow('R2 error');
    });
  });

  describe('createPresignedUrl', () => {
    it('should create pre-signed URL for direct downloads', async () => {
      const key = 'content/test-id';
      const options = { expiresIn: 3600 };
      const mockUrl = 'https://example.com/download';

      mockBucket.createPresignedUrl.mockResolvedValue(mockUrl);

      const result = await r2Service.createPresignedUrl(key, options);

      // Verify bucket.createPresignedUrl was called with correct parameters
      expect(mockBucket.createPresignedUrl).toHaveBeenCalledWith(key, options);
      expect(result).toBe(mockUrl);
    });

    it('should handle default options', async () => {
      const key = 'content/test-id';
      mockBucket.createPresignedUrl.mockResolvedValue('https://example.com/download');

      await r2Service.createPresignedUrl(key);

      // Verify bucket.createPresignedUrl was called with empty options object
      expect(mockBucket.createPresignedUrl).toHaveBeenCalledWith(key, {});
    });

    it('should handle errors', async () => {
      const error = new Error('R2 error');
      mockBucket.createPresignedUrl.mockRejectedValue(error);

      await expect(r2Service.createPresignedUrl('key')).rejects.toThrow('R2 error');
    });
  });
});
