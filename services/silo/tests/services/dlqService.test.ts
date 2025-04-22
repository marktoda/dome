import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DLQService, createDLQService } from '../../src/services/dlqService';
import { DLQMessage } from '../../src/types';
import { randomUUID } from 'crypto';

// Mock randomUUID to return predictable IDs
vi.mock('crypto', () => ({
  randomUUID: vi.fn().mockReturnValue('test-uuid-123456'),
}));

describe('DLQService', () => {
  let dlqService: DLQService;
  let mockEnv: any;
  let mockDb: any;
  let mockIngestQueue: any;
  let mockIngestDLQ: any;

  beforeEach(() => {
    // Create mock DB with all required methods
    mockDb = {
      insert: vi.fn().mockReturnThis(),
      values: vi.fn().mockReturnThis(),
      run: vi.fn().mockResolvedValue({}),
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      offset: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      delete: vi.fn().mockReturnThis(),
      groupBy: vi.fn().mockReturnThis(),
    };

    // Create mock queues
    mockIngestQueue = {
      send: vi.fn().mockResolvedValue({}),
    };

    mockIngestDLQ = {
      send: vi.fn().mockResolvedValue({}),
    };

    // Create mock environment
    mockEnv = {
      DB: {
        prepare: vi.fn().mockReturnValue({
          bind: vi.fn().mockReturnThis(),
          all: vi.fn().mockResolvedValue([]),
          run: vi.fn().mockResolvedValue({}),
        }),
      },
      SILO_INGEST_QUEUE: mockIngestQueue,
      INGEST_DLQ: mockIngestDLQ,
    };

    // Mock drizzle to return our mock DB
    vi.mock('drizzle-orm/d1', () => ({
      drizzle: vi.fn().mockReturnValue(mockDb),
    }));

    // Create DLQ service with mock environment
    dlqService = createDLQService(mockEnv);

    vi.clearAllMocks();
  });

  describe('storeDLQMessage', () => {
    it('should store DLQ message metadata in the database', async () => {
      // Create a test DLQ message
      const testMessage: DLQMessage<any> = {
        originalMessage: { content: 'test content' },
        error: {
          message: 'Test error message',
          name: 'TestError',
        },
        processingMetadata: {
          failedAt: Date.now(),
          retryCount: 3,
          queueName: 'silo-ingest-queue',
          messageId: 'original-message-id',
        },
        recovery: {
          reprocessed: false,
        },
      };

      // Call the method
      const result = await dlqService.storeDLQMessage(testMessage);

      // Verify DB insert was called with correct parameters
      expect(mockDb.insert).toHaveBeenCalled();
      expect(mockDb.values).toHaveBeenCalledWith({
        id: 'test-uuid-123456',
        originalMessageId: 'original-message-id',
        queueName: 'silo-ingest-queue',
        errorMessage: 'Test error message',
        errorName: 'TestError',
        failedAt: testMessage.processingMetadata.failedAt,
        retryCount: 3,
        reprocessed: false,
        originalMessageType: 'object',
        originalMessageJson: JSON.stringify({ content: 'test content' }),
      });

      // Verify the result is the generated UUID
      expect(result).toBe('test-uuid-123456');
    });

    it('should handle errors when storing DLQ message metadata', async () => {
      // Mock DB insert to throw an error
      mockDb.run.mockRejectedValue(new Error('Database error'));

      // Create a test DLQ message
      const testMessage: DLQMessage<any> = {
        originalMessage: { content: 'test content' },
        error: {
          message: 'Test error message',
          name: 'TestError',
        },
        processingMetadata: {
          failedAt: Date.now(),
          retryCount: 3,
          queueName: 'silo-ingest-queue',
          messageId: 'original-message-id',
        },
        recovery: {
          reprocessed: false,
        },
      };

      // Call the method and expect it to throw
      await expect(dlqService.storeDLQMessage(testMessage)).rejects.toThrow('Database error');
    });
  });

  describe('getDLQMessages', () => {
    it('should retrieve DLQ messages with default options', async () => {
      // Mock DB response
      const mockMessages = [
        {
          id: 'dlq-1',
          originalMessageId: 'original-1',
          queueName: 'silo-ingest-queue',
          errorMessage: 'Error 1',
          errorName: 'ValidationError',
          failedAt: 1650000000000,
          retryCount: 3,
          reprocessed: 0,
          reprocessedAt: null,
          recoveryResult: null,
          originalMessageType: 'object',
          originalMessageJson: JSON.stringify({ content: 'test 1' }),
        },
        {
          id: 'dlq-2',
          originalMessageId: 'original-2',
          queueName: 'silo-ingest-queue',
          errorMessage: 'Error 2',
          errorName: 'ProcessingError',
          failedAt: 1650000001000,
          retryCount: 2,
          reprocessed: 1,
          reprocessedAt: 1650000002000,
          recoveryResult: 'Success',
          originalMessageType: 'object',
          originalMessageJson: JSON.stringify({ content: 'test 2' }),
        },
      ];

      mockDb.all.mockResolvedValue(mockMessages);

      // Call the method
      const result = await dlqService.getDLQMessages();

      // Verify DB query was called with correct parameters
      expect(mockDb.select).toHaveBeenCalled();
      expect(mockDb.from).toHaveBeenCalled();
      expect(mockDb.limit).toHaveBeenCalledWith(100);
      expect(mockDb.offset).toHaveBeenCalledWith(0);

      // Verify the result contains the expected messages
      expect(result).toHaveLength(2);
      expect(result[0].originalMessage).toEqual({ content: 'test 1' });
      expect(result[0].error.name).toBe('ValidationError');
      expect(result[0].processingMetadata.messageId).toBe('original-1');
      expect(result[0].recovery.reprocessed).toBe(false);

      expect(result[1].originalMessage).toEqual({ content: 'test 2' });
      expect(result[1].error.name).toBe('ProcessingError');
      expect(result[1].processingMetadata.messageId).toBe('original-2');
      expect(result[1].recovery.reprocessed).toBe(true);
      expect(result[1].recovery.reprocessedAt).toBe(1650000002000);
      expect(result[1].recovery.recoveryResult).toBe('Success');
    });

    it('should apply filter options when retrieving DLQ messages', async () => {
      // Mock DB response
      mockDb.all.mockResolvedValue([]);

      // Call the method with filter options
      const filterOptions = {
        queueName: 'silo-ingest-queue',
        errorType: 'ValidationError',
        reprocessed: false,
        startDate: 1650000000000,
        endDate: 1650000001000,
        limit: 50,
        offset: 10,
      };

      await dlqService.getDLQMessages(filterOptions);

      // Verify DB query was called with correct parameters
      expect(mockDb.where).toHaveBeenCalled();
      expect(mockDb.limit).toHaveBeenCalledWith(50);
      expect(mockDb.offset).toHaveBeenCalledWith(10);
    });

    it('should handle errors when retrieving DLQ messages', async () => {
      // Mock DB query to throw an error
      mockDb.all.mockRejectedValue(new Error('Database query error'));

      // Call the method and expect it to throw
      await expect(dlqService.getDLQMessages()).rejects.toThrow('Database query error');
    });
  });

  describe('getDLQStats', () => {
    it('should retrieve DLQ statistics', async () => {
      // Mock DB responses for the various queries
      mockDb.get.mockImplementation(() => {
        // First call is for total count
        if (mockDb.get.mock.calls.length === 1) {
          return Promise.resolve({ count: 10 });
        }
        // Second call is for reprocessed count
        return Promise.resolve({ count: 3 });
      });

      mockDb.all.mockImplementation(() => {
        // First call is for queue counts
        if (mockDb.all.mock.calls.length === 1) {
          return Promise.resolve([
            { queueName: 'silo-ingest-queue', count: 7 },
            { queueName: 'enriched-content', count: 3 },
          ]);
        }
        // Second call is for error counts
        return Promise.resolve([
          { errorName: 'ValidationError', count: 5 },
          { errorName: 'ProcessingError', count: 5 },
        ]);
      });

      // Call the method
      const result = await dlqService.getDLQStats();

      // Verify DB queries were called
      expect(mockDb.select).toHaveBeenCalled();
      expect(mockDb.from).toHaveBeenCalled();
      expect(mockDb.groupBy).toHaveBeenCalled();

      // Verify the result contains the expected statistics
      expect(result.totalMessages).toBe(10);
      expect(result.reprocessedMessages).toBe(3);
      expect(result.pendingMessages).toBe(7);
      expect(result.byQueueName).toEqual({
        'silo-ingest-queue': 7,
        'enriched-content': 3,
      });
      expect(result.byErrorType).toEqual({
        ValidationError: 5,
        ProcessingError: 5,
      });
    });

    it('should handle errors when retrieving DLQ statistics', async () => {
      // Mock DB query to throw an error
      mockDb.get.mockRejectedValue(new Error('Database query error'));

      // Call the method and expect it to throw
      await expect(dlqService.getDLQStats()).rejects.toThrow('Database query error');
    });
  });

  describe('markAsReprocessed', () => {
    it('should mark a DLQ message as reprocessed', async () => {
      // Call the method
      await dlqService.markAsReprocessed('dlq-1', 'Successfully reprocessed');

      // Verify DB update was called with correct parameters
      expect(mockDb.update).toHaveBeenCalled();
      expect(mockDb.set).toHaveBeenCalledWith({
        reprocessed: true,
        reprocessedAt: expect.any(Number),
        recoveryResult: 'Successfully reprocessed',
      });
      expect(mockDb.where).toHaveBeenCalled();
    });

    it('should handle errors when marking a message as reprocessed', async () => {
      // Mock DB update to throw an error
      mockDb.run.mockRejectedValue(new Error('Database update error'));

      // Call the method and expect it to throw
      await expect(dlqService.markAsReprocessed('dlq-1', 'Result')).rejects.toThrow(
        'Database update error',
      );
    });
  });

  describe('reprocessMessage', () => {
    it('should reprocess a DLQ message from the ingest queue', async () => {
      // Mock DB response for getting the message
      const mockMessage = {
        id: 'dlq-1',
        originalMessageId: 'original-1',
        queueName: 'silo-ingest-queue',
        errorMessage: 'Error 1',
        errorName: 'ValidationError',
        failedAt: 1650000000000,
        retryCount: 3,
        reprocessed: 0,
        reprocessedAt: null,
        recoveryResult: null,
        originalMessageType: 'object',
        originalMessageJson: JSON.stringify({ content: 'test content', id: 'test-id' }),
      };

      mockDb.get.mockResolvedValue(mockMessage);

      // Call the method
      const result = await dlqService.reprocessMessage('dlq-1');

      // Verify DB query was called to get the message
      expect(mockDb.select).toHaveBeenCalled();
      expect(mockDb.from).toHaveBeenCalled();
      expect(mockDb.where).toHaveBeenCalled();

      // Verify the message was sent to the ingest queue
      expect(mockIngestQueue.send).toHaveBeenCalledWith({ content: 'test content', id: 'test-id' });

      // Verify the message was marked as reprocessed
      expect(mockDb.update).toHaveBeenCalled();
      expect(mockDb.set).toHaveBeenCalledWith({
        reprocessed: true,
        reprocessedAt: expect.any(Number),
        recoveryResult: 'Successfully requeued to silo-ingest-queue',
      });

      // Verify the result
      expect(result).toBe('Successfully requeued to silo-ingest-queue');
    });

    it('should handle message not found', async () => {
      // Mock DB response for getting the message
      mockDb.get.mockResolvedValue(null);

      // Call the method and expect it to throw
      await expect(dlqService.reprocessMessage('nonexistent')).rejects.toThrow(
        'DLQ message with ID nonexistent not found',
      );
    });

    it('should handle already reprocessed messages', async () => {
      // Mock DB response for getting the message
      const mockMessage = {
        id: 'dlq-1',
        originalMessageId: 'original-1',
        queueName: 'silo-ingest-queue',
        errorMessage: 'Error 1',
        errorName: 'ValidationError',
        failedAt: 1650000000000,
        retryCount: 3,
        reprocessed: 1,
        reprocessedAt: 1650000001000,
        recoveryResult: 'Already reprocessed',
        originalMessageType: 'object',
        originalMessageJson: JSON.stringify({ content: 'test content' }),
      };

      mockDb.get.mockResolvedValue(mockMessage);

      // Call the method
      const result = await dlqService.reprocessMessage('dlq-1');

      // Verify the message was not sent to the queue again
      expect(mockIngestQueue.send).not.toHaveBeenCalled();

      // Verify the result
      expect(result).toContain('Message dlq-1 was already reprocessed');
    });

    it('should handle unsupported queue types', async () => {
      // Mock DB response for getting the message
      const mockMessage = {
        id: 'dlq-1',
        originalMessageId: 'original-1',
        queueName: 'unsupported-queue',
        errorMessage: 'Error 1',
        errorName: 'ValidationError',
        failedAt: 1650000000000,
        retryCount: 3,
        reprocessed: 0,
        reprocessedAt: null,
        recoveryResult: null,
        originalMessageType: 'object',
        originalMessageJson: JSON.stringify({ content: 'test content' }),
      };

      mockDb.get.mockResolvedValue(mockMessage);

      // Call the method
      const result = await dlqService.reprocessMessage('dlq-1');

      // Verify the message was not sent to any queue
      expect(mockIngestQueue.send).not.toHaveBeenCalled();

      // Verify the message was marked as reprocessed with an error
      expect(mockDb.update).toHaveBeenCalled();
      expect(mockDb.set).toHaveBeenCalledWith({
        reprocessed: true,
        reprocessedAt: expect.any(Number),
        recoveryResult: 'Unsupported queue: unsupported-queue',
      });

      // Verify the result
      expect(result).toBe('Unsupported queue: unsupported-queue');
    });

    it('should handle validation errors during reprocessing', async () => {
      // Mock DB response for getting the message
      const mockMessage = {
        id: 'dlq-1',
        originalMessageId: 'original-1',
        queueName: 'silo-ingest-queue',
        errorMessage: 'Error 1',
        errorName: 'ValidationError',
        failedAt: 1650000000000,
        retryCount: 3,
        reprocessed: 0,
        reprocessedAt: null,
        recoveryResult: null,
        originalMessageType: 'object',
        originalMessageJson: JSON.stringify({ invalid: 'message' }), // Invalid message
      };

      mockDb.get.mockResolvedValue(mockMessage);

      // Mock siloSimplePutSchema.parse to throw a validation error
      vi.mock('@dome/common', () => ({
        siloSimplePutSchema: {
          parse: vi.fn().mockImplementation(() => {
            throw new Error('Validation error');
          }),
        },
      }));

      // Call the method and expect it to throw
      await expect(dlqService.reprocessMessage('dlq-1')).rejects.toThrow('Validation error');
    });
  });

  describe('reprocessMessages', () => {
    it('should reprocess multiple DLQ messages', async () => {
      // Mock reprocessMessage to return success for first message and error for second
      vi.spyOn(dlqService, 'reprocessMessage').mockImplementation(id => {
        if (id === 'dlq-1') {
          return Promise.resolve('Successfully requeued to silo-ingest-queue');
        } else {
          return Promise.reject(new Error('Reprocessing error'));
        }
      });

      // Call the method
      const result = await dlqService.reprocessMessages(['dlq-1', 'dlq-2']);

      // Verify reprocessMessage was called for each ID
      expect(dlqService.reprocessMessage).toHaveBeenCalledWith('dlq-1');
      expect(dlqService.reprocessMessage).toHaveBeenCalledWith('dlq-2');

      // Verify the result contains success and error messages
      expect(result).toEqual({
        'dlq-1': 'Successfully requeued to silo-ingest-queue',
        'dlq-2': 'Error: Reprocessing error',
      });
    });
  });

  describe('purgeMessages', () => {
    it('should purge DLQ messages with default options', async () => {
      // Mock DB response
      mockDb.run.mockResolvedValue({ changes: 5 });

      // Call the method
      const result = await dlqService.purgeMessages();

      // Verify DB delete was called
      expect(mockDb.delete).toHaveBeenCalled();
      expect(mockDb.where).toHaveBeenCalled();

      // Verify the result is the number of deleted messages
      expect(result).toBe(5);
    });

    it('should apply filter options when purging DLQ messages', async () => {
      // Mock DB response
      mockDb.run.mockResolvedValue({ changes: 3 });

      // Call the method with filter options
      const filterOptions = {
        queueName: 'silo-ingest-queue',
        errorType: 'ValidationError',
        reprocessed: true,
      };

      const result = await dlqService.purgeMessages(filterOptions);

      // Verify DB delete was called with filters
      expect(mockDb.delete).toHaveBeenCalled();
      expect(mockDb.where).toHaveBeenCalled();

      // Verify the result is the number of deleted messages
      expect(result).toBe(3);
    });

    it('should handle errors when purging DLQ messages', async () => {
      // Mock DB delete to throw an error
      mockDb.run.mockRejectedValue(new Error('Database delete error'));

      // Call the method and expect it to throw
      await expect(dlqService.purgeMessages()).rejects.toThrow('Database delete error');
    });
  });

  describe('sendToDLQ', () => {
    it('should send a message to the DLQ', async () => {
      // Mock storeDLQMessage to return a UUID
      vi.spyOn(dlqService, 'storeDLQMessage').mockResolvedValue('test-uuid-123456');

      // Create test data
      const originalMessage = { content: 'test content' };
      const error = new Error('Test error');
      error.name = 'TestError';
      const metadata = {
        queueName: 'silo-ingest-queue',
        messageId: 'original-message-id',
        retryCount: 3,
        producerService: 'test-service',
      };

      // Call the method
      const result = await dlqService.sendToDLQ(originalMessage, error, metadata);

      // Verify the message was sent to the DLQ queue
      expect(mockIngestDLQ.send).toHaveBeenCalledWith({
        originalMessage,
        error: {
          message: 'Test error',
          name: 'TestError',
          stack: error.stack,
        },
        processingMetadata: {
          failedAt: expect.any(Number),
          retryCount: 3,
          queueName: 'silo-ingest-queue',
          messageId: 'original-message-id',
          producerService: 'test-service',
        },
        recovery: {
          reprocessed: false,
        },
      });

      // Verify storeDLQMessage was called
      expect(dlqService.storeDLQMessage).toHaveBeenCalled();

      // Verify the result is the UUID
      expect(result).toBe('test-uuid-123456');
    });

    it('should handle missing DLQ queue binding', async () => {
      // Create a new mock environment without the DLQ queue
      const envWithoutDLQ = { ...mockEnv, INGEST_DLQ: undefined };

      // Create a new DLQ service with the modified environment
      const dlqServiceWithoutDLQ = createDLQService(envWithoutDLQ);

      // Mock storeDLQMessage to return a UUID
      vi.spyOn(dlqServiceWithoutDLQ, 'storeDLQMessage').mockResolvedValue('test-uuid-123456');

      // Create test data
      const originalMessage = { content: 'test content' };
      const error = new Error('Test error');
      const metadata = {
        queueName: 'silo-ingest-queue',
        messageId: 'original-message-id',
        retryCount: 3,
      };

      // Call the method
      const result = await dlqServiceWithoutDLQ.sendToDLQ(originalMessage, error, metadata);

      // Verify storeDLQMessage was still called
      expect(dlqServiceWithoutDLQ.storeDLQMessage).toHaveBeenCalled();

      // Verify the result is the UUID
      expect(result).toBe('test-uuid-123456');
    });

    it('should handle errors when sending to DLQ', async () => {
      // Mock storeDLQMessage to throw an error
      vi.spyOn(dlqService, 'storeDLQMessage').mockRejectedValue(new Error('Storage error'));

      // Create test data
      const originalMessage = { content: 'test content' };
      const error = new Error('Test error');
      const metadata = {
        queueName: 'silo-ingest-queue',
        messageId: 'original-message-id',
        retryCount: 3,
      };

      // Call the method and expect it to throw
      await expect(dlqService.sendToDLQ(originalMessage, error, metadata)).rejects.toThrow(
        'Storage error',
      );
    });
  });
});
