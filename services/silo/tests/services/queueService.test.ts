import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueueService, createQueueService } from '../../src/services/queueService';

describe('QueueService', () => {
  let queueService: QueueService;
  let mockEnv: any;
  let mockNewContentQueue: any;

  beforeEach(() => {
    // Create mock queue
    mockNewContentQueue = {
      send: vi.fn().mockResolvedValue({}),
    };

    mockEnv = {
      NEW_CONTENT: mockNewContentQueue,
    };

    queueService = createQueueService(mockEnv);

    vi.clearAllMocks();
  });

  describe('sendNewContentMessage', () => {
    it('should send message to NEW_CONTENT queue', async () => {
      const message = {
        id: 'test-id',
        userId: 'user123',
        contentType: 'note',
        size: 1024,
        createdAt: 1234567890,
        metadata: { title: 'Test Note' },
      };

      await queueService.sendNewContentMessage(message);

      // Verify queue.send was called with the message
      expect(mockNewContentQueue.send).toHaveBeenCalledWith(message);
    });

    it('should handle deletion messages', async () => {
      const message = {
        id: 'test-id',
        userId: 'user123',
        deleted: true,
      };

      await queueService.sendNewContentMessage(message);

      // Verify queue.send was called with the deletion message
      expect(mockNewContentQueue.send).toHaveBeenCalledWith(message);
    });

    it('should handle errors', async () => {
      const error = new Error('Queue error');
      mockNewContentQueue.send.mockRejectedValue(error);

      await expect(
        queueService.sendNewContentMessage({
          id: 'test-id',
          userId: 'user123',
          contentType: 'note',
          size: 1024,
          createdAt: 1234567890,
        }),
      ).rejects.toThrow('Queue error');
    });
  });
});
