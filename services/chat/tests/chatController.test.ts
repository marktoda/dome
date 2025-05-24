import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChatController } from '../src/controllers/chatController';
import { Services } from '../src/services';

// Mock dependencies
vi.mock('@dome/common', () => ({
  getLogger: vi.fn().mockReturnValue({
    child: vi.fn().mockReturnValue({
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    }),
  }),
  metrics: {
    incrementCounter: vi.fn(),
    recordHistogram: vi.fn(),
  },
  withContext: vi.fn().mockImplementation((_, fn) => fn()),
  getModelConfig: vi.fn().mockReturnValue({}),
  calculateContextLimits: vi.fn().mockReturnValue({ maxTokens: 4000 }),
}));

vi.mock('../src/utils/errors', () => ({
  toDomeError: vi.fn().mockImplementation((err) => err),
}));

vi.mock('../src/utils/wrap', () => ({
  wrap: vi.fn().mockImplementation((_, fn) => fn()),
}));

vi.mock('../src/graphs', () => ({
  V3Chat: vi.fn().mockImplementation(() => ({
    invoke: vi.fn().mockResolvedValue({
      messages: [{ role: 'assistant', content: 'Test response' }],
    }),
    stream: vi.fn().mockResolvedValue({
      [Symbol.asyncIterator]: async function* () {
        yield { messages: [{ role: 'assistant', content: 'Test' }] };
      },
    }),
  })),
}));

describe('ChatController', () => {
  let chatController: ChatController;
  let mockEnv: any;
  let mockServices: Services;
  let mockCtx: ExecutionContext;

  beforeEach(() => {
    mockEnv = {
      OPENAI_API_KEY: 'test-key',
      ANTHROPIC_API_KEY: 'test-key',
    };

    mockServices = {
      llm: {
        generateResponse: vi.fn().mockResolvedValue('Test response'),
        generateStreamingResponse: vi.fn(),
      },
      search: {
        search: vi.fn().mockResolvedValue([]),
      },
      observability: {
        track: vi.fn(),
        recordMetric: vi.fn(),
      },
    } as any;

    mockCtx = {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
    } as any;

    chatController = new ChatController(mockEnv, mockServices, mockCtx);
    vi.clearAllMocks();
  });

  describe('initialization', () => {
    it('should create ChatController instance', () => {
      expect(chatController).toBeInstanceOf(ChatController);
    });
  });

  describe('generateChatMessage', () => {
    it('should generate non-streaming chat response', async () => {
      const chatRequest = {
        messages: [{ role: 'user', content: 'Hello' }],
        userId: 'test-user',
        sessionId: 'test-session',
      };

      const response = await chatController.generateChatMessage(chatRequest);
      
      expect(response).toBeInstanceOf(Response);
    });

    it('should handle invalid input', async () => {
      const invalidRequest = {
        messages: [], // Empty messages should be invalid
        userId: '',
      };

      await expect(chatController.generateChatMessage(invalidRequest as any))
        .rejects.toThrow();
    });

    it('should handle missing userId', async () => {
      const requestWithoutUserId = {
        messages: [{ role: 'user', content: 'Hello' }],
        sessionId: 'test-session',
      };

      await expect(chatController.generateChatMessage(requestWithoutUserId as any))
        .rejects.toThrow();
    });
  });

  describe('startChatSession', () => {
    it('should start streaming chat session', async () => {
      const chatRequest = {
        messages: [{ role: 'user', content: 'Hello' }],
        userId: 'test-user',
        sessionId: 'test-session',
      };

      const stream = await chatController.startChatSession(chatRequest);
      
      expect(stream).toBeInstanceOf(ReadableStream);
    });

    it('should handle streaming errors gracefully', async () => {
      // Mock graph to throw error
      const mockGraph = vi.fn().mockImplementation(() => ({
        stream: vi.fn().mockRejectedValue(new Error('Streaming error')),
      }));

      const chatRequest = {
        messages: [{ role: 'user', content: 'Hello' }],
        userId: 'test-user',
        sessionId: 'test-session',
      };

      await expect(chatController.startChatSession(chatRequest))
        .rejects.toThrow();
    });
  });

  describe('resumeChatSession', () => {
    it('should resume existing chat session', async () => {
      const resumeRequest = {
        checkpointId: 'test-checkpoint',
        message: { role: 'user', content: 'Continue' },
        userId: 'test-user',
        sessionId: 'test-session',
      };

      const stream = await chatController.resumeChatSession(resumeRequest);
      
      expect(stream).toBeInstanceOf(ReadableStream);
    });

    it('should handle invalid checkpoint ID', async () => {
      const resumeRequest = {
        checkpointId: 'invalid-checkpoint',
        message: { role: 'user', content: 'Continue' },
        userId: 'test-user',
        sessionId: 'test-session',
      };

      await expect(chatController.resumeChatSession(resumeRequest))
        .rejects.toThrow();
    });
  });

  describe('message validation', () => {
    it('should validate message content', async () => {
      const requestWithEmptyMessage = {
        messages: [{ role: 'user', content: '' }],
        userId: 'test-user',
        sessionId: 'test-session',
      };

      await expect(chatController.generateChatMessage(requestWithEmptyMessage))
        .rejects.toThrow();
    });

    it('should validate message roles', async () => {
      const requestWithInvalidRole = {
        messages: [{ role: 'invalid', content: 'Hello' }],
        userId: 'test-user',
        sessionId: 'test-session',
      };

      await expect(chatController.generateChatMessage(requestWithInvalidRole as any))
        .rejects.toThrow();
    });
  });
});