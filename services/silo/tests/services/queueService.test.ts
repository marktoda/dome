import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueueService, createQueueService } from '../../src/services/queueService';
import { ContentRepository } from '../../src/repositories/contentRepository';
import { R2Event } from '../../src/types';

describe('QueueService', () => {
  let queueService: QueueService;
  let mockEnv: any;
  let mockContentRepository: any;

  beforeEach(() => {
    mockEnv = {
      BUCKET: {
        head: vi.fn(),
      },
      NEW_CONTENT: {
        send: vi.fn().mockResolvedValue({}),
      },
    };

    mockContentRepository = {
      insertContent: vi.fn().mockResolvedValue({}),
    };

    queueService = createQueueService(mockEnv, mockContentRepository);

    vi.clearAllMocks();
  });

  describe('processObjectCreatedEvent', () => {
    it('should process valid R2 object-created events', async () => {
      const mockEvent: R2Event = {
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

      const mockR2Object = {
        customMetadata: {
          userId: 'user123',
          contentType: 'note',
          metadata: JSON.stringify({ title: 'Test Note' }),
        },
      };

      mockEnv.BUCKET.head.mockResolvedValue(mockR2Object);

      await queueService.processObjectCreatedEvent(mockEvent);

      // Verify R2 bucket head was called
      expect(mockEnv.BUCKET.head).toHaveBeenCalledWith('content/test-id');

      // Verify repository insertContent was called with correct data
      expect(mockContentRepository.insertContent).toHaveBeenCalled();
      const insertCall = mockContentRepository.insertContent.mock.calls[0][0];
      expect(insertCall.id).toBe('test-id');
      expect(insertCall.userId).toBe('user123');
      expect(insertCall.contentType).toBe('note');
      expect(insertCall.r2Key).toBe('content/test-id');
      expect(insertCall.size).toBe(1024);

      // Verify notification was sent
      expect(mockEnv.NEW_CONTENT.send).toHaveBeenCalled();
      const sendCall = mockEnv.NEW_CONTENT.send.mock.calls[0][0];
      expect(sendCall.id).toBe('test-id');
      expect(sendCall.userId).toBe('user123');
      expect(sendCall.contentType).toBe('note');
      expect(sendCall.size).toBe(1024);
      expect(sendCall.metadata).toEqual({ title: 'Test Note' });
    });

    it('should handle events with invalid key format', async () => {
      const mockEvent: R2Event = {
        type: 'object.created',
        time: new Date().toISOString(),
        eventTime: new Date().toISOString(),
        object: {
          key: 'invalid-key-format',
          size: 1024,
          etag: 'etag123',
          httpEtag: 'httpEtag123',
        },
      };

      await queueService.processObjectCreatedEvent(mockEvent);

      // Verify no repository or queue operations were performed
      expect(mockContentRepository.insertContent).not.toHaveBeenCalled();
      expect(mockEnv.NEW_CONTENT.send).not.toHaveBeenCalled();
    });

    it('should handle missing R2 objects', async () => {
      const mockEvent: R2Event = {
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

      mockEnv.BUCKET.head.mockResolvedValue(null);

      await queueService.processObjectCreatedEvent(mockEvent);

      // Verify no repository or queue operations were performed
      expect(mockContentRepository.insertContent).not.toHaveBeenCalled();
      expect(mockEnv.NEW_CONTENT.send).not.toHaveBeenCalled();
    });

    it('should handle objects with httpMetadata but no customMetadata', async () => {
      const mockEvent: R2Event = {
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

      const mockR2Object = {
        httpMetadata: {
          contentType: 'text/plain',
        },
      };

      mockEnv.BUCKET.head.mockResolvedValue(mockR2Object);

      await queueService.processObjectCreatedEvent(mockEvent);

      // Verify repository insertContent was called with correct data
      expect(mockContentRepository.insertContent).toHaveBeenCalled();
      const insertCall = mockContentRepository.insertContent.mock.calls[0][0];
      expect(insertCall.id).toBe('test-id');
      expect(insertCall.userId).toBeNull();
      expect(insertCall.contentType).toBe('text/plain');
    });
  });

  describe('processBatch', () => {
    it('should process each message in the batch', async () => {
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
                key: 'content/id1',
                size: 1024,
                etag: 'etag1',
                httpEtag: 'httpEtag1',
              },
            },
          },
          {
            id: '2',
            timestamp: Date.now(),
            body: {
              type: 'object.created',
              time: new Date().toISOString(),
              eventTime: new Date().toISOString(),
              object: {
                key: 'content/id2',
                size: 2048,
                etag: 'etag2',
                httpEtag: 'httpEtag2',
              },
            },
          },
        ],
        queue: 'test-queue',
      };

      // Spy on processObjectCreatedEvent
      const processSpy = vi.spyOn(queueService, 'processObjectCreatedEvent');
      processSpy.mockResolvedValue(undefined);

      await queueService.processBatch(mockBatch as any);

      // Verify processObjectCreatedEvent was called for each message
      expect(processSpy).toHaveBeenCalledTimes(2);
      expect(processSpy).toHaveBeenCalledWith(mockBatch.messages[0].body);
      expect(processSpy).toHaveBeenCalledWith(mockBatch.messages[1].body);
    });

    it('should handle case when bucket head method is unavailable', async () => {
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
                key: 'content/id1',
                size: 1024,
                etag: 'etag1',
                httpEtag: 'httpEtag1',
              },
            },
          },
        ],
        queue: 'test-queue',
      };

      // Remove head method
      mockEnv.BUCKET.head = undefined;

      // Spy on processObjectCreatedEvent
      const processSpy = vi.spyOn(queueService, 'processObjectCreatedEvent');

      await queueService.processBatch(mockBatch as any);

      // Verify processObjectCreatedEvent was not called
      expect(processSpy).not.toHaveBeenCalled();
    });
  });
});