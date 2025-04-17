// Jest is automatically available in the global scope
import { r2Service } from '../../src/services/r2Service';
import { ServiceError } from '@dome/common';

// Mock R2 bucket
const mockR2Bucket = {
  get: jest.fn(),
  put: jest.fn(),
  delete: jest.fn()
};

// Mock environment bindings
const mockEnv = {
  RAW: mockR2Bucket
} as any;

describe('R2Service', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  describe('uploadObject', () => {
    it('should upload an object to R2', async () => {
      // Mock R2 put response
      const mockR2Object = {
        key: 'test-key',
        size: 100,
        etag: 'test-etag',
        uploaded: new Date()
      };
      mockR2Bucket.put.mockResolvedValue(mockR2Object);

      // Call the service
      const result = await r2Service.uploadObject(
        mockEnv,
        'test-key',
        'test-data',
        'text/plain',
        { testMetadata: 'test' }
      );

      // Verify the result
      expect(result).toEqual({
        contentType: 'text/plain',
        size: mockR2Object.size,
        etag: mockR2Object.etag,
        uploaded: mockR2Object.uploaded,
        customMetadata: { testMetadata: 'test' }
      });

      // Verify R2 bucket was called correctly
      expect(mockR2Bucket.put).toHaveBeenCalledWith(
        'test-key',
        'test-data',
        {
          httpMetadata: { contentType: 'text/plain' },
          customMetadata: { testMetadata: 'test' }
        }
      );
    });

    it('should throw ServiceError when upload fails', async () => {
      // Mock R2 put to throw an error
      mockR2Bucket.put.mockRejectedValue(new Error('Upload failed'));

      // Call the service and expect it to throw
      await expect(
        r2Service.uploadObject(mockEnv, 'test-key', 'test-data', 'text/plain')
      ).rejects.toThrow(ServiceError);
    });
  });

  describe('downloadObject', () => {
    it('should download an object from R2', async () => {
      // Mock R2 get response
      const mockR2Object = {
        body: new ReadableStream(),
        size: 100,
        etag: 'test-etag',
        uploaded: new Date(),
        httpMetadata: { contentType: 'text/plain' },
        customMetadata: { testMetadata: 'test' }
      };
      mockR2Bucket.get.mockResolvedValue(mockR2Object);

      // Call the service
      const result = await r2Service.downloadObject(mockEnv, 'test-key');

      // Verify the result
      expect(result).toEqual({
        data: mockR2Object.body,
        metadata: {
          contentType: 'text/plain',
          size: mockR2Object.size,
          etag: mockR2Object.etag,
          uploaded: mockR2Object.uploaded,
          customMetadata: { testMetadata: 'test' }
        }
      });

      // Verify R2 bucket was called correctly
      expect(mockR2Bucket.get).toHaveBeenCalledWith('test-key');
    });

    it('should return null when object does not exist', async () => {
      // Mock R2 get to return null
      mockR2Bucket.get.mockResolvedValue(null);

      // Call the service
      const result = await r2Service.downloadObject(mockEnv, 'test-key');

      // Verify the result
      expect(result).toBeNull();
    });

    it('should throw ServiceError when download fails', async () => {
      // Mock R2 get to throw an error
      mockR2Bucket.get.mockRejectedValue(new Error('Download failed'));

      // Call the service and expect it to throw
      await expect(
        r2Service.downloadObject(mockEnv, 'test-key')
      ).rejects.toThrow(ServiceError);
    });
  });

  describe('deleteObject', () => {
    it('should delete an object from R2', async () => {
      // Mock R2 get and delete responses
      mockR2Bucket.get.mockResolvedValue({ key: 'test-key' });
      mockR2Bucket.delete.mockResolvedValue(undefined);

      // Call the service
      const result = await r2Service.deleteObject(mockEnv, 'test-key');

      // Verify the result
      expect(result).toBe(true);

      // Verify R2 bucket was called correctly
      expect(mockR2Bucket.get).toHaveBeenCalledWith('test-key');
      expect(mockR2Bucket.delete).toHaveBeenCalledWith('test-key');
    });

    it('should return false when object does not exist', async () => {
      // Mock R2 get to return null
      mockR2Bucket.get.mockResolvedValue(null);

      // Call the service
      const result = await r2Service.deleteObject(mockEnv, 'test-key');

      // Verify the result
      expect(result).toBe(false);

      // Verify R2 bucket was called correctly
      expect(mockR2Bucket.get).toHaveBeenCalledWith('test-key');
      expect(mockR2Bucket.delete).not.toHaveBeenCalled();
    });

    it('should throw ServiceError when delete fails', async () => {
      // Mock R2 get to return an object but delete to throw an error
      mockR2Bucket.get.mockResolvedValue({ key: 'test-key' });
      mockR2Bucket.delete.mockRejectedValue(new Error('Delete failed'));

      // Call the service and expect it to throw
      await expect(
        r2Service.deleteObject(mockEnv, 'test-key')
      ).rejects.toThrow(ServiceError);
    });
  });

  describe('objectExists', () => {
    it('should return true when object exists', async () => {
      // Mock R2 get response
      mockR2Bucket.get.mockResolvedValue({ key: 'test-key' });

      // Call the service
      const result = await r2Service.objectExists(mockEnv, 'test-key');

      // Verify the result
      expect(result).toBe(true);

      // Verify R2 bucket was called correctly
      expect(mockR2Bucket.get).toHaveBeenCalledWith('test-key');
    });

    it('should return false when object does not exist', async () => {
      // Mock R2 get to return null
      mockR2Bucket.get.mockResolvedValue(null);

      // Call the service
      const result = await r2Service.objectExists(mockEnv, 'test-key');

      // Verify the result
      expect(result).toBe(false);

      // Verify R2 bucket was called correctly
      expect(mockR2Bucket.get).toHaveBeenCalledWith('test-key');
    });

    it('should throw ServiceError when check fails', async () => {
      // Mock R2 get to throw an error
      mockR2Bucket.get.mockRejectedValue(new Error('Check failed'));

      // Call the service and expect it to throw
      await expect(
        r2Service.objectExists(mockEnv, 'test-key')
      ).rejects.toThrow(ServiceError);
    });
  });
});