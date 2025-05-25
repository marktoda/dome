import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ChatController } from '../src/controllers/chatController';
import { ChatRequest, ResumeChatRequest } from '../src/types';

// Mock all dependencies following the constellation pattern
vi.mock('@dome/common', () => ({
  getLogger: () => ({
    child: () => ({
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  }),
  metrics: {
    increment: vi.fn(),
  },
  withContext: async (_m: any, fn: any) => fn({}),
  getModelConfig: vi.fn(() => ({
    id: 'gpt-4-turbo',
    maxContextTokens: 8000,
    defaultTemperature: 0.3,
  })),
  calculateContextLimits: vi.fn(() => ({
    maxContextTokens: 8000,
    maxResponseTokens: 1000,
    maxDocumentsTokens: 3200,
  })),
}));

vi.mock('../src/utils/errors', () => ({
  toDomeError: (e: any) => e,
}));

vi.mock('@dome/common/errors', () => ({
  ValidationError: class extends Error {},
}));

vi.mock('../src/utils/securePromptHandler', () => ({
  secureMessages: vi.fn((messages) => messages),
}));

vi.mock('../src/utils/inputValidator', () => ({
  validateInitialState: vi.fn((parsed) => parsed),
}));

vi.mock('../src/utils/wrap', () => ({
  wrap: vi.fn(async (context, fn) => fn()),
}));

vi.mock('../src/graphs', () => ({
  V3Chat: {
    build: vi.fn(),
  },
}));

// Create mock services
const mockServices = {
  dataRetention: {
    initialize: vi.fn(),
    registerDataRecord: vi.fn(),
  },
  checkpointer: {
    initialize: vi.fn(),
  },
};

const mockEnv = {
  CHAT_DB: {},
  OPENAI_API_KEY: 'test-key',
} as Env;

const mockCtx = {} as ExecutionContext;

describe('ChatController', () => {
  let controller: ChatController;
  let mockGraph: any;

  beforeEach(() => {
    // Reset all mocks
    vi.clearAllMocks();
    
    // Create mock graph
    mockGraph = {
      stream: vi.fn(),
      invoke: vi.fn(),
    };

    // Setup V3Chat mock
    const { V3Chat } = require('../src/graphs');
    V3Chat.build.mockResolvedValue(mockGraph);

    controller = new ChatController(mockEnv, mockServices as any, mockCtx);
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('generateChatMessage', () => {
    it('should generate a non-streaming chat message successfully', async () => {
      const mockRequest: ChatRequest = {
        userId: 'test-user',
        messages: [
          { role: 'user', content: 'Hello, world!', timestamp: Date.now() },
        ],
        options: {
          enhanceWithContext: true,
          maxContextItems: 5,
          includeSourceInfo: true,
          maxTokens: 1000,
        },
      };

      const mockResult = { generatedText: 'Hello! How can I help you?' };
      mockGraph.invoke.mockResolvedValue(mockResult);

      const response = await controller.generateChatMessage(mockRequest);

      expect(mockServices.dataRetention.initialize).toHaveBeenCalled();
      expect(mockServices.dataRetention.registerDataRecord).toHaveBeenCalled();
      expect(mockServices.checkpointer.initialize).toHaveBeenCalled();
      expect(mockGraph.invoke).toHaveBeenCalled();
      expect(response).toBeInstanceOf(Response);
    });

    it('should handle validation errors', async () => {
      const invalidRequest = {
        userId: '', // Invalid: empty userId
        messages: [],
        options: {},
      } as ChatRequest;

      await expect(controller.generateChatMessage(invalidRequest)).rejects.toThrow();
    });

    it('should generate runId when not provided', async () => {
      const mockRequest: ChatRequest = {
        userId: 'test-user',
        messages: [{ role: 'user', content: 'Test' }],
        options: {},
        // runId not provided
      };

      mockGraph.invoke.mockResolvedValue({ generatedText: 'Response' });

      await controller.generateChatMessage(mockRequest);

      // Should register data record with generated runId
      expect(mockServices.dataRetention.registerDataRecord).toHaveBeenCalledWith(
        expect.stringMatching(/^[0-9a-f-]+$/), // UUID pattern
        'test-user',
        'chatHistory'
      );
    });
  });

  describe('startChatSession', () => {
    it('should start a streaming chat session successfully', async () => {
      const mockRequest: ChatRequest = {
        userId: 'test-user',
        messages: [{ role: 'user', content: 'Start streaming' }],
        options: {},
      };

      const mockStream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"chunk": "Hello"}'));
          controller.close();
        },
      });

      mockGraph.stream.mockReturnValue(async function* () {
        yield { chunk: 'Hello' };
      }());

      const result = await controller.startChatSession(mockRequest);

      expect(result).toBeInstanceOf(ReadableStream);
      expect(mockServices.checkpointer.initialize).toHaveBeenCalled();
      expect(mockGraph.stream).toHaveBeenCalled();
    });

    it('should handle streaming errors gracefully', async () => {
      const mockRequest: ChatRequest = {
        userId: 'test-user',
        messages: [{ role: 'user', content: 'Test error' }],
        options: {},
      };

      mockGraph.stream.mockRejectedValue(new Error('Streaming failed'));

      await expect(controller.startChatSession(mockRequest)).rejects.toThrow();
    });
  });

  describe('resumeChatSession', () => {
    it('should resume a chat session successfully', async () => {
      const mockRequest: ResumeChatRequest = {
        runId: 'existing-run-id',
        newMessage: { role: 'user', content: 'Continue conversation' },
      };

      mockGraph.stream.mockReturnValue(async function* () {
        yield { chunk: 'Resumed' };
      }());

      const result = await controller.resumeChatSession(mockRequest);

      expect(mockServices.dataRetention.initialize).toHaveBeenCalled();
      expect(mockServices.dataRetention.registerDataRecord).toHaveBeenCalledWith(
        'existing-run-id',
        'existing-run-id', // runId doubles as userId for resume
        'chatHistory'
      );
      expect(result).toBeDefined();
    });

    it('should handle resume without new message', async () => {
      const mockRequest: ResumeChatRequest = {
        runId: 'existing-run-id',
        // newMessage not provided
      };

      mockGraph.stream.mockReturnValue(async function* () {
        yield { chunk: 'Resumed without new message' };
      }());

      const result = await controller.resumeChatSession(mockRequest);

      expect(result).toBeDefined();
      expect(mockServices.dataRetention.registerDataRecord).toHaveBeenCalled();
    });

    it('should validate resume request schema', async () => {
      const invalidRequest = {
        // runId missing
        newMessage: { role: 'user', content: 'Test' },
      } as ResumeChatRequest;

      await expect(controller.resumeChatSession(invalidRequest)).rejects.toThrow();
    });
  });

  describe('state building', () => {
    it('should build initial state with proper message pairing', async () => {
      const mockRequest: ChatRequest = {
        userId: 'test-user',
        messages: [
          { role: 'user', content: 'First question', timestamp: 1000 },
          { role: 'assistant', content: 'First answer', timestamp: 1001 },
          { role: 'user', content: 'Second question', timestamp: 1002 },
        ],
        options: {
          enhanceWithContext: true,
          maxContextItems: 5,
        },
      };

      mockGraph.invoke.mockResolvedValue({ generatedText: 'Response' });

      await controller.generateChatMessage(mockRequest);

      // Verify that the graph was called with properly structured state
      expect(mockGraph.invoke).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'test-user',
          messages: expect.arrayContaining([
            expect.objectContaining({ role: 'user', content: 'First question' }),
            expect.objectContaining({ role: 'assistant', content: 'First answer' }),
            expect.objectContaining({ role: 'user', content: 'Second question' }),
          ]),
          chatHistory: expect.arrayContaining([
            expect.objectContaining({
              user: expect.objectContaining({ content: 'First question' }),
              assistant: expect.objectContaining({ content: 'First answer' }),
            }),
          ]),
          retrievalLoop: expect.objectContaining({
            attempt: 1,
            issuedQueries: [],
            refinedQueries: [],
            seenChunkIds: [],
          }),
        }),
        expect.objectContaining({
          configurable: expect.objectContaining({
            thread_id: expect.stringMatching(/^[0-9a-f-]+$/),
            runId: expect.stringMatching(/^[0-9a-f-]+$/),
          }),
        })
      );
    });

    it('should handle empty chat history correctly', async () => {
      const mockRequest: ChatRequest = {
        userId: 'test-user',
        messages: [{ role: 'user', content: 'Single message' }],
        options: {},
      };

      mockGraph.invoke.mockResolvedValue({ generatedText: 'Response' });

      await controller.generateChatMessage(mockRequest);

      expect(mockGraph.invoke).toHaveBeenCalledWith(
        expect.objectContaining({
          chatHistory: [], // Should be empty for single message
        }),
        expect.any(Object)
      );
    });

    it('should apply security measures to messages', async () => {
      const mockRequest: ChatRequest = {
        userId: 'test-user',
        messages: [{ role: 'user', content: 'Potentially unsafe content' }],
        options: {},
      };

      const { secureMessages } = require('../src/utils/securePromptHandler');
      secureMessages.mockReturnValue([{ role: 'user', content: 'Secured content' }]);

      mockGraph.invoke.mockResolvedValue({ generatedText: 'Response' });

      await controller.generateChatMessage(mockRequest);

      expect(secureMessages).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ content: 'Potentially unsafe content' }),
        ])
      );
    });
  });

  describe('error handling', () => {
    it('should handle graph build failures', async () => {
      const mockRequest: ChatRequest = {
        userId: 'test-user',
        messages: [{ role: 'user', content: 'Test' }],
        options: {},
      };

      const { V3Chat } = require('../src/graphs');
      V3Chat.build.mockRejectedValue(new Error('Graph build failed'));

      await expect(controller.generateChatMessage(mockRequest)).rejects.toThrow();
    });

    it('should handle data retention failures', async () => {
      const mockRequest: ChatRequest = {
        userId: 'test-user',
        messages: [{ role: 'user', content: 'Test' }],
        options: {},
      };

      mockServices.dataRetention.registerDataRecord.mockRejectedValue(
        new Error('Data retention failed')
      );

      await expect(controller.generateChatMessage(mockRequest)).rejects.toThrow();
    });
  });

  describe('model configuration', () => {
    it('should use provided model limits correctly', async () => {
      const { getModelConfig, calculateContextLimits } = require('@dome/common');
      
      getModelConfig.mockReturnValue({
        id: 'custom-model',
        maxContextTokens: 16000,
        defaultTemperature: 0.7,
      });

      calculateContextLimits.mockReturnValue({
        maxContextTokens: 16000,
        maxResponseTokens: 2000,
        maxDocumentsTokens: 6400,
      });

      const mockRequest: ChatRequest = {
        userId: 'test-user',
        messages: [{ role: 'user', content: 'Test with custom model' }],
        options: {
          modelId: 'custom-model',
        },
      };

      mockGraph.invoke.mockResolvedValue({ generatedText: 'Response' });

      await controller.generateChatMessage(mockRequest);

      expect(getModelConfig).toHaveBeenCalledWith('custom-model');
      expect(calculateContextLimits).toHaveBeenCalled();
    });
  });
});