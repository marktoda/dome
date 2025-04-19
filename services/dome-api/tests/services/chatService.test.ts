import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { chatService } from '../../src/services/chatService';
import { searchService, PaginatedSearchResults } from '../../src/services/searchService';
import { ServiceError } from '@dome/common';

// Mock dependencies
vi.mock('../../src/services/searchService', () => ({
  searchService: {
    search: vi.fn(),
  },
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
  };

  // Mock search results
  const mockSearchResults: PaginatedSearchResults = {
    results: [
      {
        id: 'note1',
        title: 'Test Note 1',
        body: 'This is the content of test note 1.',
        score: 0.95,
        createdAt: 1650000000000,
        updatedAt: 1650000000000,
        contentType: 'text/plain',
      },
      {
        id: 'note2',
        title: 'Test Note 2',
        body: 'This is the content of test note 2.',
        score: 0.85,
        createdAt: 1650000100000,
        updatedAt: 1650000100000,
        contentType: 'text/plain',
      },
    ],
    pagination: {
      total: 2,
      limit: 10,
      offset: 0,
      hasMore: false
    },
    query: 'test query'
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('generateResponse', () => {
    it('should generate a response with context', async () => {
      // Mock search service to return test results
      vi.mocked(searchService.search).mockResolvedValue(mockSearchResults);

      // Mock AI response
      vi.mocked(mockEnv.AI.run).mockResolvedValue({
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

      // Verify search was called with correct parameters
      expect(searchService.search).toHaveBeenCalledWith(mockEnv, {
        userId: 'user123',
        query: 'What information do I have about test notes?',
        limit: 5,
      });

      // Verify AI was called with correct parameters
      expect(mockEnv.AI.run).toHaveBeenCalledWith('@cf/meta/llama-3-8b-instruct', {
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: 'system',
            content: expect.stringContaining("Here is relevant information from the user's notes"),
          }),
          expect.objectContaining({
            role: 'user',
            content: 'What information do I have about test notes?',
          }),
        ]),
      });

      // Verify response
      expect(response).toBe('This is a test response based on the provided context.');
    });

    it('should generate a response without context when enhanceWithContext is false', async () => {
      // Mock AI response
      vi.mocked(mockEnv.AI.run).mockResolvedValue({
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
      expect(searchService.search).not.toHaveBeenCalled();

      // Verify AI was called with correct parameters
      expect(mockEnv.AI.run).toHaveBeenCalledWith('@cf/meta/llama-3-8b-instruct', {
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: 'system',
            content: expect.not.stringContaining(
              "Here is relevant information from the user's notes",
            ),
          }),
          expect.objectContaining({
            role: 'user',
            content: 'What is the capital of France?',
          }),
        ]),
      });

      // Verify response
      expect(response).toBe('This is a test response without context.');
    });

    it('should suggest /add command when user is asking to remember something', async () => {
      // Mock search service to return empty results
      vi.mocked(searchService.search).mockResolvedValue({
        results: [],
        pagination: {
          total: 0,
          limit: 10,
          offset: 0,
          hasMore: false
        },
        query: 'test query'
      });

      // Mock AI response
      vi.mocked(mockEnv.AI.run).mockResolvedValue({
        response:
          "I'll help you remember that. You can use the /add command to save this information.",
      });

      // Test messages with a "remember" request
      const messages = [
        { role: 'user' as const, content: 'Remember that my meeting is at 3pm tomorrow.' },
      ];

      // Call the service
      const response = await chatService.generateResponse(mockEnv, {
        messages,
        userId: 'user123',
        enhanceWithContext: true,
        suggestAddCommand: true,
      });

      // Verify AI was called with system message containing /add suggestion
      expect(mockEnv.AI.run).toHaveBeenCalledWith('@cf/meta/llama-3-8b-instruct', {
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: 'system',
            content: expect.stringContaining('/add command'),
          }),
        ]),
      });

      // Verify response
      expect(response).toBe(
        "I'll help you remember that. You can use the /add command to save this information.",
      );
    });

    it('should throw an error when AI binding is not available', async () => {
      // Mock environment without AI binding
      const envWithoutAI = {
        D1_DATABASE: {} as D1Database,
        VECTORIZE: {} as VectorizeIndex,
        RAW: {} as R2Bucket,
        EVENTS: {} as Queue<any>,
        EMBED_QUEUE: {} as Queue<any>,
      };

      // Test messages
      const messages = [{ role: 'user' as const, content: 'Test message' }];

      // Expect error
      await expect(
        chatService.generateResponse(envWithoutAI, {
          messages,
          userId: 'user123',
        }),
      ).rejects.toThrow(ServiceError);
    });

    it('should throw an error when no user message is provided', async () => {
      // Test messages without user message
      const messages = [
        { role: 'system' as const, content: 'System message' },
        { role: 'assistant' as const, content: 'Assistant message' },
      ];

      // Expect error
      await expect(
        chatService.generateResponse(mockEnv, {
          messages,
          userId: 'user123',
        }),
      ).rejects.toThrow('At least one user message is required');
    });
  });

  describe('streamResponse', () => {
    it('should set up a streaming response', async () => {
      // Mock search service to return test results
      vi.mocked(searchService.search).mockResolvedValue(mockSearchResults);

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

      vi.mocked(mockEnv.AI.run).mockResolvedValue(mockStreamResponse);

      // Test messages
      const messages = [{ role: 'user' as const, content: 'Stream a response to me.' }];

      // Call the service
      const stream = await chatService.streamResponse(mockEnv, {
        messages,
        userId: 'user123',
      });

      // Verify we got a ReadableStream
      expect(stream).toBeInstanceOf(ReadableStream);

      // Verify search was called
      expect(searchService.search).toHaveBeenCalled();

      // Verify AI was called with streaming option
      expect(mockEnv.AI.run).toHaveBeenCalledWith('@cf/meta/llama-3-8b-instruct', {
        messages: expect.any(Array),
        stream: true,
      });
    });
  });
});
