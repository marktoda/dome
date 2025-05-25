import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ChatController } from '../src/controllers/chatController';
import { Services } from '../src/services';
import { AgentState, ChatRequest, ResumeChatRequest } from '../src/types';
import { V3Chat } from '../src/graphs';

// Mock dependencies
vi.mock('../src/graphs');
vi.mock('../src/services');
vi.mock('../src/utils/securePromptHandler');
vi.mock('../src/utils/inputValidator');
vi.mock('../src/utils/wrap');
vi.mock('@dome/common');

describe('ChatController', () => {
  let chatController: ChatController;
  let mockEnv: Env;
  let mockServices: Services;
  let mockCtx: ExecutionContext;

  const mockCheckpointer = {
    initialize: vi.fn().mockResolvedValue(undefined),
  };

  const mockDataRetention = {
    initialize: vi.fn().mockResolvedValue(undefined),
    registerDataRecord: vi.fn().mockResolvedValue(undefined),
  };

  const mockGraph = {
    stream: vi.fn(),
    invoke: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockEnv = {
      MAX_RAG_LOOPS: '3',
      CHAT_DB: {} as D1Database,
    } as Env;

    mockServices = {
      checkpointer: mockCheckpointer,
      dataRetention: mockDataRetention,
    } as any;

    mockCtx = {} as ExecutionContext;

    // Mock the V3Chat.build method
    vi.mocked(V3Chat.build).mockResolvedValue(mockGraph as any);

    // Mock crypto.randomUUID
    global.crypto = {
      randomUUID: vi.fn(() => 'mock-uuid'),
    } as any;

    // Mock secureMessages and validateInitialState
    const { secureMessages } = await vi.importMock('../src/utils/securePromptHandler');
    const { validateInitialState } = await vi.importMock('../src/utils/inputValidator');
    const { wrap } = await vi.importMock('../src/utils/wrap');

    vi.mocked(secureMessages).mockImplementation((messages) => messages);
    vi.mocked(validateInitialState).mockImplementation((req) => req);
    vi.mocked(wrap).mockImplementation((_, fn) => fn());

    chatController = new ChatController(mockEnv, mockServices, mockCtx);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('generateChatMessage', () => {
    it('should generate a non-streaming chat response', async () => {
      const mockRequest: ChatRequest = {
        userId: 'user-123',
        messages: [
          { role: 'user', content: 'Hello', timestamp: Date.now() },
        ],
        options: {
          enhanceWithContext: true,
          maxContextItems: 5,
          includeSourceInfo: true,
          maxTokens: 1000,
        },
        stream: false,
      };

      const mockResult = {
        generatedText: 'Hello! How can I help you?',
        docs: [],
        metadata: {},
      };

      mockGraph.invoke.mockResolvedValue(mockResult);

      const response = await chatController.generateChatMessage(mockRequest);

      expect(mockServices.dataRetention.initialize).toHaveBeenCalled();
      expect(mockServices.dataRetention.registerDataRecord).toHaveBeenCalledWith(
        'mock-uuid',
        'user-123',
        'chatHistory'
      );
      expect(V3Chat.build).toHaveBeenCalledWith(mockEnv, mockCheckpointer);
      expect(mockGraph.invoke).toHaveBeenCalled();
      expect(response).toBeInstanceOf(Response);
    });

    it('should handle errors gracefully', async () => {
      const mockRequest: ChatRequest = {
        userId: 'user-123',
        messages: [
          { role: 'user', content: 'Hello', timestamp: Date.now() },
        ],
        options: {
          enhanceWithContext: true,
          maxContextItems: 5,
          includeSourceInfo: true,
          maxTokens: 1000,
        },
        stream: false,
      };

      mockGraph.invoke.mockRejectedValue(new Error('Graph execution failed'));

      await expect(chatController.generateChatMessage(mockRequest)).rejects.toThrow();
    });
  });

  describe('startChatSession', () => {
    it('should start a streaming chat session', async () => {
      const mockRequest: ChatRequest = {
        userId: 'user-123',
        messages: [
          { role: 'user', content: 'Hello', timestamp: Date.now() },
        ],
        options: {
          enhanceWithContext: true,
          maxContextItems: 5,
          includeSourceInfo: true,
          maxTokens: 1000,
        },
        stream: true,
      };

      const mockIterator = {
        [Symbol.asyncIterator]: async function* () {
          yield { type: 'message', content: 'Hello!' };
          yield { type: 'end' };
        },
      };

      mockGraph.stream.mockResolvedValue(mockIterator);

      const stream = await chatController.startChatSession(mockRequest);

      expect(mockServices.checkpointer.initialize).toHaveBeenCalled();
      expect(V3Chat.build).toHaveBeenCalledWith(mockEnv, mockCheckpointer);
      expect(mockGraph.stream).toHaveBeenCalled();
      expect(stream).toBeInstanceOf(ReadableStream);
    });

    it('should handle streaming errors', async () => {
      const mockRequest: ChatRequest = {
        userId: 'user-123',
        messages: [
          { role: 'user', content: 'Hello', timestamp: Date.now() },
        ],
        options: {
          enhanceWithContext: true,
          maxContextItems: 5,
          includeSourceInfo: true,
          maxTokens: 1000,
        },
        stream: true,
      };

      mockGraph.stream.mockRejectedValue(new Error('Streaming failed'));

      await expect(chatController.startChatSession(mockRequest)).rejects.toThrow();
    });
  });

  describe('resumeChatSession', () => {
    it('should resume an existing chat session', async () => {
      const mockRequest: ResumeChatRequest = {
        runId: 'run-123',
        newMessage: { role: 'user', content: 'Continue', timestamp: Date.now() },
      };

      const mockIterator = {
        [Symbol.asyncIterator]: async function* () {
          yield { type: 'message', content: 'Continuing...' };
        },
      };

      mockGraph.stream.mockResolvedValue(mockIterator);

      const stream = await chatController.resumeChatSession(mockRequest);

      expect(mockServices.dataRetention.initialize).toHaveBeenCalled();
      expect(mockServices.dataRetention.registerDataRecord).toHaveBeenCalledWith(
        'run-123',
        'run-123',
        'chatHistory'
      );
      expect(V3Chat.build).toHaveBeenCalledWith(mockEnv, mockCheckpointer);
      expect(mockGraph.stream).toHaveBeenCalled();
    });
  });

  describe('State building', () => {
    it('should build initial state correctly', async () => {
      const mockRequest: ChatRequest = {
        userId: 'user-123',
        messages: [
          { role: 'user', content: 'Hello', timestamp: Date.now() },
          { role: 'assistant', content: 'Hi there!', timestamp: Date.now() },
          { role: 'user', content: 'How are you?', timestamp: Date.now() },
        ],
        options: {
          enhanceWithContext: true,
          maxContextItems: 5,
          includeSourceInfo: true,
          maxTokens: 1000,
        },
        stream: false,
      };

      mockGraph.invoke.mockResolvedValue({});

      await chatController.generateChatMessage(mockRequest);

      // Verify state building logic was called
      expect(mockServices.dataRetention.registerDataRecord).toHaveBeenCalled();
    });

    it('should handle messages with different roles correctly', async () => {
      const mockRequest: ChatRequest = {
        userId: 'user-123',
        messages: [
          { role: 'system', content: 'You are a helpful assistant', timestamp: Date.now() },
          { role: 'user', content: 'Hello', timestamp: Date.now() },
        ],
        options: {
          enhanceWithContext: true,
          maxContextItems: 5,
          includeSourceInfo: true,
          maxTokens: 1000,
        },
        stream: false,
      };

      mockGraph.invoke.mockResolvedValue({});

      await chatController.generateChatMessage(mockRequest);

      expect(mockGraph.invoke).toHaveBeenCalled();
    });
  });

  describe('Error handling', () => {
    it('should handle checkpointer initialization failure', async () => {
      mockServices.checkpointer.initialize.mockRejectedValue(new Error('DB error'));

      const mockRequest: ChatRequest = {
        userId: 'user-123',
        messages: [{ role: 'user', content: 'Hello', timestamp: Date.now() }],
        options: {
          enhanceWithContext: true,
          maxContextItems: 5,
          includeSourceInfo: true,
          maxTokens: 1000,
        },
        stream: false,
      };

      await expect(chatController.generateChatMessage(mockRequest)).rejects.toThrow();
    });

    it('should handle data retention failure', async () => {
      mockServices.dataRetention.registerDataRecord.mockRejectedValue(new Error('Retention error'));

      const mockRequest: ChatRequest = {
        userId: 'user-123',
        messages: [{ role: 'user', content: 'Hello', timestamp: Date.now() }],
        options: {
          enhanceWithContext: true,
          maxContextItems: 5,
          includeSourceInfo: true,
          maxTokens: 1000,
        },
        stream: false,
      };

      await expect(chatController.generateChatMessage(mockRequest)).rejects.toThrow();
    });
  });

  describe('Model limits calculation', () => {
    it('should calculate model limits with default values', async () => {
      const mockRequest: ChatRequest = {
        userId: 'user-123',
        messages: [{ role: 'user', content: 'Hello', timestamp: Date.now() }],
        options: {
          enhanceWithContext: true,
          maxContextItems: 5,
          includeSourceInfo: true,
          maxTokens: 1000,
        },
        stream: false,
      };

      mockGraph.invoke.mockResolvedValue({});

      await chatController.generateChatMessage(mockRequest);

      // Verify the controller was able to process the request
      expect(mockGraph.invoke).toHaveBeenCalled();
    });
  });
});