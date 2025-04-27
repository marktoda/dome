import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ChatController } from '../../src/controllers/chatController';
import { Services } from '../../src/services';
import { getLogger, metrics } from '@dome/logging';

// Mock dependencies
vi.mock('@dome/logging', () => {
  // Create a mockLogger that can be reused
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(function() { return mockLogger; }),
  };

  return {
    getLogger: vi.fn(() => mockLogger),
    logError: vi.fn(),
    metrics: {
      increment: vi.fn(),
      timing: vi.fn(),
      gauge: vi.fn(),
      startTimer: vi.fn(() => ({ stop: vi.fn() })),
      trackOperation: vi.fn(),
    },
    withLogger: vi.fn((_, fn) => fn(mockLogger)),
    baseLogger: mockLogger,
    createLogger: vi.fn(() => mockLogger),
    createServiceMetrics: vi.fn(() => ({
      counter: vi.fn(),
      gauge: vi.fn(),
      timing: vi.fn(),
      startTimer: vi.fn(() => ({ stop: vi.fn() })),
      trackOperation: vi.fn(),
    })),
  };
});

vi.mock('../../src/graph', () => ({
  buildChatGraph: vi.fn(() => ({
    stream: vi.fn(
      () =>
        new ReadableStream({
          start(controller) {
            controller.enqueue({
              state: {
                metadata: { currentNode: 'test', isFinalState: true },
                generatedText: 'Test response',
                docs: [
                  {
                    id: 'doc1',
                    title: 'Test Document',
                    metadata: {
                      source: 'test',
                      url: 'https://example.com',
                      relevanceScore: 0.9,
                    },
                  },
                ],
              },
            });
            controller.close();
          },
        }),
    ),
  })),
}));

describe('ChatController', () => {
  let controller: ChatController;
  let mockEnv: Env;
  let mockServices: Services;

  beforeEach(() => {
    // Reset mocks
    vi.clearAllMocks();

    // Create mock environment
    mockEnv = {
      CHAT_DB: {} as any,
      AI: {} as any,
    } as Env;

    // Create mock services
    mockServices = {
      checkpointer: {
        initialize: vi.fn(),
        getState: vi.fn(),
        setState: vi.fn(),
        getStats: vi.fn(),
        cleanup: vi.fn(),
      },
      dataRetention: {
        initialize: vi.fn(),
        registerDataRecord: vi.fn(),
        getStats: vi.fn(),
        cleanupExpiredData: vi.fn(),
        deleteUserData: vi.fn(),
        recordConsent: vi.fn(),
      },
      llm: {
        call: vi.fn(),
        rewriteQuery: vi.fn(),
        analyzeQueryComplexity: vi.fn(),
        generateResponse: vi.fn(),
      },
      search: {},
      observability: {},
      toolRegistry: {},
    } as unknown as Services;

    // Create controller
    controller = new ChatController(mockEnv, mockServices);
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('generateChatResponse', () => {
    it('should generate a chat response with streaming', async () => {
      // Arrange
      const request = {
        initialState: {
          userId: 'test-user',
          messages: [{ role: 'user', content: 'Hello', timestamp: Date.now() }],
          enhanceWithContext: true,
          maxContextItems: 5,
          includeSourceInfo: true,
          maxTokens: 1000,
        },
        runId: 'test-run-id',
      };

      // Act
      const response = await controller.generateChatResponse(request);

      // Assert
      expect(response).toBeInstanceOf(Response);
      expect(response.headers.get('Content-Type')).toBe('text/event-stream');
      expect(mockServices.checkpointer.initialize).toHaveBeenCalled();
      expect(mockServices.dataRetention.initialize).toHaveBeenCalled();
      expect(mockServices.dataRetention.registerDataRecord).toHaveBeenCalledWith(
        'test-run-id',
        'test-user',
        'chatHistory',
      );
      expect(metrics.increment).toHaveBeenCalledWith('chat_orchestrator.chat.generated', 1);
    });

    it('should handle errors and return an error stream', async () => {
      // Arrange
      const request = {
        initialState: {
          userId: 'test-user',
          messages: [{ role: 'user', content: 'Hello', timestamp: Date.now() }],
        },
      };

      // Mock an error
      mockServices.checkpointer.initialize = vi.fn().mockRejectedValue(new Error('Test error'));

      // Act
      const response = await controller.generateChatResponse(request as any);

      // Assert
      expect(response).toBeInstanceOf(Response);
      expect(response.headers.get('Content-Type')).toBe('text/event-stream');
      expect(metrics.increment).toHaveBeenCalledWith('chat_orchestrator.chat.errors', 1, {
        errorType: 'Error',
      });
    });
  });

  describe('resumeChatSession', () => {
    it('should resume a chat session', async () => {
      // Arrange
      const request = {
        runId: 'test-run-id',
        newMessage: {
          role: 'user',
          content: 'Follow-up question',
          timestamp: Date.now(),
        },
      };

      // Act
      const response = await controller.resumeChatSession(request);

      // Assert
      expect(response).toBeInstanceOf(Response);
      expect(response.headers.get('Content-Type')).toBe('text/event-stream');
      expect(mockServices.checkpointer.initialize).toHaveBeenCalled();
      expect(metrics.increment).toHaveBeenCalledWith('chat_orchestrator.chat.resumed', 1);
    });

    it('should handle errors when resuming a chat session', async () => {
      // Arrange
      const request = {
        runId: 'test-run-id',
      };

      // Mock an error
      mockServices.checkpointer.initialize = vi.fn().mockRejectedValue(new Error('Test error'));

      // Act
      const response = await controller.resumeChatSession(request);

      // Assert
      expect(response).toBeInstanceOf(Response);
      expect(response.headers.get('Content-Type')).toBe('text/event-stream');
      expect(metrics.increment).toHaveBeenCalledWith('chat_orchestrator.chat.errors', 1, {
        errorType: 'Error',
        operation: 'resume',
      });
    });
  });
});
