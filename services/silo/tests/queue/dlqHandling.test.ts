import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import { DLQService } from '../../src/services/dlqService';
import Silo from '../../src/index';

// Mock the DLQ service
vi.mock('../../src/services/dlqService', () => ({
  createDLQService: vi.fn().mockReturnValue({
    sendToDLQ: vi.fn().mockResolvedValue('test-uuid-123456'),
  }),
}));

// Mock the zod library
vi.mock('zod', () => ({
  z: {
    ZodError: class ZodError extends Error {
      constructor(issues = []) {
        super('Validation error');
        this.name = 'ZodError';
        this.issues = issues;
      }
      issues: any[];
    },
  },
}));

describe('DLQ Handling', () => {
  let silo: Silo;
  let mockEnv: any;
  let mockServices: any;
  let mockDLQService: any;
  let mockMessage: any;

  beforeEach(() => {
    // Create mock environment
    mockEnv = {
      DB: {},
      SILO_INGEST_QUEUE: {
        send: vi.fn().mockResolvedValue({}),
      },
      INGEST_DLQ: {
        send: vi.fn().mockResolvedValue({}),
      },
    };

    // Create mock services
    mockDLQService = {
      sendToDLQ: vi.fn().mockResolvedValue('test-uuid-123456'),
    };

    mockServices = {
      dlq: mockDLQService,
      content: {
        processIngestMessage: vi.fn().mockResolvedValue({}),
        processEnrichedContent: vi.fn().mockResolvedValue({}),
      },
    };

    // Create mock message
    mockMessage = {
      body: { content: 'test content' },
      id: 'test-message-id',
      retryCount: 0,
      ack: vi.fn(),
    };

    // Create Silo instance
    silo = new Silo({} as ExecutionContext, mockEnv);

    // Replace the services property with our mock
    (silo as any).services = mockServices;

    vi.clearAllMocks();
  });

  describe('sendToDLQ', () => {
    it('should send a message to the DLQ and acknowledge it', async () => {
      // Call the private method using type assertion
      await (silo as any).sendToDLQ(mockMessage, new Error('Test error'), 'silo-ingest-queue', 2);

      // Verify DLQ service method was called with correct parameters
      expect(mockDLQService.sendToDLQ).toHaveBeenCalledWith(
        mockMessage.body,
        expect.objectContaining({
          message: 'Test error',
          name: 'Error',
        }),
        {
          queueName: 'silo-ingest-queue',
          messageId: 'test-message-id',
          retryCount: 2,
        },
      );

      // Verify the message was acknowledged
      expect(mockMessage.ack).toHaveBeenCalled();
    });

    it('should handle errors when sending to DLQ', async () => {
      // Mock DLQ service to throw an error
      mockDLQService.sendToDLQ.mockRejectedValue(new Error('DLQ error'));

      // Call the private method using type assertion
      await (silo as any).sendToDLQ(mockMessage, new Error('Original error'), 'silo-ingest-queue', 2);

      // Verify the message was still acknowledged to prevent infinite retries
      expect(mockMessage.ack).toHaveBeenCalled();
    });
  });

  describe('Queue Processing - Validation Errors', () => {
    it('should send validation errors to DLQ immediately for silo-ingest-queue', async () => {
      // Create a batch with a message
      const batch = {
        queue: 'silo-ingest-queue',
        messages: [mockMessage],
      };

      // Mock content service to throw a validation error
      const validationError = new z.ZodError([]);
      mockServices.content.processIngestMessage.mockRejectedValue(validationError);

      // Mock sendToDLQ method
      const sendToDLQSpy = vi.spyOn(silo as any, 'sendToDLQ');

      // Process the queue
      await silo.queue(batch);

      // Verify sendToDLQ was called with the validation error
      expect(sendToDLQSpy).toHaveBeenCalledWith(mockMessage, validationError, 'silo-ingest-queue', 0);
    });

    it('should send validation errors to DLQ immediately for enriched-content', async () => {
      // Create a batch with a message
      const batch = {
        queue: 'enriched-content',
        messages: [mockMessage],
      };

      // Mock content service to throw a validation error
      const validationError = new z.ZodError([]);
      mockServices.content.processEnrichedContent.mockRejectedValue(validationError);

      // Mock sendToDLQ method
      const sendToDLQSpy = vi.spyOn(silo as any, 'sendToDLQ');

      // Process the queue
      await silo.queue(batch);

      // Verify sendToDLQ was called with the validation error
      expect(sendToDLQSpy).toHaveBeenCalledWith(
        mockMessage,
        validationError,
        'enriched-content',
        0,
      );
    });
  });

  describe('Queue Processing - Max Retries', () => {
    it('should send messages to DLQ after max retries for silo-ingest-queue', async () => {
      // Create a batch with a message that has reached max retries
      const maxRetryMessage = {
        ...mockMessage,
        retryCount: 2, // Max retries is 2
      };

      const batch = {
        queue: 'silo-ingest-queue',
        messages: [maxRetryMessage],
      };

      // Mock content service to throw a non-validation error
      const processingError = new Error('Processing error');
      mockServices.content.processIngestMessage.mockRejectedValue(processingError);

      // Mock sendToDLQ method
      const sendToDLQSpy = vi.spyOn(silo as any, 'sendToDLQ');

      // Process the queue
      await silo.queue(batch);

      // Verify sendToDLQ was called with the processing error
      expect(sendToDLQSpy).toHaveBeenCalledWith(
        maxRetryMessage,
        processingError,
        'silo-ingest-queue',
        2,
      );
    });

    it('should allow retry for messages that have not reached max retries', async () => {
      // Create a batch with a message that has not reached max retries
      const retryMessage = {
        ...mockMessage,
        retryCount: 1, // Less than max retries (2)
      };

      const batch = {
        queue: 'silo-ingest-queue',
        messages: [retryMessage],
      };

      // Mock content service to throw a non-validation error
      const processingError = new Error('Processing error');
      mockServices.content.processIngestMessage.mockRejectedValue(processingError);

      // Mock sendToDLQ method
      const sendToDLQSpy = vi.spyOn(silo as any, 'sendToDLQ');

      // Process the queue and expect it to throw to allow retry
      await expect(silo.queue(batch)).rejects.toThrow('Processing error');

      // Verify sendToDLQ was not called
      expect(sendToDLQSpy).not.toHaveBeenCalled();

      // Verify the message was not acknowledged
      expect(retryMessage.ack).not.toHaveBeenCalled();
    });
  });

  describe('DLQ Queue Processing', () => {
    it('should process messages from the DLQ queue', async () => {
      // Create a batch with a DLQ message
      const dlqMessage = {
        ...mockMessage,
        body: {
          originalMessage: { content: 'original content' },
          error: { message: 'Original error', name: 'Error' },
          processingMetadata: {
            queueName: 'silo-ingest-queue',
            messageId: 'original-id',
            retryCount: 3,
          },
          recovery: { reprocessed: false },
        },
      };

      const batch = {
        queue: 'ingest-dlq',
        messages: [dlqMessage],
      };

      // Process the queue
      await silo.queue(batch);

      // Verify the message was acknowledged
      expect(dlqMessage.ack).toHaveBeenCalled();
    });

    it('should handle errors when processing DLQ messages', async () => {
      // Create a batch with a DLQ message
      const dlqMessage = {
        ...mockMessage,
        body: {}, // Invalid DLQ message
      };

      const batch = {
        queue: 'ingest-dlq',
        messages: [dlqMessage],
      };

      // Process the queue
      await silo.queue(batch);

      // Verify the message was still acknowledged to prevent infinite retries
      expect(dlqMessage.ack).toHaveBeenCalled();
    });
  });
});
