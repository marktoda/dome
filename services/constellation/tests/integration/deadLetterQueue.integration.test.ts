/**
 * Dead Letter Queue Integration Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Constellation from '../../src/index';
import { SiloEmbedJob } from '@dome/common';

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

// Create real implementations of the services for integration testing
const mockPreprocessor = {
  process: vi.fn().mockReturnValue(['Chunk 1', 'Chunk 2']),
  normalize: vi.fn().mockImplementation(text => text),
};

const mockEmbedder = {
  embed: vi.fn().mockResolvedValue([
    [0.1, 0.2, 0.3],
    [0.4, 0.5, 0.6],
  ]),
};

const mockVectorize = {
  upsert: vi.fn().mockResolvedValue(undefined),
  query: vi.fn().mockResolvedValue([]),
  getStats: vi.fn().mockResolvedValue({ vectors: 100, dimension: 384 }),
};

const mockSiloService = {
  fetchContent: vi.fn().mockResolvedValue('Test content'),
  convertToEmbedJob: vi.fn().mockImplementation(async message => ({
    userId: message.userId || 'public',
    contentId: message.id,
    text: 'Test content',
    created: (message.createdAt || Math.floor(Date.now() / 1000)) * 1000,
    version: 1,
    category: message.category || 'note',
    mimeType: message.mimeType || 'text/markdown',
  })),
};

// Mock the service factories
vi.mock('../../src/services/preprocessor', () => ({
  createPreprocessor: vi.fn().mockReturnValue(mockPreprocessor),
}));

vi.mock('../../src/services/embedder', () => ({
  createEmbedder: vi.fn().mockReturnValue(mockEmbedder),
}));

vi.mock('../../src/services/vectorize', () => ({
  createVectorizeService: vi.fn().mockReturnValue(mockVectorize),
}));

vi.mock('../../src/services/siloService', () => ({
  createSiloService: vi.fn().mockReturnValue(mockSiloService),
  SiloService: {
    PUBLIC_CONTENT_USER_ID: 'public',
  },
}));

describe('Dead Letter Queue Integration Tests', () => {
  let constellation: Constellation;
  let mockEnv: any;

  beforeEach(() => {
    // Reset mocks
    vi.clearAllMocks();

    // Create a mock environment
    mockEnv = {
      VECTORIZE: {},
      AI: {},
      EMBED_DEAD: {
        send: vi.fn().mockResolvedValue(undefined),
      },
      SILO: {},
    };

    // Create a new Constellation instance with the mock environment
    constellation = new Constellation({} as any, {} as any);
    (constellation as any).env = mockEnv;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('End-to-end flow', () => {
    it('should process a parsing error message and log details', async () => {
      // Create a batch with a parsing error message
      const mockBatch = {
        messages: [
          {
            body: {
              error: 'Validation error: id is required',
              originalMessage: { userId: 'user1', category: 'note' },
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
      } as any; // Cast to any to bypass TypeScript checks

      await constellation.deadLetterQueue(mockBatch);

      // Verify the message was acknowledged
      expect(mockBatch.messages[0].ack).toHaveBeenCalled();

      // Verify metrics were incremented
      expect(vi.mocked(require('@dome/logging').metrics.increment)).toHaveBeenCalledWith(
        'deadletter.parsing_errors_processed',
      );

      // Verify logging with extracted information
      expect(vi.mocked(require('@dome/logging').getLogger)().info).toHaveBeenCalledWith(
        expect.objectContaining({
          contentId: 'unknown',
          userId: 'user1',
          error: 'Validation error: id is required',
          messageFields: expect.arrayContaining(['userId', 'category']),
        }),
        expect.any(String),
      );
    });

    it('should retry a retryable embedding error message', async () => {
      // Create a sample embed job
      const embedJob: SiloEmbedJob = {
        userId: 'user1',
        contentId: 'content1',
        text: 'Sample content',
        created: 1650000000000,
        version: 1,
        category: 'note',
        mimeType: 'text/markdown',
      };

      // Create a batch with an embedding error message (retryable)
      const mockBatch = {
        messages: [
          {
            body: {
              err: 'Connection timeout',
              job: embedJob,
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
      } as any; // Cast to any to bypass TypeScript checks

      await constellation.deadLetterQueue(mockBatch);

      // Verify the message was retried with exponential backoff
      expect(mockBatch.messages[0].retry).toHaveBeenCalledWith({ delaySeconds: 60 }); // 2^1 * 30
      expect(mockBatch.messages[0].ack).not.toHaveBeenCalled();

      // Verify metrics were updated
      expect(vi.mocked(require('@dome/logging').metrics.increment)).toHaveBeenCalledWith(
        'deadletter.messages_retried',
        1,
      );
    });

    it('should process a non-retryable embedding error message', async () => {
      // Create a sample embed job
      const embedJob: SiloEmbedJob = {
        userId: 'user1',
        contentId: 'content1',
        text: 'Sample content',
        created: 1650000000000,
        version: 1,
        category: 'note',
        mimeType: 'text/markdown',
      };

      // Create a batch with an embedding error message (non-retryable)
      const mockBatch = {
        messages: [
          {
            body: {
              err: 'Invalid input format',
              job: embedJob,
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
      } as any; // Cast to any to bypass TypeScript checks

      await constellation.deadLetterQueue(mockBatch);

      // Verify the message was acknowledged (not retried)
      expect(mockBatch.messages[0].ack).toHaveBeenCalled();
      expect(mockBatch.messages[0].retry).not.toHaveBeenCalled();

      // Verify metrics were incremented
      expect(vi.mocked(require('@dome/logging').metrics.increment)).toHaveBeenCalledWith(
        'deadletter.embedding_errors_processed',
      );
      expect(vi.mocked(require('@dome/logging').metrics.increment)).toHaveBeenCalledWith(
        'deadletter.messages_processed',
        1,
      );
    });

    it('should process a retryable embedding error that has reached max attempts', async () => {
      // Create a sample embed job
      const embedJob: SiloEmbedJob = {
        userId: 'user1',
        contentId: 'content1',
        text: 'Sample content',
        created: 1650000000000,
        version: 1,
        category: 'note',
        mimeType: 'text/markdown',
      };

      // Create a batch with an embedding error message (retryable, but max attempts reached)
      const mockBatch = {
        messages: [
          {
            body: {
              err: 'Connection timeout',
              job: embedJob,
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
      } as any; // Cast to any to bypass TypeScript checks

      await constellation.deadLetterQueue(mockBatch);

      // Verify the message was acknowledged (not retried)
      expect(mockBatch.messages[0].ack).toHaveBeenCalled();
      expect(mockBatch.messages[0].retry).not.toHaveBeenCalled();

      // Verify metrics were incremented
      expect(vi.mocked(require('@dome/logging').metrics.increment)).toHaveBeenCalledWith(
        'deadletter.embedding_errors_processed',
      );
      expect(vi.mocked(require('@dome/logging').metrics.increment)).toHaveBeenCalledWith(
        'deadletter.messages_processed',
        1,
      );
    });

    it('should handle a mixed batch of messages correctly', async () => {
      // Create a sample embed job
      const embedJob: SiloEmbedJob = {
        userId: 'user1',
        contentId: 'content1',
        text: 'Sample content',
        created: 1650000000000,
        version: 1,
        category: 'note',
        mimeType: 'text/markdown',
      };

      // Create a batch with different types of messages
      const mockBatch = {
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
              job: embedJob,
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
              job: embedJob,
            },
            ack: vi.fn(),
            retry: vi.fn(),
            attempts: 1,
            id: 'msg3',
            timestamp: Date.now(),
          },
          {
            // Malformed message
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
      } as any; // Cast to any to bypass TypeScript checks

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
      
      // Verify the fourth message (malformed) was acknowledged
      expect(mockBatch.messages[3].ack).toHaveBeenCalled();
      expect(mockBatch.messages[3].retry).not.toHaveBeenCalled();

      // Verify metrics were updated correctly
      expect(vi.mocked(require('@dome/logging').metrics.gauge)).toHaveBeenCalledWith(
        'deadletter.batch_size',
        4,
      );
      expect(vi.mocked(require('@dome/logging').metrics.increment)).toHaveBeenCalledWith(
        'deadletter.messages_processed',
        2, // 1 parsing error + 1 non-retryable embedding error
      );
      expect(vi.mocked(require('@dome/logging').metrics.increment)).toHaveBeenCalledWith(
        'deadletter.messages_retried',
        1, // 1 retryable embedding error
      );
      expect(vi.mocked(require('@dome/logging').metrics.increment)).toHaveBeenCalledWith(
        'deadletter.messages_malformed',
        1, // 1 malformed message
      );
    });
    
    it('should handle malformed job objects with missing fields', async () => {
      // Create a batch with a malformed embedding error message
      const mockBatch = {
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

      await constellation.deadLetterQueue(mockBatch);

      // Verify the message was retried (since connection timeout is retryable)
      expect(mockBatch.messages[0].retry).toHaveBeenCalled();
      
      // Verify logging with default values for missing fields
      expect(vi.mocked(require('@dome/logging').getLogger)().info).toHaveBeenCalledWith(
        expect.objectContaining({
          contentId: 'unknown',
          userId: 'unknown',
          jobFields: expect.arrayContaining(['text', 'created']),
        }),
        'Processing embedding error from dead letter queue'
      );
    });
  });

  describe('Integration with embedBatch', () => {
    it('should send failed embedding jobs to the dead letter queue', async () => {
      // Create a sample embed job
      const embedJob: SiloEmbedJob = {
        userId: 'user1',
        contentId: 'content1',
        text: 'Sample content',
        created: 1650000000000,
        version: 1,
        category: 'note',
        mimeType: 'text/markdown',
      };

      // Force embedder.embed to throw an error
      mockEmbedder.embed.mockRejectedValueOnce(new Error('Embedding failed'));

      // Call embedBatch directly
      await (constellation as any).embedBatch([embedJob], mockEnv.EMBED_DEAD);

      // Verify the error was sent to the dead letter queue
      expect(mockEnv.EMBED_DEAD.send).toHaveBeenCalledWith({
        err: expect.stringContaining('Embedding failed'),
        job: embedJob,
      });
    });

    it('should process a message from the dead letter queue and retry embedding', async () => {
      // Create a sample embed job
      const embedJob: SiloEmbedJob = {
        userId: 'user1',
        contentId: 'content1',
        text: 'Sample content',
        created: 1650000000000,
        version: 1,
        category: 'note',
        mimeType: 'text/markdown',
      };

      // Create a batch with an embedding error message (retryable)
      const mockBatch = {
        messages: [
          {
            body: {
              err: 'Connection timeout',
              job: embedJob,
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
      } as any; // Cast to any to bypass TypeScript checks

      // Process the dead letter queue
      await constellation.deadLetterQueue(mockBatch);

      // Verify the message was retried
      expect(mockBatch.messages[0].retry).toHaveBeenCalled();

      // Now simulate the message being reprocessed after retry
      // First, reset the mocks
      vi.clearAllMocks();

      // Create a new batch with the same message but incremented attempts
      const retriedBatch = {
        messages: [
          {
            body: {
              err: 'Connection timeout',
              job: embedJob,
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
      } as any; // Cast to any to bypass TypeScript checks

      // This time, make the embedding succeed
      mockEmbedder.embed.mockResolvedValueOnce([
        [0.1, 0.2, 0.3],
        [0.4, 0.5, 0.6],
      ]);

      // Process the dead letter queue again
      await constellation.deadLetterQueue(retriedBatch);

      // Verify the message was retried again (since it's still retryable and under max attempts)
      expect(retriedBatch.messages[0].retry).toHaveBeenCalled();
    });
  });

  describe('Integration with queue consumer', () => {
    it('should send validation errors to the dead letter queue', async () => {
      // Create a batch with an invalid message
      const mockBatch = {
        messages: [
          {
            body: {
              // Missing required fields
              userId: 'user1',
              // No id field
            },
            ack: vi.fn(),
            retry: vi.fn(),
            attempts: 1,
            id: 'msg1',
            timestamp: Date.now(),
          },
        ],
        queue: 'new-content-constellation',
        retryAll: vi.fn(),
        ackAll: vi.fn(),
      } as any; // Cast to any to bypass TypeScript checks

      // Process the queue
      await constellation.queue(mockBatch);

      // Verify the message was acknowledged
      expect(mockBatch.messages[0].ack).toHaveBeenCalled();

      // Verify the error was sent to the dead letter queue
      expect(mockEnv.EMBED_DEAD.send).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining('Validation error'),
          originalMessage: mockBatch.messages[0].body,
        }),
      );
    });

    it('should send embedding errors to the dead letter queue', async () => {
      // Create a batch with a valid message
      const mockBatch = {
        messages: [
          {
            body: {
              id: 'content1',
              userId: 'user1',
              category: 'note',
              mimeType: 'text/markdown',
              createdAt: 1650000000,
              deleted: false,
            },
            ack: vi.fn(),
            retry: vi.fn(),
            attempts: 1,
            id: 'msg1',
            timestamp: Date.now(),
          },
        ],
        queue: 'new-content-constellation',
        retryAll: vi.fn(),
        ackAll: vi.fn(),
      } as any; // Cast to any to bypass TypeScript checks

      // Force embedder.embed to throw an error
      mockEmbedder.embed.mockRejectedValueOnce(new Error('Embedding failed'));

      // Process the queue
      await constellation.queue(mockBatch);

      // Verify the message was acknowledged
      expect(mockBatch.messages[0].ack).toHaveBeenCalled();

      // Verify the error was sent to the dead letter queue
      expect(mockEnv.EMBED_DEAD.send).toHaveBeenCalledWith(
        expect.objectContaining({
          err: expect.stringContaining('Embedding failed'),
          job: expect.objectContaining({
            contentId: 'content1',
            userId: 'user1',
          }),
        }),
      );
    });
  });
});
