import { vi } from 'vitest';
import { ChatService } from '../../src/services/chatService';
import { SearchService } from '../../src/services/searchService';
import { LlmClient } from '../../src/services/llmClient';
import { PromptBuilder } from '../../src/services/promptBuilder';

// Mock the SearchService
export const mockSearchService = {
  search: vi.fn().mockResolvedValue({
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
  }),
};

// Mock the LlmClient
vi.mock('../../src/services/llmClient', () => {
  return {
    LlmClient: {
      call: vi.fn().mockResolvedValue('This is a mock response'),
      callStream: vi.fn().mockResolvedValue(
        new Response('This is a mock streaming response', {
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        })
      ),
      fallbackResponse: vi.fn().mockReturnValue('Fallback response'),
      createFallbackResponse: vi.fn().mockReturnValue(
        new Response('Fallback response', {
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        })
      ),
    },
    MODEL: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  };
});

// Mock the PromptBuilder
vi.mock('../../src/services/promptBuilder', () => {
  return {
    PromptBuilder: {
      build: vi.fn().mockReturnValue('You are an AI assistant with access to the user\'s personal knowledge base.'),
      countTokens: vi.fn().mockReturnValue(100),
      truncateToTokenLimit: vi.fn().mockImplementation((text) => text),
      formatContextForPrompt: vi.fn().mockReturnValue('[1] Test Note 1\nThis is the content of test note 1.'),
      createSystemPrompt: vi.fn().mockReturnValue('You are an AI assistant with access to the user\'s personal knowledge base.'),
    },
  };
});

// Mock the ChatService
export const mockChatService = {
  generateResponse: vi.fn().mockResolvedValue('This is a test response'),
  streamResponse: vi.fn().mockResolvedValue(
    new Response('This is a test streaming response', {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    })
  ),
};

// Mock the logging module
vi.mock('@dome/logging', () => ({
  getLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  }),
  logError: vi.fn(),
}));

// Mock environment
export const mockEnv = {
  AI: {
    run: vi.fn().mockImplementation((model, options) => {
      if (options.stream) {
        return Promise.resolve(new ReadableStream({
          start(controller) {
            controller.enqueue('This is a test stream response');
            controller.close();
          },
        }));
      }
      return Promise.resolve({ response: 'This is a test response' });
    }),
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