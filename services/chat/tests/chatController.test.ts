import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChatController } from '../src/controllers/chatController';
import { ChatRequest } from '../src/types';

// Mock dependencies
vi.mock('../src/services', () => ({
  Services: {}
}));

vi.mock('../src/graphs', () => ({
  V3Chat: {
    build: vi.fn().mockResolvedValue({
      stream: vi.fn().mockResolvedValue(async function* () {
        yield { type: 'message', content: 'test response' };
      }),
      invoke: vi.fn().mockResolvedValue({
        messages: [{ role: 'assistant', content: 'test response' }]
      })
    })
  }
}));

vi.mock('../src/utils/wrap', () => ({
  wrap: vi.fn().mockImplementation((_config, fn) => fn())
}));

vi.mock('@dome/common', () => ({
  getLogger: () => ({
    child: () => ({
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn()
    })
  }),
  metrics: {
    increment: vi.fn()
  },
  withContext: vi.fn().mockImplementation((_context, fn) => fn()),
  getModelConfig: vi.fn().mockReturnValue({
    maxContextTokens: 8192,
    maxResponseTokens: 1000
  }),
  calculateContextLimits: vi.fn().mockReturnValue({
    maxContextTokens: 8192,
    maxResponseTokens: 1000,
    maxDocumentsTokens: 3000
  })
}));

vi.mock('../src/utils/errors', () => ({
  toDomeError: vi.fn().mockImplementation((err) => err)
}));

vi.mock('../src/utils/securePromptHandler', () => ({
  secureMessages: vi.fn().mockImplementation((messages) => messages)
}));

vi.mock('../src/utils/inputValidator', () => ({
  validateInitialState: vi.fn().mockImplementation((req) => req)
}));

describe('ChatController', () => {
  let controller: ChatController;
  let mockEnv: any;
  let mockServices: any;
  let mockCtx: any;

  beforeEach(() => {
    mockEnv = {};
    mockServices = {
      dataRetention: {
        initialize: vi.fn().mockResolvedValue(undefined),
        registerDataRecord: vi.fn().mockResolvedValue(undefined)
      },
      checkpointer: {
        initialize: vi.fn().mockResolvedValue(undefined)
      }
    };
    mockCtx = {};

    controller = new ChatController(mockEnv, mockServices, mockCtx);
  });

  describe('generateChatMessage', () => {
    it('should generate a non-streaming chat response', async () => {
      const request: ChatRequest = {
        userId: 'test-user',
        messages: [
          { role: 'user', content: 'Hello', timestamp: Date.now() }
        ],
        options: {
          enhanceWithContext: true,
          maxContextItems: 5,
          includeSourceInfo: true,
          maxTokens: 1000
        }
      };

      const response = await controller.generateChatMessage(request);
      
      expect(response).toBeInstanceOf(Response);
      expect(mockServices.dataRetention.initialize).toHaveBeenCalled();
      expect(mockServices.dataRetention.registerDataRecord).toHaveBeenCalled();
    });

    it('should handle invalid request format', async () => {
      const invalidRequest = {
        // Missing required userId field
        messages: [
          { role: 'user', content: 'Hello' }
        ]
      } as ChatRequest;

      await expect(controller.generateChatMessage(invalidRequest))
        .rejects.toThrow();
    });
  });

  describe('startChatSession', () => {
    it('should start a streaming chat session', async () => {
      const request: ChatRequest = {
        userId: 'test-user',
        messages: [
          { role: 'user', content: 'Hello', timestamp: Date.now() }
        ],
        options: {
          enhanceWithContext: true,
          maxContextItems: 5,
          includeSourceInfo: true,
          maxTokens: 1000
        }
      };

      const stream = await controller.startChatSession(request);
      
      expect(stream).toBeInstanceOf(ReadableStream);
      expect(mockServices.checkpointer.initialize).toHaveBeenCalled();
    });
  });

  describe('resumeChatSession', () => {
    it('should resume an existing chat session', async () => {
      const resumeRequest = {
        runId: 'test-run-id',
        newMessage: {
          role: 'user' as const,
          content: 'Continue conversation',
          timestamp: Date.now()
        }
      };

      const stream = await controller.resumeChatSession(resumeRequest);
      
      expect(stream).toBeDefined();
      expect(mockServices.dataRetention.initialize).toHaveBeenCalled();
    });

    it('should handle resume without new message', async () => {
      const resumeRequest = {
        runId: 'test-run-id'
      };

      const stream = await controller.resumeChatSession(resumeRequest);
      
      expect(stream).toBeDefined();
    });
  });

  describe('state building', () => {
    it('should build initial state correctly', async () => {
      const request: ChatRequest = {
        userId: 'test-user',
        messages: [
          { role: 'user', content: 'Hello', timestamp: Date.now() },
          { role: 'assistant', content: 'Hi there!', timestamp: Date.now() + 1000 }
        ],
        options: {
          enhanceWithContext: true,
          maxContextItems: 5,
          includeSourceInfo: true,
          maxTokens: 1000
        },
        runId: 'test-run-id'
      };

      // Access private method through type assertion for testing
      const state = await (controller as any).buildInitialState(request);
      
      expect(state.userId).toBe('test-user');
      expect(state.messages).toHaveLength(2);
      expect(state.chatHistory).toHaveLength(1); // One user-assistant pair
      expect(state.runId).toBe('test-run-id');
      expect(state.retrievalLoop).toBeDefined();
      expect(state.metadata.startTime).toBeDefined();
    });

    it('should handle messages without creating incomplete pairs', async () => {
      const request: ChatRequest = {
        userId: 'test-user',
        messages: [
          { role: 'user', content: 'Hello', timestamp: Date.now() },
          { role: 'user', content: 'Another message', timestamp: Date.now() + 1000 }
        ],
        options: {
          enhanceWithContext: true,
          maxContextItems: 5,
          includeSourceInfo: true,
          maxTokens: 1000
        }
      };

      const state = await (controller as any).buildInitialState(request);
      
      expect(state.chatHistory).toHaveLength(0); // No complete pairs
      expect(state.messages).toHaveLength(2);
    });
  });
});