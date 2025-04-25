import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import ChatOrchestrator from '../src/index';
import { createServices } from '../src/services';
import { createControllers } from '../src/controllers';
import { getLogger, metrics } from '@dome/logging';

// Mock dependencies
vi.mock('@dome/logging', () => ({
  getLogger: vi.fn(() => ({
    child: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    })),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
  logError: vi.fn(),
  metrics: {
    increment: vi.fn(),
    timing: vi.fn(),
    gauge: vi.fn(),
    startTimer: vi.fn(() => ({ stop: vi.fn() })),
  },
  withLogger: vi.fn((_, fn) => fn()),
}));

// Mock services and controllers
vi.mock('../src/services', () => ({
  createServices: vi.fn(() => ({
    llm: {},
    search: {},
    observability: {},
    checkpointer: {},
    dataRetention: {},
    toolRegistry: {},
  })),
}));

vi.mock('../src/controllers', () => ({
  createControllers: vi.fn(() => ({
    chat: {
      generateChatResponse: vi.fn(),
      resumeChatSession: vi.fn(),
    },
    admin: {
      getCheckpointStats: vi.fn(),
      cleanupCheckpoints: vi.fn(),
      getDataRetentionStats: vi.fn(),
      cleanupExpiredData: vi.fn(),
      deleteUserData: vi.fn(),
      recordConsent: vi.fn(),
    },
  })),
}));

describe('ChatOrchestrator', () => {
  let orchestrator: ChatOrchestrator;
  let mockEnv: any;
  let mockCtx: any;
  let mockControllers: any;

  beforeEach(() => {
    // Reset mocks
    vi.clearAllMocks();

    // Create mock environment and context
    mockEnv = {
      CHAT_DB: {} as any,
      AI: {} as any,
    };

    mockCtx = {
      waitUntil: vi.fn(),
    };

    // Create mock controllers
    mockControllers = {
      chat: {
        generateChatResponse: vi.fn().mockResolvedValue(new Response()),
        resumeChatSession: vi.fn().mockResolvedValue(new Response()),
      },
      admin: {
        getCheckpointStats: vi.fn().mockResolvedValue({}),
        cleanupCheckpoints: vi.fn().mockResolvedValue({ deletedCount: 5 }),
        getDataRetentionStats: vi.fn().mockResolvedValue({}),
        cleanupExpiredData: vi.fn().mockResolvedValue({ deletedCount: 10 }),
        deleteUserData: vi.fn().mockResolvedValue({ deletedCount: 15 }),
        recordConsent: vi.fn().mockResolvedValue({ success: true }),
      },
    };

    // Mock the createControllers function to return our mock controllers
    (createControllers as any).mockReturnValue(mockControllers);

    // Create orchestrator
    orchestrator = new ChatOrchestrator(mockCtx, mockEnv);
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('initialization', () => {
    it('should initialize services and controllers', () => {
      // Assert
      expect(createServices).toHaveBeenCalledWith(mockEnv);
      expect(createControllers).toHaveBeenCalled();
      expect(getLogger().child).toHaveBeenCalledWith({ component: 'ChatOrchestrator' });
    });
  });

  describe('generateChatResponse', () => {
    it('should delegate to the chat controller', async () => {
      // Arrange
      const request = {
        initialState: {
          userId: 'test-user',
          messages: [{ role: 'user', content: 'Hello', timestamp: Date.now() }],
        },
      };

      const mockResponse = new Response();
      mockControllers.chat.generateChatResponse.mockResolvedValue(mockResponse);

      // Act
      const result = await orchestrator.generateChatResponse(request);

      // Assert
      expect(result).toBe(mockResponse);
      expect(mockControllers.chat.generateChatResponse).toHaveBeenCalledWith(request);
    });

    it('should handle errors', async () => {
      // Arrange
      const request = {
        initialState: {
          userId: 'test-user',
          messages: [{ role: 'user', content: 'Hello', timestamp: Date.now() }],
        },
      };

      mockControllers.chat.generateChatResponse.mockRejectedValue(new Error('Test error'));

      // Act & Assert
      await expect(orchestrator.generateChatResponse(request)).rejects.toThrow('Test error');
      expect(metrics.increment).toHaveBeenCalledWith('chat_orchestrator.unhandled_errors', 1, {
        operation: 'generateChatResponse',
      });
    });
  });

  describe('resumeChatSession', () => {
    it('should delegate to the chat controller', async () => {
      // Arrange
      const request = {
        runId: 'test-run-id',
        newMessage: {
          role: 'user',
          content: 'Follow-up question',
          timestamp: Date.now(),
        },
      };

      const mockResponse = new Response();
      mockControllers.chat.resumeChatSession.mockResolvedValue(mockResponse);

      // Act
      const result = await orchestrator.resumeChatSession(request);

      // Assert
      expect(result).toBe(mockResponse);
      expect(mockControllers.chat.resumeChatSession).toHaveBeenCalledWith(request);
    });
  });

  describe('admin operations', () => {
    it('should delegate getCheckpointStats to the admin controller', async () => {
      // Arrange
      const mockStats = {
        totalCheckpoints: 100,
        oldestCheckpoint: Date.now() - 86400000,
        newestCheckpoint: Date.now(),
        averageStateSize: 1024,
        checkpointsByUser: { 'test-user': 10 },
      };

      mockControllers.admin.getCheckpointStats.mockResolvedValue(mockStats);

      // Act
      const result = await orchestrator.getCheckpointStats();

      // Assert
      expect(result).toEqual(mockStats);
      expect(mockControllers.admin.getCheckpointStats).toHaveBeenCalled();
    });

    it('should delegate cleanupCheckpoints to the admin controller', async () => {
      // Arrange
      mockControllers.admin.cleanupCheckpoints.mockResolvedValue({ deletedCount: 5 });

      // Act
      const result = await orchestrator.cleanupCheckpoints();

      // Assert
      expect(result).toEqual({ deletedCount: 5 });
      expect(mockControllers.admin.cleanupCheckpoints).toHaveBeenCalled();
    });

    it('should delegate deleteUserData to the admin controller', async () => {
      // Arrange
      mockControllers.admin.deleteUserData.mockResolvedValue({ deletedCount: 15 });

      // Act
      const result = await orchestrator.deleteUserData('test-user');

      // Assert
      expect(result).toEqual({ deletedCount: 15 });
      expect(mockControllers.admin.deleteUserData).toHaveBeenCalledWith('test-user');
    });

    it('should delegate recordConsent to the admin controller', async () => {
      // Arrange
      mockControllers.admin.recordConsent.mockResolvedValue({ success: true });

      // Act
      const result = await orchestrator.recordConsent('test-user', 'chatHistory', {
        durationDays: 30,
      });

      // Assert
      expect(result).toEqual({ success: true });
      expect(mockControllers.admin.recordConsent).toHaveBeenCalledWith('test-user', 'chatHistory', {
        durationDays: 30,
      });
    });
  });
});
