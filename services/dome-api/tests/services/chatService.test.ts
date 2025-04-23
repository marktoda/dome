import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ChatService } from '../../src/services/chatService';
import { SearchService } from '../../src/services/searchService';
import { ServiceError } from '@dome/common';

// Mock the SearchService class
vi.mock('../../src/services/searchService', () => {
  return {
    SearchService: vi.fn().mockImplementation(() => {
      return {
        search: vi.fn().mockResolvedValue({
          results: [],
          pagination: {
            total: 0,
            limit: 10,
            offset: 0,
            hasMore: false,
          },
          query: '',
        }),
      };
    }),
  };
});

// Mock the logging module
vi.mock('@dome/logging', () => ({
  getLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  }),
}));

describe('ChatService', () => {
  // Mock environment
  const mockEnv = {
    AI: {
      run: vi.fn(),
    },
    D1_DATABASE: {} as D1Database,
    VECTORIZE: {} as VectorizeIndex,
    RAW: {} as R2Bucket,
    EVENTS: {} as Queue<any>,
    EMBED_QUEUE: {} as Queue<any>,
    SILO_INGEST_QUEUE: {} as Queue<any>,
    CONSTELLATION: {} as any,
    SILO: {} as any,
  };

  // Mock search results
  const mockSearchResults = {
    results: [
      {
        id: 'note1',
        title: 'Test Note 1',
        summary: 'Summary of test note 1',
        body: 'This is the content of test note 1.',
        score: 0.95,
        createdAt: 1650000000000,
        updatedAt: 1650000000000,
        category: 'note',
        mimeType: 'text/plain',
      },
      {
        id: 'note2',
        title: 'Test Note 2',
        summary: 'Summary of test note 2',
        body: 'This is the content of test note 2.',
        score: 0.85,
        createdAt: 1650000100000,
        updatedAt: 1650000100000,
        category: 'note',
        mimeType: 'text/plain',
      },
    ],
    pagination: {
      total: 2,
      limit: 10,
      offset: 0,
      hasMore: false,
    },
    query: 'test query',
  };

  let mockSearchService: SearchService;
  let chatService: ChatService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchService = new SearchService(null as any, null as any);
    chatService = new ChatService(mockSearchService);

    // Set up the mock for search
    vi.mocked(mockSearchService.search).mockResolvedValue(mockSearchResults);
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('generateResponse', () => {
    it('should generate a response with context', async () => {
      // Mock AI response
      mockEnv.AI.run.mockResolvedValue({
        response: 'This is a test response based on the provided context.',
      });

      // Test messages
      const messages = [
        { role: 'user' as const, content: 'What information do I have about test notes?' },
      ];

      // Call the service
      const response = await chatService.generateResponse(mockEnv, {
        messages,
        userId: 'user123',
        enhanceWithContext: true,
        maxContextItems: 5,
      });

      // Verify search was called
      expect(mockSearchService.search).toHaveBeenCalled();

      // Verify AI was called with system message containing context
      expect(mockEnv.AI.run).toHaveBeenCalledWith(expect.any(String), {
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: 'system',
            content: expect.stringContaining('Here is relevant information'),
          }),
        ]),
      });

      // Verify response
      expect(response).toBe('This is a test response based on the provided context.');
    });

    it('should generate a response without context when enhanceWithContext is false', async () => {
      // Mock AI response
      mockEnv.AI.run.mockResolvedValue({
        response: 'This is a test response without context.',
      });

      // Test messages
      const messages = [{ role: 'user' as const, content: 'What is the capital of France?' }];

      // Call the service
      const response = await chatService.generateResponse(mockEnv, {
        messages,
        userId: 'user123',
        enhanceWithContext: false,
      });

      // Verify search was not called
      expect(mockSearchService.search).not.toHaveBeenCalled();

      // Verify response
      expect(response).toBe('This is a test response without context.');
    });

    it('should return a mock response in test environment when AI binding is not available', async () => {
      // Set NODE_ENV to test
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'test';

      // Mock environment without AI binding
      const envWithoutAI = {
        D1_DATABASE: {} as D1Database,
        VECTORIZE: {} as VectorizeIndex,
        RAW: {} as R2Bucket,
        EVENTS: {} as Queue<any>,
        EMBED_QUEUE: {} as Queue<any>,
        SILO_INGEST_QUEUE: {} as Queue<any>,
        CONSTELLATION: {} as any,
        SILO: {} as any,
      };

      // Test messages
      const messages = [{ role: 'user' as const, content: 'Test message' }];

      try {
        // Call the service
        const response = await chatService.generateResponse(envWithoutAI, {
          messages,
          userId: 'user123',
        });

        // Verify we get a mock response
        expect(response).toBe('This is a mock response for testing purposes.');
      } finally {
        // Restore original NODE_ENV
        process.env.NODE_ENV = originalEnv;
      }
    });
  });

  describe('streamResponse', () => {
    it('should set up a streaming response', async () => {
      // Mock AI streaming response
      const mockStreamResponse = {
        [Symbol.asyncIterator]: () => {
          let count = 0;
          return {
            next: () => {
              if (count < 3) {
                count++;
                return Promise.resolve({
                  value: { response: `Chunk ${count}` },
                  done: false,
                });
              }
              return Promise.resolve({ done: true });
            },
          };
        },
      };

      mockEnv.AI.run.mockResolvedValue(mockStreamResponse);

      // Test messages
      const messages = [{ role: 'user' as const, content: 'Stream a response to me.' }];

      // Call the service
      const stream = await chatService.streamResponse(mockEnv, {
        messages,
        userId: 'user123',
      });

      // Verify we got a ReadableStream
      expect(stream).toBeInstanceOf(ReadableStream);

      // Verify AI was called with streaming option
      expect(mockEnv.AI.run).toHaveBeenCalledWith(expect.any(String), {
        messages: expect.any(Array),
        stream: true,
      });
    });
  });
});
