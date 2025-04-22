import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DLQController, createDLQController } from '../../src/controllers/dlqController';
import { DLQService } from '../../src/services/dlqService';
import { DLQMessage, DLQStats } from '../../src/types';

describe('DLQController', () => {
  let dlqController: DLQController;
  let mockEnv: any;
  let mockDLQService: DLQService;

  beforeEach(() => {
    // Create mock environment
    mockEnv = {
      DB: {},
      SILO_INGEST_QUEUE: {},
      INGEST_DLQ: {},
    };

    // Create mock DLQ service
    mockDLQService = {
      storeDLQMessage: vi.fn().mockResolvedValue('test-uuid-123456'),
      getDLQMessages: vi.fn().mockResolvedValue([]),
      getDLQStats: vi.fn().mockResolvedValue({
        totalMessages: 0,
        reprocessedMessages: 0,
        pendingMessages: 0,
        byQueueName: {},
        byErrorType: {},
      }),
      markAsReprocessed: vi.fn().mockResolvedValue(undefined),
      reprocessMessage: vi.fn().mockResolvedValue('Successfully reprocessed'),
      reprocessMessages: vi.fn().mockResolvedValue({}),
      purgeMessages: vi.fn().mockResolvedValue(0),
      sendToDLQ: vi.fn().mockResolvedValue('test-uuid-123456'),
    } as unknown as DLQService;

    // Create DLQ controller with mock environment and service
    dlqController = createDLQController(mockEnv, mockDLQService);

    vi.clearAllMocks();
  });

  describe('getStats', () => {
    it('should retrieve DLQ statistics', async () => {
      // Mock DLQ service response
      const mockStats: DLQStats = {
        totalMessages: 10,
        reprocessedMessages: 3,
        pendingMessages: 7,
        byQueueName: {
          'silo-ingest-queue': 7,
          'enriched-content': 3,
        },
        byErrorType: {
          ValidationError: 5,
          ProcessingError: 5,
        },
      };

      mockDLQService.getDLQStats = vi.fn().mockResolvedValue(mockStats);

      // Call the method
      const result = await dlqController.getStats();

      // Verify DLQ service method was called
      expect(mockDLQService.getDLQStats).toHaveBeenCalled();

      // Verify the result matches the mock stats
      expect(result).toEqual(mockStats);
    });

    it('should handle errors when retrieving DLQ statistics', async () => {
      // Mock DLQ service to throw an error
      mockDLQService.getDLQStats = vi.fn().mockRejectedValue(new Error('Service error'));

      // Call the method and expect it to throw
      await expect(dlqController.getStats()).rejects.toThrow('Service error');
    });
  });

  describe('getMessages', () => {
    it('should retrieve DLQ messages with default options', async () => {
      // Mock DLQ service response
      const mockMessages: DLQMessage<unknown>[] = [
        {
          originalMessage: { content: 'test 1' },
          error: {
            message: 'Error 1',
            name: 'ValidationError',
          },
          processingMetadata: {
            failedAt: 1650000000000,
            retryCount: 3,
            queueName: 'silo-ingest-queue',
            messageId: 'original-1',
          },
          recovery: {
            reprocessed: false,
          },
        },
        {
          originalMessage: { content: 'test 2' },
          error: {
            message: 'Error 2',
            name: 'ProcessingError',
          },
          processingMetadata: {
            failedAt: 1650000001000,
            retryCount: 2,
            queueName: 'silo-ingest-queue',
            messageId: 'original-2',
          },
          recovery: {
            reprocessed: true,
            reprocessedAt: 1650000002000,
            recoveryResult: 'Success',
          },
        },
      ];

      mockDLQService.getDLQMessages = vi.fn().mockResolvedValue(mockMessages);

      // Call the method
      const result = await dlqController.getMessages();

      // Verify DLQ service method was called with default options
      expect(mockDLQService.getDLQMessages).toHaveBeenCalledWith(undefined);

      // Verify the result matches the mock messages
      expect(result).toEqual(mockMessages);
    });

    it('should apply filter options when retrieving DLQ messages', async () => {
      // Mock DLQ service response
      mockDLQService.getDLQMessages = vi.fn().mockResolvedValue([]);

      // Call the method with filter options
      const filterOptions = {
        queueName: 'silo-ingest-queue',
        errorType: 'ValidationError',
        reprocessed: false,
        limit: 50,
        offset: 10,
      };

      await dlqController.getMessages(filterOptions);

      // Verify DLQ service method was called with the filter options
      expect(mockDLQService.getDLQMessages).toHaveBeenCalledWith(filterOptions);
    });

    it('should handle errors when retrieving DLQ messages', async () => {
      // Mock DLQ service to throw an error
      mockDLQService.getDLQMessages = vi.fn().mockRejectedValue(new Error('Service error'));

      // Call the method and expect it to throw
      await expect(dlqController.getMessages()).rejects.toThrow('Service error');
    });
  });

  describe('reprocessMessage', () => {
    it('should reprocess a DLQ message', async () => {
      // Mock DLQ service response
      mockDLQService.reprocessMessage = vi
        .fn()
        .mockResolvedValue('Successfully requeued to silo-ingest-queue');

      // Call the method
      const result = await dlqController.reprocessMessage('dlq-1');

      // Verify DLQ service method was called with the correct ID
      expect(mockDLQService.reprocessMessage).toHaveBeenCalledWith('dlq-1');

      // Verify the result
      expect(result).toBe('Successfully requeued to silo-ingest-queue');
    });

    it('should handle errors when reprocessing a DLQ message', async () => {
      // Mock DLQ service to throw an error
      mockDLQService.reprocessMessage = vi.fn().mockRejectedValue(new Error('Reprocessing error'));

      // Call the method and expect it to throw
      await expect(dlqController.reprocessMessage('dlq-1')).rejects.toThrow('Reprocessing error');
    });
  });

  describe('reprocessMessages', () => {
    it('should reprocess multiple DLQ messages', async () => {
      // Mock DLQ service response
      const mockResults = {
        'dlq-1': 'Successfully requeued to silo-ingest-queue',
        'dlq-2': 'Error: Reprocessing error',
      };

      mockDLQService.reprocessMessages = vi.fn().mockResolvedValue(mockResults);

      // Call the method
      const result = await dlqController.reprocessMessages(['dlq-1', 'dlq-2']);

      // Verify DLQ service method was called with the correct IDs
      expect(mockDLQService.reprocessMessages).toHaveBeenCalledWith(['dlq-1', 'dlq-2']);

      // Verify the result
      expect(result).toEqual(mockResults);
    });

    it('should handle errors when reprocessing multiple DLQ messages', async () => {
      // Mock DLQ service to throw an error
      mockDLQService.reprocessMessages = vi
        .fn()
        .mockRejectedValue(new Error('Batch reprocessing error'));

      // Call the method and expect it to throw
      await expect(dlqController.reprocessMessages(['dlq-1', 'dlq-2'])).rejects.toThrow(
        'Batch reprocessing error',
      );
    });
  });

  describe('purgeMessages', () => {
    it('should purge DLQ messages with default options', async () => {
      // Mock DLQ service response
      mockDLQService.purgeMessages = vi.fn().mockResolvedValue(5);

      // Call the method
      const result = await dlqController.purgeMessages();

      // Verify DLQ service method was called with default options
      expect(mockDLQService.purgeMessages).toHaveBeenCalledWith(undefined);

      // Verify the result
      expect(result).toBe(5);
    });

    it('should apply filter options when purging DLQ messages', async () => {
      // Mock DLQ service response
      mockDLQService.purgeMessages = vi.fn().mockResolvedValue(3);

      // Call the method with filter options
      const filterOptions = {
        queueName: 'silo-ingest-queue',
        errorType: 'ValidationError',
        reprocessed: true,
      };

      const result = await dlqController.purgeMessages(filterOptions);

      // Verify DLQ service method was called with the filter options
      expect(mockDLQService.purgeMessages).toHaveBeenCalledWith(filterOptions);

      // Verify the result
      expect(result).toBe(3);
    });

    it('should handle errors when purging DLQ messages', async () => {
      // Mock DLQ service to throw an error
      mockDLQService.purgeMessages = vi.fn().mockRejectedValue(new Error('Purge error'));

      // Call the method and expect it to throw
      await expect(dlqController.purgeMessages()).rejects.toThrow('Purge error');
    });
  });
});
