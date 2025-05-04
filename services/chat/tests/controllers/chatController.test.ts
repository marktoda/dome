import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ChatController } from '../../src/controllers/chatController';
import { Services } from '../../src/services';
import { getLogger, metrics, withContext } from '@dome/common';

// Create a mockLogger that can be reused
const mockLogger: {
  info: any;
  warn: any;
  error: any;
  debug: any;
  child: any;
} = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(() => mockLogger),
};

// Mock dependencies
vi.mock('@dome/common', () => {
  return {
    withContext: vi.fn((meta, fn) => fn(mockLogger)),
    getLogger: vi.fn(() => mockLogger),
    logError: vi.fn(),
    metrics: {
      increment: vi.fn(),
      timing: vi.fn(),
      gauge: vi.fn(),
      startTimer: vi.fn(() => ({ stop: vi.fn() })),
      trackOperation: vi.fn(),
    },
    baseLogger: mockLogger,
    createLogger: vi.fn(() => mockLogger),
    createServiceMetrics: vi.fn(() => ({
      counter: vi.fn(),
      gauge: vi.fn(),
      timing: vi.fn(),
      startTimer: vi.fn(() => ({ stop: vi.fn() })),
      trackOperation: vi.fn(),
    })),
    createServiceWrapper: vi.fn((serviceName) => {
      return async (meta: Record<string, unknown>, fn: () => Promise<any>) => {
        return withContext(
          { ...meta, service: serviceName },
          async () => {
            try {
              return await fn();
            } catch (error) {
              mockLogger.error({ err: error }, 'Unhandled error');
              throw error;
            }
          }
        );
      };
    }),
    createServiceErrorHandler: vi.fn((serviceName) => {
      return (error: any, message?: string, details?: Record<string, any>) => {
        return {
          message: message || (error instanceof Error ? error.message : 'Unknown error'),
          code: error.code || 'ERROR',
          details: { ...(error.details || {}), ...(details || {}), service: serviceName },
          statusCode: error.statusCode || 500,
        };
      };
    }),
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

    // Create mock environment with all required properties
    mockEnv = {
      CHAT_DB: {} as any,
      AI: {} as any,
      LOG_LEVEL: 'info',
      VERSION: '1.0.0',
      ENVIRONMENT: 'test',
      SILO: {} as any,
      VECTORIZE: {} as any,
      ENRICHED_CONTENT: {} as any,
      TODOS: {} as any,
    } as unknown as Env;

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

    // Create controller with execution context
    const mockExecutionContext = {} as ExecutionContext;
    controller = new ChatController(mockEnv, mockServices, mockExecutionContext);
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('startChatSession', () => {
    it('should start a chat session with streaming', async () => {
      // Arrange
      const request = {
        stream: true,
        userId: 'test-user',
        messages: [{ role: 'user' as const, content: 'Hello', timestamp: Date.now() }],
        options: {
          enhanceWithContext: true,
          maxContextItems: 5,
          includeSourceInfo: true,
          maxTokens: 1000,
        },
        runId: 'test-run-id',
      };

      // Act
      const stream = await controller.startChatSession(request);

      // Assert
      expect(stream).toBeInstanceOf(ReadableStream);
      expect(mockServices.checkpointer.initialize).toHaveBeenCalled();
      expect(mockServices.dataRetention.initialize).toHaveBeenCalled();
      expect(mockServices.dataRetention.registerDataRecord).toHaveBeenCalledWith(
        'test-run-id',
        'test-user',
        'chatHistory',
      );
      expect(metrics.increment).toHaveBeenCalledWith('chat_orchestrator.chat.generated', 1, { streaming: 'true' });
    });

    it('should handle errors during chat session start', async () => {
      // Arrange
      const request = {
        stream: true,
        userId: 'test-user',
        messages: [{ role: 'user' as const, content: 'Hello', timestamp: Date.now() }],
        options: {
          enhanceWithContext: true,
          maxContextItems: 5,
          includeSourceInfo: true,
          maxTokens: 1000,
        },
      };

      // Mock an error
      mockServices.checkpointer.initialize = vi.fn().mockRejectedValue(new Error('Test error'));

      // Act & Assert
      await expect(controller.startChatSession(request)).rejects.toThrow('Test error');
      // Verify error metrics
      expect(metrics.increment).toHaveBeenCalledWith('chat_orchestrator.chat.errors', 1,
        expect.objectContaining({ errorType: 'Error' })
      );
    });
  });

  describe('resumeChatSession', () => {
    it('should resume a chat session', async () => {
      // Arrange
      const request = {
        runId: 'test-run-id',
        newMessage: {
          role: 'user' as const,
          content: 'Follow-up question',
          timestamp: Date.now(),
        },
      };

      // Act
      const stream = await controller.resumeChatSession(request);

      // Assert
      expect(stream).toBeInstanceOf(ReadableStream);
      expect(mockServices.checkpointer.initialize).toHaveBeenCalled();
      expect(metrics.increment).toHaveBeenCalledWith('chat_orchestrator.chat.resumed', 1);
    });

    it('should handle errors when resuming a chat session', async () => {
      // Arrange
      const request = {
        runId: 'test-run-id',
        newMessage: {
          role: 'user' as const,
          content: 'Follow-up question',
          timestamp: Date.now(),
        },
      };

      // Mock an error
      mockServices.checkpointer.initialize = vi.fn().mockRejectedValue(new Error('Test error'));

      // Act & Assert
      await expect(controller.resumeChatSession(request)).rejects.toThrow('Test error');
      
      // Verify error metrics
      expect(metrics.increment).toHaveBeenCalledWith('chat_orchestrator.chat.errors', 1,
        expect.objectContaining({
          errorType: 'Error',
        })
      );
    });
  });
});
