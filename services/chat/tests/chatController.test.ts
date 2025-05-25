import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChatController } from '../src/controllers/chatController';
import { Services } from '../src/services';
import { AgentState, ChatRequest } from '../src/types';

// Mock all dependencies
vi.mock('@dome/common', () => ({
  getLogger: () => ({ 
    info: vi.fn(), 
    error: vi.fn(), 
    debug: vi.fn(), 
    warn: vi.fn(), 
    child: vi.fn().mockReturnThis() 
  }),
  metrics: {
    increment: vi.fn(),
  },
  withContext: async (_m: any, fn: any) => fn({}),
  getModelConfig: vi.fn(() => ({ 
    maxTokens: 4096, 
    contextWindow: 8192 
  })),
  calculateContextLimits: vi.fn(() => ({
    maxContextTokens: 6000,
    maxResponseTokens: 2000,
    maxDocumentsTokens: 2400,
  })),
}));

vi.mock('../src/utils/errors', () => ({
  toDomeError: (e: any) => e,
}));

vi.mock('../src/utils/securePromptHandler', () => ({
  secureMessages: vi.fn((messages) => messages),
}));

vi.mock('../src/utils/inputValidator', () => ({
  validateInitialState: vi.fn((req) => req),
}));

vi.mock('../src/utils/wrap', () => ({
  wrap: vi.fn(async (_, fn) => await fn()),
}));

vi.mock('../src/graphs', () => ({
  V3Chat: {
    build: vi.fn(),
  },
}));

