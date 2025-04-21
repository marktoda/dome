import { describe, it, expect, vi, beforeEach } from 'vitest';
import AiProcessor from '../src/index';

// Mock the services
vi.mock('../src/services/llmService', () => ({
  createLlmService: vi.fn().mockImplementation(() => ({
    processContent: vi.fn().mockResolvedValue({
      title: 'Test Title',
      summary: 'Test summary.',
      todos: [{ text: 'Test todo', priority: 'high' }],
      topics: ['test', 'example'],
      processingVersion: 1,
      modelUsed: '@cf/meta/llama-3-8b-instruct',
    }),
  })),
}));

vi.mock('../src/services/siloService', () => ({
  createSiloService: vi.fn().mockImplementation(() => ({
    fetchContent: vi.fn().mockResolvedValue('Test content body'),
  })),
}));

// Mock the logger
vi.mock('../src/utils/logging', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  }),
  initLogging: vi.fn(),
  metrics: {
    increment: vi.fn(),
    timing: vi.fn(),
  },
}));

// Import the mocks after they're defined
import { createLlmService } from '../src/services/llmService';
import { createSiloService } from '../src/services/siloService';

describe('AI Processor Worker', () => {
  let mockEnv: any;
  let mockBatch: MessageBatch<any>;
  let mockLlmService: any;
  let mockSiloService: any;
  let processor: any;

  beforeEach(() => {
    // Reset mocks
    vi.clearAllMocks();

    // Create mock services
    mockLlmService = (createLlmService as any)();
    mockSiloService = (createSiloService as any)();

    // Create mock environment
    mockEnv = {
      NEW_CONTENT: {
        send: vi.fn(),
      },
      ENRICHED_CONTENT: {
        send: vi.fn(),
      },
      SILO: {},
      AI: {},
      LOG_LEVEL: 'info',
      VERSION: '0.1.0',
      ENVIRONMENT: 'test',
    };

    // Create processor instance
    processor = AiProcessor;
    processor.env = mockEnv;

    // Create mock batch
    mockBatch = {
      queue: 'new-content',
      messages: [
        {
          id: 'message-1',
          body: {
            id: 'content-1',
            userId: 'user-1',
            category: 'note',
            mimeType: 'text/plain',
            size: 100,
            createdAt: 1234567890,
          },
          timestamp: new Date(),
          attempts: 1,
          retry: () => {},
          ack: () => Promise.resolve({}),
        },
      ],
      retryAll: () => {},
      ackAll: () => Promise.resolve({}),
    };
  });

  describe('queue handler', () => {
    it('should process messages from the NEW_CONTENT queue', async () => {
      // Process the batch
      await processor.queue(mockBatch);

      // Check that services were created
      expect(createLlmService).toHaveBeenCalledWith(mockEnv.AI);
      expect(createSiloService).toHaveBeenCalledWith(mockEnv.SILO);

      // Check that content was fetched
      expect(mockSiloService.fetchContent).toHaveBeenCalledWith('content-1', 'user-1');

      // Check that content was processed
      expect(mockLlmService.processContent).toHaveBeenCalledWith('Test content body', 'note');

      // Check that enriched content was published
      expect(mockEnv.ENRICHED_CONTENT.send).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'content-1',
          userId: 'user-1',
          contentType: 'note',
          metadata: expect.objectContaining({
            title: 'Test Title',
            summary: 'Test summary.',
          }),
        }),
      );
    });

    it('should skip deleted content', async () => {
      // Create batch with deleted content
      mockBatch.messages[0].body.deleted = true;

      // Process the batch
      await processor.queue(mockBatch);

      // Check that content was not processed
      expect(mockSiloService.fetchContent).not.toHaveBeenCalled();
      expect(mockLlmService.processContent).not.toHaveBeenCalled();

      // Check that no message was published
      expect(mockEnv.ENRICHED_CONTENT.send).not.toHaveBeenCalled();
    });

    it('should skip non-processable content types', async () => {
      // Create batch with non-processable content type
      mockBatch.messages[0].body.category = 'binary';
      mockBatch.messages[0].body.mimeType = 'application/octet-stream';

      // Process the batch
      await processor.queue(mockBatch);

      // Check that content was not processed
      expect(mockSiloService.fetchContent).not.toHaveBeenCalled();
      expect(mockLlmService.processContent).not.toHaveBeenCalled();

      // Check that no message was published
      expect(mockEnv.ENRICHED_CONTENT.send).not.toHaveBeenCalled();
    });

    it('should handle errors during content fetching', async () => {
      // Mock siloService to throw an error
      mockSiloService.fetchContent.mockRejectedValue(new Error('Fetch error'));

      // Process the batch
      await expect(processor.queue(mockBatch)).resolves.not.toThrow();

      // Check that content was not processed
      expect(mockLlmService.processContent).not.toHaveBeenCalled();

      // Check that no message was published
      expect(mockEnv.ENRICHED_CONTENT.send).not.toHaveBeenCalled();
    });

    it('should handle errors during content processing', async () => {
      // Mock llmService to throw an error
      mockLlmService.processContent.mockRejectedValue(new Error('Processing error'));

      // Process the batch
      await expect(processor.queue(mockBatch)).resolves.not.toThrow();

      // Check that no message was published
      expect(mockEnv.ENRICHED_CONTENT.send).not.toHaveBeenCalled();
    });

    it('should process multiple messages in a batch', async () => {
      // Create a new batch with multiple messages
      mockBatch = {
        queue: 'new-content',
        retryAll: () => Promise.resolve(),
        ackAll: () => Promise.resolve(),
        messages: [
          {
            id: 'message-1',
            body: {
              id: 'content-1',
              userId: 'user-1',
              category: 'note',
              mimeType: 'text/plain',
              size: 100,
              createdAt: 1234567890,
            },
            timestamp: new Date(),
            attempts: 0,
            retry: () => Promise.resolve(),
            ack: () => Promise.resolve(),
          },
          {
            id: 'message-2',
            body: {
              id: 'content-2',
              userId: 'user-2',
              category: 'article',
              mimeType: 'text/markdown',
              size: 200,
              createdAt: 1234567890,
            },
            timestamp: new Date(),
            attempts: 0,
            retry: () => Promise.resolve(),
            ack: () => Promise.resolve(),
          },
        ],
      };

      // Process the batch
      await processor.queue(mockBatch);

      // Check that both messages were processed
      expect(mockSiloService.fetchContent).toHaveBeenCalledTimes(2);
      expect(mockSiloService.fetchContent).toHaveBeenCalledWith('content-1', 'user-1');
      expect(mockSiloService.fetchContent).toHaveBeenCalledWith('content-2', 'user-2');

      expect(mockLlmService.processContent).toHaveBeenCalledTimes(2);

      // Check that both messages were published
      expect(mockEnv.ENRICHED_CONTENT.send).toHaveBeenCalledTimes(2);
    });
  });
});
