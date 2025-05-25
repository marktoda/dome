import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ChatController } from '../src/controllers/chatController';
import { ChatRequest, ResumeChatRequest, AgentState } from '../src/types';
import { Services } from '../src/services';

// Mock all external dependencies
vi.mock('@dome/common', () => ({
  getLogger: () => ({
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  }),
  metrics: {
    increment: vi.fn(),
    gauge: vi.fn(),
    timing: vi.fn(),
  },
  withContext: vi.fn(async (ctx, fn) => await fn()),
  getModelConfig: vi.fn(() => ({
    id: 'gpt-4',
    contextWindow: 8192,
    maxResponseTokens: 1000,
  })),
  calculateContextLimits: vi.fn(() => ({
    maxContextTokens: 8192,
    maxResponseTokens: 1000,
    maxDocumentsTokens: 3276,
  })),
}));

vi.mock('../src/utils/errors', () => ({
  toDomeError: (e: any) => e,
}));

vi.mock('../src/utils/securePromptHandler', () => ({
  secureMessages: vi.fn((messages) => messages),
}));

vi.mock('../src/utils/inputValidator', () => ({
  validateInitialState: vi.fn((state) => state),
}));

vi.mock('../src/utils/wrap', () => ({
  wrap: vi.fn(async (ctx, fn) => await fn()),
}));

vi.mock('../src/graphs', () => ({
  V3Chat: {
    build: vi.fn(),
  },
}));

// Mock crypto.randomUUID
global.crypto = {
  randomUUID: vi.fn(() => 'test-uuid-123'),
} as any;

