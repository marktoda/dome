/**
 * Dead Letter Queue Consumer Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Constellation from '../../src/index';

// Mock the logger and metrics
vi.mock('@dome/logging', () => ({
  getLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  metrics: {
    increment: vi.fn(),
    gauge: vi.fn(),
    timing: vi.fn(),
    startTimer: vi.fn().mockReturnValue({
      stop: vi.fn(),
    }),
  },
  withLogger: vi.fn().mockImplementation((_, fn) => fn()),
  logError: vi.fn(),
}));

// Mock the services
vi.mock('../../src/services/preprocessor', () => ({
  createPreprocessor: vi.fn().mockReturnValue({
    process: vi.fn(),
    normalize: vi.fn(),
  }),
}));

vi.mock('../../src/services/embedder', () => ({
  createEmbedder: vi.fn().mockReturnValue({
    embed: vi.fn(),
  }),
}));

vi.mock('../../src/services/vectorize', () => ({
  createVectorizeService: vi.fn().mockReturnValue({
    upsert: vi.fn(),
    query: vi.fn(),
    getStats: vi.fn(),
  }),
}));

vi.mock('../../src/services/siloService', () => ({
  createSiloService: vi.fn().mockReturnValue({
    fetchContent: vi.fn(),
    convertToEmbedJob: vi.fn(),
  }),
  SiloService: {
    PUBLIC_USER_ID: 'public',
  },
}));

describe('Dead Letter Queue Consumer', () => {
  let constellation: Constellation;
  let mockEnv: any;
  let mockBatch: any;

  beforeEach(() => {
    // Create a mock environment
    mockEnv = {
      VECTORIZE: {},
      AI: {},
      EMBED_DEAD: {
        send: vi.fn().mockResolvedValue(undefined),
      },
    };

    // Create a new Constellation instance with the mock environment
    // Create a new Constellation instance with the mock environment
    constellation = new Constellation({} as any, {} as any);
    (constellation as any).env = mockEnv;

    // Reset mocks
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('deadLetterQueue', () => {
    it('should process an empty batch without errors', async () => {
      // Create an empty batch
      mockBatch = {
        messages: [],
        queue: 'embed-dead-letter',
        retryAll: vi.fn(),
        ackAll: vi.fn(),
      } as any;

      await constellation.deadLetterQueue(mockBatch);

      // Verify metrics were called with correct values
      expect(vi.mocked(require('@dome/logging').metrics.gauge)).toHaveBeenCalledWith(
        'deadletter.batch_size',
        0,
      );
    });

    it('should handle empty message bodies', async () => {
      // Create a batch with an empty message body
      mockBatch = {
        messages: [
          {
            body: null,
            ack: vi.fn(),
            retry: vi.fn(),
            attempts: 1,
            id: 'msg1',
            timestamp: Date.now(),
          },
        ],
        queue: 'embed-dead-letter',
        retryAll: vi.fn(),
        ackAll: vi.fn(),
      } as any;

      await constellation.deadLetterQueue(mockBatch);

      // Verify the message was acknowledged
      expect(mockBatch.messages[0].ack).toHaveBeenCalled();
      expect(mockBatch.messages[0].retry).not.toHaveBeenCalled();
    });

    it('should handle parsing error messages', async () => {
      // Create a batch with a parsing error message
      mockBatch = {
        messages: [
          {
            body: {
              error: 'Validation error: id is required',
              originalMessage: { userId: 'user1' },
            },
            ack: vi.fn(),
            retry: vi.fn(),
            attempts: 1,
            id: 'msg1',
            timestamp: Date.now(),
          },
        ],
        queue: 'embed-dead-letter',
        retryAll: vi.fn(),
        ackAll: vi.fn(),
      } as any;

      // Spy on the handleParsingError method
      const handleParsingErrorSpy = vi.spyOn(constellation as any, 'handleParsingError');

      await constellation.deadLetterQueue(mockBatch);

      // Verify handleParsingError was called with the correct payload
      expect(handleParsingErrorSpy).toHaveBeenCalledWith({
        error: 'Validation error: id is required',
        originalMessage: { userId: 'user1' },
      });

      // Verify the message was acknowledged
      expect(mockBatch.messages[0].ack).toHaveBeenCalled();
      expect(mockBatch.messages[0].retry).not.toHaveBeenCalled();

      // Verify metrics were incremented
      expect(vi.mocked(require('@dome/logging').metrics.increment)).toHaveBeenCalledWith(
        'deadletter.parsing_errors_processed',
      );
    });

    it('should handle embedding error messages with retryable error (first attempt)', async () => {
      // Create a batch with an embedding error message (retryable)
      mockBatch = {
        messages: [
          {
            body: {
              err: 'Connection timeout',
              job: {
                userId: 'user1',
                contentId: 'content1',
                text: 'Sample content',
                created: 1650000000000,
                version: 1,
                category: 'note',
                mimeType: 'text/markdown',
              },
            },
            ack: vi.fn(),
            retry: vi.fn(),
            attempts: 1,
            id: 'msg1',
            timestamp: Date.now(),
          },
        ],
        queue: 'embed-dead-letter',
        retryAll: vi.fn(),
        ackAll: vi.fn(),
      } as any;

      // Spy on the isRetryableError method and force it to return true
      const isRetryableErrorSpy = vi
        .spyOn(constellation as any, 'isRetryableError')
        .mockReturnValue(true);

      await constellation.deadLetterQueue(mockBatch);

      // Verify isRetryableError was called with the correct error message
      expect(isRetryableErrorSpy).toHaveBeenCalledWith('Connection timeout');

      // Verify the message was retried with exponential backoff
      expect(mockBatch.messages[0].retry).toHaveBeenCalledWith({ delaySeconds: 60 }); // 2^1 * 30
      expect(mockBatch.messages[0].ack).not.toHaveBeenCalled();
    });

    it('should handle embedding error messages with retryable error (second attempt)', async () => {
      // Create a batch with an embedding error message (retryable, second attempt)
      mockBatch = {
        messages: [
          {
            body: {
              err: 'Connection timeout',
              job: {
                userId: 'user1',
                contentId: 'content1',
                text: 'Sample content',
                created: 1650000000000,
                version: 1,
                category: 'note',
                mimeType: 'text/markdown',
              },
            },
            ack: vi.fn(),
            retry: vi.fn(),
            attempts: 2,
            id: 'msg1',
            timestamp: Date.now(),
          },
        ],
        queue: 'embed-dead-letter',
        retryAll: vi.fn(),
        ackAll: vi.fn(),
      } as any;

      // Spy on the isRetryableError method and force it to return true
      const isRetryableErrorSpy = vi
        .spyOn(constellation as any, 'isRetryableError')
        .mockReturnValue(true);

      await constellation.deadLetterQueue(mockBatch);

      // Verify the message was retried with exponential backoff
      expect(mockBatch.messages[0].retry).toHaveBeenCalledWith({ delaySeconds: 120 }); // 2^2 * 30
      expect(mockBatch.messages[0].ack).not.toHaveBeenCalled();
    });

    it('should handle embedding error messages with retryable error (max attempts reached)', async () => {
      // Create a batch with an embedding error message (retryable, but max attempts reached)
      mockBatch = {
        messages: [
          {
            body: {
              err: 'Connection timeout',
              job: {
                userId: 'user1',
                contentId: 'content1',
                text: 'Sample content',
                created: 1650000000000,
                version: 1,
                category: 'note',
                mimeType: 'text/markdown',
              },
            },
            ack: vi.fn(),
            retry: vi.fn(),
            attempts: 3, // Max attempts reached
            id: 'msg1',
            timestamp: Date.now(),
          },
        ],
        queue: 'embed-dead-letter',
        retryAll: vi.fn(),
        ackAll: vi.fn(),
      } as any;

      // Spy on the isRetryableError method and force it to return true
      const isRetryableErrorSpy = vi
        .spyOn(constellation as any, 'isRetryableError')
        .mockReturnValue(true);

      await constellation.deadLetterQueue(mockBatch);

      // Verify the message was acknowledged (not retried)
      expect(mockBatch.messages[0].retry).not.toHaveBeenCalled();
      expect(mockBatch.messages[0].ack).toHaveBeenCalled();

      // Verify metrics were incremented
      expect(vi.mocked(require('@dome/logging').metrics.increment)).toHaveBeenCalledWith(
        'deadletter.embedding_errors_processed',
      );
    });

    it('should handle embedding error messages with non-retryable error', async () => {
      // Create a batch with an embedding error message (non-retryable)
      mockBatch = {
        messages: [
          {
            body: {
              err: 'Invalid input format',
              job: {
                userId: 'user1',
                contentId: 'content1',
                text: 'Sample content',
                created: 1650000000000,
                version: 1,
                category: 'note',
                mimeType: 'text/markdown',
              },
            },
            ack: vi.fn(),
            retry: vi.fn(),
            attempts: 1,
            id: 'msg1',
            timestamp: Date.now(),
          },
        ],
        queue: 'embed-dead-letter',
        retryAll: vi.fn(),
        ackAll: vi.fn(),
      } as any;

      // Spy on the isRetryableError method and force it to return false
      const isRetryableErrorSpy = vi
        .spyOn(constellation as any, 'isRetryableError')
        .mockReturnValue(false);

      await constellation.deadLetterQueue(mockBatch);

      // Verify isRetryableError was called with the correct error message
      expect(isRetryableErrorSpy).toHaveBeenCalledWith('Invalid input format');

      // Verify the message was acknowledged (not retried)
      expect(mockBatch.messages[0].retry).not.toHaveBeenCalled();
      expect(mockBatch.messages[0].ack).toHaveBeenCalled();

      // Verify metrics were incremented
      expect(vi.mocked(require('@dome/logging').metrics.increment)).toHaveBeenCalledWith(
        'deadletter.embedding_errors_processed',
      );
    });

    it('should handle unknown message formats', async () => {
      // Create a batch with an unknown message format
      mockBatch = {
        messages: [
          {
            body: {
              unknownField: 'some value',
            },
            ack: vi.fn(),
            retry: vi.fn(),
            attempts: 1,
            id: 'msg1',
            timestamp: Date.now(),
          },
        ],
        queue: 'embed-dead-letter',
        retryAll: vi.fn(),
        ackAll: vi.fn(),
      } as any;

      await constellation.deadLetterQueue(mockBatch);

      // Verify the message was acknowledged
      expect(mockBatch.messages[0].ack).toHaveBeenCalled();
      expect(mockBatch.messages[0].retry).not.toHaveBeenCalled();

      // Verify error was logged with keys information
      expect(vi.mocked(require('@dome/logging').getLogger)().error).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({ unknownField: 'some value' }),
          keys: ['unknownField'],
        }),
        'Malformed message in dead letter queue',
      );

      // Verify malformed count metric was incremented
      expect(vi.mocked(require('@dome/logging').metrics.increment)).toHaveBeenCalledWith(
        'deadletter.messages_malformed',
        expect.any(Number),
      );
    });

    it('should handle malformed job objects in embedding error messages', async () => {
      // Create a batch with a malformed embedding error message (missing required fields)
      mockBatch = {
        messages: [
          {
            body: {
              err: 'Connection timeout',
              job: {
                // Missing userId and contentId
                text: 'Sample content',
                created: 1650000000000,
              },
            },
            ack: vi.fn(),
            retry: vi.fn(),
            attempts: 1,
            id: 'msg1',
            timestamp: Date.now(),
          },
        ],
        queue: 'embed-dead-letter',
        retryAll: vi.fn(),
        ackAll: vi.fn(),
      } as any;

      // Spy on the isRetryableError method and force it to return true
      const isRetryableErrorSpy = vi
        .spyOn(constellation as any, 'isRetryableError')
        .mockReturnValue(true);

      await constellation.deadLetterQueue(mockBatch);

      // Verify the message was retried with exponential backoff
      expect(mockBatch.messages[0].retry).toHaveBeenCalledWith({ delaySeconds: 60 }); // 2^1 * 30

      // Verify the handleEmbeddingError was called with default values for missing fields
      expect(vi.mocked(require('@dome/logging').getLogger)().info).toHaveBeenCalledWith(
        expect.objectContaining({
          contentId: 'unknown',
          userId: 'unknown',
          jobFields: ['text', 'created'],
        }),
        'Processing embedding error from dead letter queue',
      );
    });

    it('should handle non-object message bodies', async () => {
      // Create a batch with a non-object message body
      mockBatch = {
        messages: [
          {
            body: 'This is a string, not an object',
            ack: vi.fn(),
            retry: vi.fn(),
            attempts: 1,
            id: 'msg1',
            timestamp: Date.now(),
          },
        ],
        queue: 'embed-dead-letter',
        retryAll: vi.fn(),
        ackAll: vi.fn(),
      } as any;

      await constellation.deadLetterQueue(mockBatch);

      // Verify the message was acknowledged
      expect(mockBatch.messages[0].ack).toHaveBeenCalled();
      expect(mockBatch.messages[0].retry).not.toHaveBeenCalled();

      // Verify error was logged
      expect(vi.mocked(require('@dome/logging').getLogger)().error).toHaveBeenCalledWith(
        expect.objectContaining({
          bodyType: 'string',
          body: 'This is a string, not an object',
        }),
        'Invalid message type in dead letter queue',
      );

      // Verify malformed count metric was incremented
      expect(vi.mocked(require('@dome/logging').metrics.increment)).toHaveBeenCalledWith(
        'deadletter.messages_malformed',
        expect.any(Number),
      );
    });

    it('should handle errors during message processing', async () => {
      // Create a batch with a valid message
      mockBatch = {
        messages: [
          {
            body: {
              error: 'Validation error',
              originalMessage: { userId: 'user1' },
            },
            ack: vi.fn(),
            retry: vi.fn(),
            attempts: 1,
            id: 'msg1',
            timestamp: Date.now(),
          },
        ],
        queue: 'embed-dead-letter',
        retryAll: vi.fn(),
        ackAll: vi.fn(),
      } as any;

      // Force handleParsingError to throw an error
      vi.spyOn(constellation as any, 'handleParsingError').mockImplementation(() => {
        throw new Error('Unexpected error');
      });

      await constellation.deadLetterQueue(mockBatch);

      // Verify the message was acknowledged despite the error
      expect(mockBatch.messages[0].ack).toHaveBeenCalled();

      // Verify error was logged
      expect(vi.mocked(require('@dome/logging').getLogger)().error).toHaveBeenCalled();
    });

    it('should process a mixed batch of messages correctly', async () => {
      // Create a batch with different types of messages
      mockBatch = {
        messages: [
          {
            // Parsing error
            body: {
              error: 'Validation error',
              originalMessage: { userId: 'user1' },
            },
            ack: vi.fn(),
            retry: vi.fn(),
            attempts: 1,
            id: 'msg1',
            timestamp: Date.now(),
          },
          {
            // Embedding error (retryable)
            body: {
              err: 'Connection timeout',
              job: {
                userId: 'user2',
                contentId: 'content2',
                text: 'Sample content',
                created: 1650000000000,
                version: 1,
                category: 'note',
                mimeType: 'text/markdown',
              },
            },
            ack: vi.fn(),
            retry: vi.fn(),
            attempts: 1,
            id: 'msg2',
            timestamp: Date.now(),
          },
          {
            // Embedding error (non-retryable)
            body: {
              err: 'Invalid input format',
              job: {
                userId: 'user3',
                contentId: 'content3',
                text: 'Sample content',
                created: 1650000000000,
                version: 1,
                category: 'note',
                mimeType: 'text/markdown',
              },
            },
            ack: vi.fn(),
            retry: vi.fn(),
            attempts: 1,
            id: 'msg3',
            timestamp: Date.now(),
          },
          {
            // Unknown format
            body: {
              unknownField: 'some value',
            },
            ack: vi.fn(),
            retry: vi.fn(),
            attempts: 1,
            id: 'msg4',
            timestamp: Date.now(),
          },
        ],
        queue: 'embed-dead-letter',
        retryAll: vi.fn(),
        ackAll: vi.fn(),
      } as any;

      // Mock isRetryableError to return true for "Connection timeout" and false otherwise
      vi.spyOn(constellation as any, 'isRetryableError').mockImplementation(
        (errorMessage: any) => errorMessage === 'Connection timeout',
      );

      await constellation.deadLetterQueue(mockBatch);

      // Verify the first message (parsing error) was acknowledged
      expect(mockBatch.messages[0].ack).toHaveBeenCalled();
      expect(mockBatch.messages[0].retry).not.toHaveBeenCalled();

      // Verify the second message (retryable embedding error) was retried
      expect(mockBatch.messages[1].retry).toHaveBeenCalled();
      expect(mockBatch.messages[1].ack).not.toHaveBeenCalled();

      // Verify the third message (non-retryable embedding error) was acknowledged
      expect(mockBatch.messages[2].ack).toHaveBeenCalled();
      expect(mockBatch.messages[2].retry).not.toHaveBeenCalled();

      // Verify the fourth message (unknown format) was acknowledged
      expect(mockBatch.messages[3].ack).toHaveBeenCalled();
      expect(mockBatch.messages[3].retry).not.toHaveBeenCalled();

      // Verify metrics were updated correctly
      expect(vi.mocked(require('@dome/logging').metrics.gauge)).toHaveBeenCalledWith(
        'deadletter.batch_size',
        4,
      );
      expect(vi.mocked(require('@dome/logging').metrics.increment)).toHaveBeenCalledWith(
        'deadletter.messages_processed',
        3, // 1 parsing error + 1 non-retryable embedding error + 1 unknown format
      );
      expect(vi.mocked(require('@dome/logging').metrics.increment)).toHaveBeenCalledWith(
        'deadletter.messages_retried',
        1, // 1 retryable embedding error
      );
    });
  });

  describe('handleParsingError', () => {
    it('should extract contentId and userId from the original message', async () => {
      const payload = {
        error: 'Validation error: category is required',
        originalMessage: {
          id: 'content123',
          userId: 'user123',
          mimeType: 'text/markdown',
        },
      };

      await (constellation as any).handleParsingError(payload);

      // Verify logging with extracted information
      expect(vi.mocked(require('@dome/logging').getLogger)().info).toHaveBeenCalledWith(
        expect.objectContaining({
          contentId: 'content123',
          userId: 'user123',
          error: 'Validation error: category is required',
        }),
        expect.any(String),
      );

      // Verify metrics were incremented
      expect(vi.mocked(require('@dome/logging').metrics.increment)).toHaveBeenCalledWith(
        'deadletter.parsing_errors_processed',
      );
    });

    it('should handle null userId in the original message', async () => {
      const payload = {
        error: 'Validation error: category is required',
        originalMessage: {
          id: 'content123',
          userId: null,
          mimeType: 'text/markdown',
        },
      };

      await (constellation as any).handleParsingError(payload);

      // Verify logging with extracted information
      expect(vi.mocked(require('@dome/logging').getLogger)().info).toHaveBeenCalledWith(
        expect.objectContaining({
          contentId: 'content123',
          userId: 'null',
          error: 'Validation error: category is required',
        }),
        expect.any(String),
      );
    });

    it('should handle missing fields in the original message', async () => {
      const payload = {
        error: 'Validation error: id is required',
        originalMessage: {
          // No id or userId
          mimeType: 'text/markdown',
        },
      };

      await (constellation as any).handleParsingError(payload);

      // Verify logging with default values
      expect(vi.mocked(require('@dome/logging').getLogger)().info).toHaveBeenCalledWith(
        expect.objectContaining({
          contentId: 'unknown',
          userId: 'unknown',
          error: 'Validation error: id is required',
        }),
        expect.any(String),
      );
    });

    it('should handle non-object original message', async () => {
      const payload = {
        error: 'Invalid message format',
        originalMessage: 'not an object',
      };

      await (constellation as any).handleParsingError(payload);

      // Verify logging with default values
      expect(vi.mocked(require('@dome/logging').getLogger)().info).toHaveBeenCalledWith(
        expect.objectContaining({
          contentId: 'unknown',
          userId: 'unknown',
          error: 'Invalid message format',
        }),
        expect.any(String),
      );
    });
  });

  describe('handleEmbeddingError', () => {
    it('should return true for retryable errors with attempts < 3', async () => {
      const payload = {
        err: 'Connection timeout',
        job: {
          userId: 'user1',
          contentId: 'content1',
          text: 'Sample content',
          created: 1650000000000,
          version: 1,
          category: 'note',
          mimeType: 'text/markdown',
        },
      };

      // Force isRetryableError to return true
      vi.spyOn(constellation as any, 'isRetryableError').mockReturnValue(true);

      const result = await (constellation as any).handleEmbeddingError(payload, 1);

      // Verify the result is true (should retry)
      expect(result).toBe(true);

      // Verify logging
      expect(vi.mocked(require('@dome/logging').getLogger)().info).toHaveBeenCalledWith(
        expect.objectContaining({
          contentId: 'content1',
          error: 'Connection timeout',
          attempts: 1,
        }),
        'Will retry embedding job',
      );
    });

    it('should return false for retryable errors with attempts >= 3', async () => {
      const payload = {
        err: 'Connection timeout',
        job: {
          userId: 'user1',
          contentId: 'content1',
          text: 'Sample content',
          created: 1650000000000,
          version: 1,
          category: 'note',
          mimeType: 'text/markdown',
        },
      };

      // Force isRetryableError to return true
      vi.spyOn(constellation as any, 'isRetryableError').mockReturnValue(true);

      const result = await (constellation as any).handleEmbeddingError(payload, 3);

      // Verify the result is false (should not retry)
      expect(result).toBe(false);

      // Verify logging
      expect(vi.mocked(require('@dome/logging').getLogger)().warn).toHaveBeenCalledWith(
        expect.objectContaining({
          contentId: 'content1',
          error: 'Connection timeout',
          attempts: 3,
        }),
        'Embedding error cannot be retried or max attempts reached',
      );

      // Verify metrics were incremented
      expect(vi.mocked(require('@dome/logging').metrics.increment)).toHaveBeenCalledWith(
        'deadletter.embedding_errors_processed',
      );
    });

    it('should return false for non-retryable errors', async () => {
      const payload = {
        err: 'Invalid input format',
        job: {
          userId: 'user1',
          contentId: 'content1',
          text: 'Sample content',
          created: 1650000000000,
          version: 1,
          category: 'note',
          mimeType: 'text/markdown',
        },
      };

      // Force isRetryableError to return false
      vi.spyOn(constellation as any, 'isRetryableError').mockReturnValue(false);

      const result = await (constellation as any).handleEmbeddingError(payload, 1);

      // Verify the result is false (should not retry)
      expect(result).toBe(false);

      // Verify logging
      expect(vi.mocked(require('@dome/logging').getLogger)().warn).toHaveBeenCalledWith(
        expect.objectContaining({
          contentId: 'content1',
          error: 'Invalid input format',
          attempts: 1,
        }),
        'Embedding error cannot be retried or max attempts reached',
      );

      // Verify metrics were incremented
      expect(vi.mocked(require('@dome/logging').metrics.increment)).toHaveBeenCalledWith(
        'deadletter.embedding_errors_processed',
      );
    });
  });

  describe('isRetryableError', () => {
    it('should return true for timeout errors', () => {
      expect((constellation as any).isRetryableError('Connection timeout')).toBe(true);
      expect((constellation as any).isRetryableError('Request timed out')).toBe(true);
      expect((constellation as any).isRetryableError('Operation timeout')).toBe(true);
    });

    it('should return true for connection errors', () => {
      expect((constellation as any).isRetryableError('Connection refused')).toBe(true);
      expect((constellation as any).isRetryableError('Connection reset')).toBe(true);
      expect((constellation as any).isRetryableError('Failed to establish connection')).toBe(true);
    });

    it('should return true for network errors', () => {
      expect((constellation as any).isRetryableError('Network error')).toBe(true);
      expect((constellation as any).isRetryableError('Network unavailable')).toBe(true);
    });

    it('should return true for throttling and rate limit errors', () => {
      expect((constellation as any).isRetryableError('Request throttled')).toBe(true);
      expect((constellation as any).isRetryableError('Rate limit exceeded')).toBe(true);
      expect((constellation as any).isRetryableError('Too many requests')).toBe(true);
    });

    it('should return true for server errors', () => {
      expect((constellation as any).isRetryableError('Service unavailable')).toBe(true);
      expect((constellation as any).isRetryableError('Internal server error')).toBe(true);
      expect((constellation as any).isRetryableError('500 Internal Server Error')).toBe(true);
      expect((constellation as any).isRetryableError('503 Service Unavailable')).toBe(true);
    });

    it('should return true for additional retryable patterns', () => {
      expect((constellation as any).isRetryableError('Service temporarily unavailable')).toBe(true);
      expect((constellation as any).isRetryableError('System overloaded')).toBe(true);
      expect((constellation as any).isRetryableError('Please try again later')).toBe(true);
      expect((constellation as any).isRetryableError('Resource exhausted')).toBe(true);
    });

    it('should return false for client errors', () => {
      expect((constellation as any).isRetryableError('Invalid input')).toBe(false);
      expect((constellation as any).isRetryableError('Bad request')).toBe(false);
      expect((constellation as any).isRetryableError('Unauthorized')).toBe(false);
      expect((constellation as any).isRetryableError('Not found')).toBe(false);
      expect((constellation as any).isRetryableError('400 Bad Request')).toBe(false);
      expect((constellation as any).isRetryableError('404 Not Found')).toBe(false);
    });

    it('should return false for validation errors', () => {
      expect((constellation as any).isRetryableError('Validation failed')).toBe(false);
      expect((constellation as any).isRetryableError('Schema validation error')).toBe(false);
      expect((constellation as any).isRetryableError('Invalid format')).toBe(false);
    });
  });

  describe('sendToDeadLetter', () => {
    it('should send payload to the dead letter queue', async () => {
      const payload = {
        error: 'Test error',
        originalMessage: { id: 'test-id' },
      };

      await (constellation as any).sendToDeadLetter(mockEnv.EMBED_DEAD, payload);

      // Verify the queue.send method was called with the payload
      expect(mockEnv.EMBED_DEAD.send).toHaveBeenCalledWith(payload);
    });

    it('should handle errors when sending to the queue', async () => {
      const payload = {
        error: 'Test error',
        originalMessage: { id: 'test-id' },
      };

      // Force queue.send to throw an error
      mockEnv.EMBED_DEAD.send.mockRejectedValueOnce(new Error('Queue error'));

      await (constellation as any).sendToDeadLetter(mockEnv.EMBED_DEAD, payload);

      // Verify error was logged
      expect(vi.mocked(require('@dome/logging').getLogger)().error).toHaveBeenCalledWith(
        expect.objectContaining({
          err: expect.any(Error),
          payload,
        }),
        'Failed to write to dead‑letter queue',
      );
    });

    it('should do nothing if queue is undefined', async () => {
      const payload = {
        error: 'Test error',
        originalMessage: { id: 'test-id' },
      };

      await (constellation as any).sendToDeadLetter(undefined, payload);

      // Verify no errors were logged
      expect(vi.mocked(require('@dome/logging').getLogger)().error).not.toHaveBeenCalled();
    });
  });
});