describe('ChatController', () => {
  let controller: ChatController;
  let mockEnv: Env;
  let mockServices: Services;
  let mockCtx: ExecutionContext;
  let mockGraph: any;

  beforeEach(() => {
    mockEnv = {} as Env;
    mockCtx = {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext;

    mockServices = {
      dataRetention: {
        initialize: vi.fn(),
        registerDataRecord: vi.fn(),
      },
      checkpointer: {
        initialize: vi.fn(),
      },
    } as unknown as Services;

    mockGraph = {
      invoke: vi.fn(),
      stream: vi.fn(),
    };

    const { V3Chat } = require('../src/graphs');
    V3Chat.build.mockResolvedValue(mockGraph);

    controller = new ChatController(mockEnv, mockServices, mockCtx);
  });

  describe('generateChatMessage (non-streaming)', () => {
    it('should process a valid chat request and return response', async () => {
      const request: ChatRequest = {
        userId: 'user123',
        messages: [
          { role: 'user', content: 'Hello, how are you?' }
        ],
        options: {
          enhanceWithContext: true,
          maxContextItems: 5,
          includeSourceInfo: true,
          maxTokens: 1000,
        },
      };

      const mockResult = {
        generatedText: 'Hello! I am doing well, thank you.',
        docs: [],
        metadata: {},
      };

      mockGraph.invoke.mockResolvedValue(mockResult);

      const response = await controller.generateChatMessage(request);

      expect(response).toBeInstanceOf(Response);
      expect(mockServices.dataRetention.initialize).toHaveBeenCalled();
      expect(mockServices.dataRetention.registerDataRecord).toHaveBeenCalled();
      expect(mockServices.checkpointer.initialize).toHaveBeenCalled();
      expect(mockGraph.invoke).toHaveBeenCalled();

      const responseData = await response.json();
      expect(responseData).toEqual(mockResult);
    });

    it('should handle empty messages array', async () => {
      const request: ChatRequest = {
        userId: 'user123',
        messages: [],
        options: {
          enhanceWithContext: false,
          maxTokens: 500,
        },
      };

      mockGraph.invoke.mockResolvedValue({ 
        generatedText: 'How can I help you?',
        docs: [],
        metadata: {},
      });

      const response = await controller.generateChatMessage(request);

      expect(response).toBeInstanceOf(Response);
      expect(mockGraph.invoke).toHaveBeenCalled();
    });

    it('should use provided runId', async () => {
      const request: ChatRequest = {
        userId: 'user123',
        runId: 'existing-run-id',
        messages: [
          { role: 'user', content: 'Test message' }
        ],
        options: {},
      };

      mockGraph.invoke.mockResolvedValue({
        generatedText: 'Response',
        docs: [],
        metadata: {},
      });

      await controller.generateChatMessage(request);

      expect(mockServices.dataRetention.registerDataRecord).toHaveBeenCalledWith(
        'existing-run-id',
        'user123', 
        'chatHistory'
      );
    });
  });

  describe('startChatSession (streaming)', () => {
    it('should start streaming chat session', async () => {
      const request: ChatRequest = {
        userId: 'user123',
        messages: [
          { role: 'user', content: 'Start streaming chat' }
        ],
        options: {
          enhanceWithContext: true,
        },
      };

      const mockAsyncIterator = {
        async *[Symbol.asyncIterator]() {
          yield { type: 'message', content: 'Hello' };
          yield { type: 'message', content: ' world' };
        }
      };

      mockGraph.stream.mockResolvedValue(mockAsyncIterator);

      const stream = await controller.startChatSession(request);

      expect(stream).toBeInstanceOf(ReadableStream);
      expect(mockServices.dataRetention.initialize).toHaveBeenCalled();
      expect(mockServices.checkpointer.initialize).toHaveBeenCalled();
      expect(mockGraph.stream).toHaveBeenCalled();

      // Verify stream configuration
      const streamCall = mockGraph.stream.mock.calls[0];
      expect(streamCall[1]).toMatchObject({
        streamMode: ['messages', 'updates'],
      });
    });

    it('should generate unique thread_id for streaming', async () => {
      const request: ChatRequest = {
        userId: 'user456',
        messages: [
          { role: 'user', content: 'Test streaming' }
        ],
        options: {},
      };

      const mockAsyncIterator = {
        async *[Symbol.asyncIterator]() {
          yield { type: 'test' };
        }
      };

      mockGraph.stream.mockResolvedValue(mockAsyncIterator);

      await controller.startChatSession(request);

      const streamCall = mockGraph.stream.mock.calls[0];
      expect(streamCall[1].configurable).toHaveProperty('thread_id');
      expect(streamCall[1].configurable).toHaveProperty('runId');
      expect(typeof streamCall[1].configurable.thread_id).toBe('string');
    });
  });

  describe('state building', () => {
    it('should create proper base state with chat history', async () => {
      const request: ChatRequest = {
        userId: 'user123',
        messages: [
          { role: 'user', content: 'First message', timestamp: 1000 },
          { role: 'assistant', content: 'First response', timestamp: 1001 },
          { role: 'user', content: 'Second message', timestamp: 1002 },
        ],
        options: {
          enhanceWithContext: true,
          maxContextItems: 3,
        },
      };

      mockGraph.invoke.mockResolvedValue({
        generatedText: 'Response',
        docs: [],
        metadata: {},
      });

      await controller.generateChatMessage(request);

      const invokeCall = mockGraph.invoke.mock.calls[0];
      const state: AgentState = invokeCall[0];

      expect(state.userId).toBe('user123');
      expect(state.messages).toHaveLength(3);
      expect(state.chatHistory).toHaveLength(1); // One user-assistant pair
      expect(state.chatHistory[0]).toMatchObject({
        user: { role: 'user', content: 'First message' },
        assistant: { role: 'assistant', content: 'First response' },
        timestamp: 1001,
      });
      expect(state.options).toMatchObject({
        enhanceWithContext: true,
        maxContextItems: 3,
      });
      expect(state.retrievalLoop).toMatchObject({
        attempt: 1,
        issuedQueries: [],
        refinedQueries: [],
        seenChunkIds: [],
      });
    });

    it('should handle mixed message types in chat history', async () => {
      const request: ChatRequest = {
        userId: 'user123',
        messages: [
          { role: 'system', content: 'System message' },
          { role: 'user', content: 'User message 1' },
          { role: 'assistant', content: 'Assistant response 1' },
          { role: 'user', content: 'User message 2' },
        ],
        options: {},
      };

      mockGraph.invoke.mockResolvedValue({
        generatedText: 'Response',
        docs: [],
        metadata: {},
      });

      await controller.generateChatMessage(request);

      const invokeCall = mockGraph.invoke.mock.calls[0];
      const state: AgentState = invokeCall[0];

      // Should only create pairs from user-assistant consecutive messages
      expect(state.chatHistory).toHaveLength(1);
      expect(state.chatHistory[0].user.content).toBe('User message 1');
      expect(state.chatHistory[0].assistant.content).toBe('Assistant response 1');
    });
  });

  describe('model limits', () => {
    it('should apply default model limits when no modelId provided', async () => {
      const request: ChatRequest = {
        userId: 'user123',
        messages: [
          { role: 'user', content: 'Test limits' }
        ],
        options: {},
      };

      mockGraph.invoke.mockResolvedValue({
        generatedText: 'Response',
        docs: [],
        metadata: {},
      });

      await controller.generateChatMessage(request);

      const invokeCall = mockGraph.invoke.mock.calls[0];
      const state: AgentState = invokeCall[0];

      // Should use default max tokens from model limits
      expect(state.options?.maxTokens).toBe(2000); // from mocked calculateContextLimits
    });
  });
});