describe('ChatController', () => {
  let controller: ChatController;
  let mockEnv: any;
  let mockServices: Services;
  let mockCtx: ExecutionContext;

  const createMockChatRequest = (): ChatRequest => ({
    userId: 'test-user',
    messages: [
      {
        role: 'user',
        content: 'Hello, how can you help me?',
        timestamp: Date.now(),
      },
    ],
    options: {
      enhanceWithContext: true,
      maxContextItems: 5,
      includeSourceInfo: true,
      maxTokens: 1000,
    },
  });

  const createMockResumeChatRequest = (): ResumeChatRequest => ({
    runId: 'test-run-id',
    newMessage: {
      role: 'user',
      content: 'Continue our conversation',
      timestamp: Date.now(),
    },
  });

  beforeEach(() => {
    vi.clearAllMocks();

    mockEnv = {
      CHAT_DB: {},
      DOME_API: {},
      CONSTELLATION: {},
    };

    mockServices = {
      llm: {} as any,
      search: {} as any,
      observability: {} as any,
      modelFactory: {} as any,
      checkpointer: {
        initialize: vi.fn(),
      } as any,
      dataRetention: {
        initialize: vi.fn(),
        registerDataRecord: vi.fn(),
      } as any,
    };

    mockCtx = {} as ExecutionContext;

    controller = new ChatController(mockEnv, mockServices, mockCtx);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('generateChatMessage', () => {
    it('should generate a non-streaming chat response', async () => {
      const mockGraph = {
        invoke: vi.fn().mockResolvedValue({ generatedText: 'Test response' }),
      };
      const mockBuild = vi.mocked(require('../src/graphs').V3Chat.build);
      mockBuild.mockResolvedValue(mockGraph);

      const request = createMockChatRequest();
      const result = await controller.generateChatMessage(request);

      expect(result).toBeInstanceOf(Response);
      expect(mockServices.dataRetention.initialize).toHaveBeenCalled();
      expect(mockServices.dataRetention.registerDataRecord).toHaveBeenCalledWith(
        'test-uuid-123',
        'test-user',
        'chatHistory'
      );
      expect(mockServices.checkpointer.initialize).toHaveBeenCalled();
      expect(mockGraph.invoke).toHaveBeenCalled();
    });

    it('should handle invalid input gracefully', async () => {
      const invalidRequest = {
        userId: '', // Invalid empty userId
        messages: [],
      } as ChatRequest;

      // Mock Zod validation error
      const { chatRequestSchema } = require('../src/types');
      vi.spyOn(chatRequestSchema, 'parse').mockImplementation(() => {
        throw new Error('Validation failed');
      });

      await expect(controller.generateChatMessage(invalidRequest)).rejects.toThrow();
    });

    it('should secure messages before processing', async () => {
      const { secureMessages } = require('../src/utils/securePromptHandler');
      const mockGraph = {
        invoke: vi.fn().mockResolvedValue({ generatedText: 'Test response' }),
      };
      const mockBuild = vi.mocked(require('../src/graphs').V3Chat.build);
      mockBuild.mockResolvedValue(mockGraph);

      const request = createMockChatRequest();
      await controller.generateChatMessage(request);

      expect(secureMessages).toHaveBeenCalledWith(request.messages);
    });
  });

  describe('startChatSession', () => {
    it('should start a streaming chat session', async () => {
      const mockGraph = {
        stream: vi.fn().mockResolvedValue({
          [Symbol.asyncIterator]: async function* () {
            yield { type: 'message', content: 'chunk1' };
            yield { type: 'message', content: 'chunk2' };
          },
        }),
      };
      const mockBuild = vi.mocked(require('../src/graphs').V3Chat.build);
      mockBuild.mockResolvedValue(mockGraph);

      const request = createMockChatRequest();
      const result = await controller.startChatSession(request);

      expect(result).toBeInstanceOf(ReadableStream);
      expect(mockServices.checkpointer.initialize).toHaveBeenCalled();
      expect(mockGraph.stream).toHaveBeenCalled();
    });

    it('should build correct initial state for streaming', async () => {
      const mockGraph = {
        stream: vi.fn().mockResolvedValue({
          [Symbol.asyncIterator]: async function* () {
            yield { type: 'message', content: 'test' };
          },
        }),
      };
      const mockBuild = vi.mocked(require('../src/graphs').V3Chat.build);
      mockBuild.mockResolvedValue(mockGraph);

      const request = createMockChatRequest();
      await controller.startChatSession(request);

      const callArgs = mockGraph.stream.mock.calls[0];
      const state = callArgs[0] as AgentState;

      expect(state.userId).toBe('test-user');
      expect(state.messages).toHaveLength(1);
      expect(state.runId).toBe('test-uuid-123');
      expect(state.retrievalLoop).toEqual({
        attempt: 1,
        issuedQueries: [],
        refinedQueries: [],
        seenChunkIds: [],
      });
    });
  });

  describe('resumeChatSession', () => {
    it('should resume an existing chat session', async () => {
      const mockGraph = {
        stream: vi.fn().mockResolvedValue({
          [Symbol.asyncIterator]: async function* () {
            yield { type: 'resume', content: 'resumed' };
          },
        }),
      };
      const mockBuild = vi.mocked(require('../src/graphs').V3Chat.build);
      mockBuild.mockResolvedValue(mockGraph);

      const request = createMockResumeChatRequest();
      const result = await controller.resumeChatSession(request);

      expect(result).toBeDefined();
      expect(mockServices.dataRetention.registerDataRecord).toHaveBeenCalledWith(
        'test-run-id',
        'test-run-id',
        'chatHistory'
      );
    });

    it('should validate resume request schema', async () => {
      const { resumeChatRequestSchema } = require('../src/types');
      const parseSpy = vi.spyOn(resumeChatRequestSchema, 'parse');

      const mockGraph = {
        stream: vi.fn().mockResolvedValue({
          [Symbol.asyncIterator]: async function* () {
            yield { type: 'resume' };
          },
        }),
      };
      const mockBuild = vi.mocked(require('../src/graphs').V3Chat.build);
      mockBuild.mockResolvedValue(mockGraph);

      const request = createMockResumeChatRequest();
      await controller.resumeChatSession(request);

      expect(parseSpy).toHaveBeenCalledWith(request);
    });

    it('should handle resume without new message', async () => {
      const mockGraph = {
        stream: vi.fn().mockResolvedValue({
          [Symbol.asyncIterator]: async function* () {
            yield { type: 'resume' };
          },
        }),
      };
      const mockBuild = vi.mocked(require('../src/graphs').V3Chat.build);
      mockBuild.mockResolvedValue(mockGraph);

      const request: ResumeChatRequest = {
        runId: 'test-run-id',
        // No newMessage
      };

      await controller.resumeChatSession(request);

      const callArgs = mockGraph.stream.mock.calls[0];
      const state = callArgs[0] as AgentState;
      expect(state.messages).toEqual([]);
    });
  });

  describe('state building', () => {
    it('should create correct chat history from messages', async () => {
      const mockGraph = {
        invoke: vi.fn().mockResolvedValue({ result: 'test' }),
      };
      const mockBuild = vi.mocked(require('../src/graphs').V3Chat.build);
      mockBuild.mockResolvedValue(mockGraph);

      const request: ChatRequest = {
        userId: 'test-user',
        messages: [
          { role: 'user', content: 'Hello', timestamp: 1000 },
          { role: 'assistant', content: 'Hi there', timestamp: 2000 },
          { role: 'user', content: 'How are you?', timestamp: 3000 },
          { role: 'assistant', content: 'Good!', timestamp: 4000 },
        ],
        options: {
          enhanceWithContext: true,
          maxContextItems: 5,
          includeSourceInfo: true,
          maxTokens: 1000,
        },
      };

      await controller.generateChatMessage(request);

      const callArgs = mockGraph.invoke.mock.calls[0];
      const state = callArgs[0] as AgentState;

      expect(state.chatHistory).toHaveLength(2);
      expect(state.chatHistory[0].user.content).toBe('Hello');
      expect(state.chatHistory[0].assistant.content).toBe('Hi there');
      expect(state.chatHistory[1].user.content).toBe('How are you?');
      expect(state.chatHistory[1].assistant.content).toBe('Good!');
    });

    it('should handle unpaired messages correctly', async () => {
      const mockGraph = {
        invoke: vi.fn().mockResolvedValue({ result: 'test' }),
      };
      const mockBuild = vi.mocked(require('../src/graphs').V3Chat.build);
      mockBuild.mockResolvedValue(mockGraph);

      const request: ChatRequest = {
        userId: 'test-user',
        messages: [
          { role: 'user', content: 'Hello', timestamp: 1000 },
          { role: 'user', content: 'Another message', timestamp: 2000 }, // Unpaired
        ],
        options: {
          enhanceWithContext: true,
          maxContextItems: 5,
          includeSourceInfo: true,
          maxTokens: 1000,
        },
      };

      await controller.generateChatMessage(request);

      const callArgs = mockGraph.invoke.mock.calls[0];
      const state = callArgs[0] as AgentState;

      expect(state.chatHistory).toHaveLength(0); // No valid pairs
    });

    it('should set correct metadata with runId and startTime', async () => {
      const mockGraph = {
        invoke: vi.fn().mockResolvedValue({ result: 'test' }),
      };
      const mockBuild = vi.mocked(require('../src/graphs').V3Chat.build);
      mockBuild.mockResolvedValue(mockGraph);

      const request = createMockChatRequest();
      await controller.generateChatMessage(request);

      const callArgs = mockGraph.invoke.mock.calls[0];
      const state = callArgs[0] as AgentState;

      expect(state.metadata.runId).toBe('test-uuid-123');
      expect(state.metadata.startTime).toBeTypeOf('number');
    });
  });

  describe('error handling', () => {
    it('should handle graph build failures', async () => {
      const mockBuild = vi.mocked(require('../src/graphs').V3Chat.build);
      mockBuild.mockRejectedValue(new Error('Graph build failed'));

      const request = createMockChatRequest();

      await expect(controller.generateChatMessage(request)).rejects.toThrow('Graph build failed');
    });

    it('should handle service initialization failures', async () => {
      mockServices.dataRetention.initialize = vi.fn().mockRejectedValue(new Error('Init failed'));

      const request = createMockChatRequest();

      await expect(controller.generateChatMessage(request)).rejects.toThrow('Init failed');
    });
  });

  describe('metrics and observability', () => {
    it('should track streaming metrics', async () => {
      const { metrics } = require('@dome/common');
      const mockGraph = {
        stream: vi.fn().mockResolvedValue({
          [Symbol.asyncIterator]: async function* () {
            yield { type: 'message' };
          },
        }),
      };
      const mockBuild = vi.mocked(require('../src/graphs').V3Chat.build);
      mockBuild.mockResolvedValue(mockGraph);

      const request = createMockChatRequest();
      await controller.startChatSession(request);

      expect(metrics.increment).toHaveBeenCalledWith(
        'chat_orchestrator.chat.generated',
        1,
        { streaming: 'true' }
      );
    });

    it('should track non-streaming metrics', async () => {
      const { metrics } = require('@dome/common');
      const mockGraph = {
        invoke: vi.fn().mockResolvedValue({ result: 'test' }),
      };
      const mockBuild = vi.mocked(require('../src/graphs').V3Chat.build);
      mockBuild.mockResolvedValue(mockGraph);

      const request = createMockChatRequest();
      await controller.generateChatMessage(request);

      expect(metrics.increment).toHaveBeenCalledWith(
        'chat_orchestrator.chat.generated',
        1,
        { streaming: 'false' }
      );
    });
  });

  describe('configuration and limits', () => {
    it('should use provided model configuration', async () => {
      const { getModelConfig } = require('@dome/common');
      const mockGraph = {
        invoke: vi.fn().mockResolvedValue({ result: 'test' }),
      };
      const mockBuild = vi.mocked(require('../src/graphs').V3Chat.build);
      mockBuild.mockResolvedValue(mockGraph);

      const request: ChatRequest = {
        ...createMockChatRequest(),
        options: {
          ...createMockChatRequest().options,
          modelId: 'gpt-3.5-turbo',
        },
      };

      await controller.generateChatMessage(request);

      // The getModelConfig should be called when building state (indirectly through getModelLimits)
      expect(getModelConfig).toHaveBeenCalled();
    });

    it('should handle missing optional properties gracefully', async () => {
      const mockGraph = {
        invoke: vi.fn().mockResolvedValue({ result: 'test' }),
      };
      const mockBuild = vi.mocked(require('../src/graphs').V3Chat.build);
      mockBuild.mockResolvedValue(mockGraph);

      const request: ChatRequest = {
        userId: 'test-user',
        messages: [{ role: 'user', content: 'test' }],
        options: {
          enhanceWithContext: true,
          maxContextItems: 5,
          includeSourceInfo: true,
          maxTokens: 1000,
        },
      };

      // Should not throw
      await expect(controller.generateChatMessage(request)).resolves.toBeDefined();
    });
  });
});