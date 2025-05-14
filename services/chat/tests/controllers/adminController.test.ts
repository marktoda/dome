import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AdminController } from '../../src/controllers/adminController';
import { Services } from '../../src/services';
import { getLogger, metrics, withContext, logError } from '@dome/common';

// Mock dependencies in a single block
vi.mock('@dome/common', () => {
  // Define mockLogger INSIDE the factory to avoid hoisting issues
  const mockLogger: any = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => mockLogger), // Reference itself
  };

  return {
    // Mock functions used by the controller
    getLogger: vi.fn(() => mockLogger),
    logError: vi.fn(),
    withContext: vi.fn((_, fn) => fn(mockLogger)), // Ensure withContext uses the mockLogger

    // Mock metrics object used by controller and tests
    metrics: {
      increment: vi.fn(),
      timing: vi.fn(),
      gauge: vi.fn(),
      startTimer: vi.fn(() => ({ stop: vi.fn() })),
      trackOperation: vi.fn(),
    },

    // Mock other potentially used exports if needed, though likely not necessary for this controller
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

describe('AdminController', () => {
  let controller: AdminController;
  let mockEnv: Env;
  let mockServices: Services;
  // No need for mockMetrics variable, use the imported 'metrics' directly

  beforeEach(() => {
    // Don't clear mocks here; vi.mock implementations should persist
    // vi.clearAllMocks(); // REMOVED

    // Mocks defined in vi.mock are already active due to hoisting

    // Create mock environment with all required properties
    mockEnv = {
      VERSION: '0.1.0', // Match the exact type from worker-configuration.d.ts
      LOG_LEVEL: 'debug',
      ENVIRONMENT: 'staging', // Use 'staging' or 'production' as defined
      SEARCH_API_KEY: 'test-search-key',
      OPENAI_API_KEY: 'test-openai-key',
      COHERE_API_KEY: 'test-cohere-key',
      CHAT_ENCRYPTION_KEY: 'test-encryption-key',
      CHAT_DB: {
        // Mock D1Database methods if needed by the controller
        prepare: vi.fn(() => ({
          bind: vi.fn().mockReturnThis(),
          first: vi.fn(),
          run: vi.fn(),
          all: vi.fn(),
          raw: vi.fn(),
        })),
        dump: vi.fn(),
        batch: vi.fn(),
        exec: vi.fn(),
      } as unknown as D1Database,
      CONSTELLATION: { fetch: vi.fn() } as unknown as Fetcher,
      SILO: { fetch: vi.fn() } as unknown as Fetcher,
      TODOS: { fetch: vi.fn() } as unknown as Fetcher,
      AI: { run: vi.fn() } as unknown as Ai, // Mock AI methods if needed
      // Add missing bindings based on latest Env definition
      ENRICHED_CONTENT: {
        // Mock KVNamespace methods
        get: vi.fn(),
        getWithMetadata: vi.fn(),
        put: vi.fn(),
        list: vi.fn(),
        delete: vi.fn(),
      } as unknown as KVNamespace,
      RATE_LIMIT_DLQ: {
        // Mock Queue methods
        send: vi.fn(),
        sendBatch: vi.fn(),
      } as unknown as Queue,
    } as any as Env; // Use double assertion to bypass complex type checking

    // Create mock services
    mockServices = {
      checkpointer: {
        initialize: vi.fn(),
        getState: vi.fn(),
        setState: vi.fn(),
        getStats: vi.fn().mockResolvedValue({
          totalCheckpoints: 100,
          oldestCheckpoint: Date.now() - 86400000,
          newestCheckpoint: Date.now(),
          averageStateSize: 1024,
          checkpointsByUser: { 'test-user': 10 },
        }),
        cleanup: vi.fn().mockResolvedValue(5),
      },
      dataRetention: {
        initialize: vi.fn(),
        registerDataRecord: vi.fn(),
        getStats: vi.fn().mockResolvedValue({
          totalRecords: 200,
          recordsByCategory: { chatHistory: 150, userPreferences: 50 },
          recordsByUser: { 'test-user': 20 },
          oldestRecord: Date.now() - 86400000 * 30,
          newestRecord: Date.now(),
        }),
        cleanupExpiredData: vi.fn().mockResolvedValue({ deletedCount: 10 }),
        deleteUserData: vi.fn().mockResolvedValue(15),
        recordConsent: vi.fn().mockResolvedValue(true),
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
    controller = new AdminController(mockEnv, mockServices);
  });

  afterEach(() => {
    // Restore mocks to their original state after each test
    vi.restoreAllMocks();
    // vi.resetAllMocks(); // Use restoreAllMocks instead of resetAllMocks
  });

  describe('getCheckpointStats', () => {
    it('should return checkpoint statistics', async () => {
      // Act
      const stats = await controller.getCheckpointStats();

      // Assert
      expect(stats).toEqual({
        totalCheckpoints: 100,
        oldestCheckpoint: expect.any(Number),
        newestCheckpoint: expect.any(Number),
        averageStateSize: 1024,
        checkpointsByUser: { 'test-user': 10 },
      });
      expect(mockServices.checkpointer.initialize).toHaveBeenCalled();
      expect(mockServices.checkpointer.getStats).toHaveBeenCalled();
      expect(metrics.increment).toHaveBeenCalledWith('chat_orchestrator.admin.checkpoint_stats', 1); // Use imported 'metrics'
    });

    it('should handle errors when getting checkpoint stats', async () => {
      // Arrange
      mockServices.checkpointer.getStats = vi.fn().mockRejectedValue(new Error('Test error'));

      // Act & Assert
      await expect(controller.getCheckpointStats()).rejects.toThrow('Test error');
      // Check that the success metric was NOT called
      expect(metrics.increment).not.toHaveBeenCalledWith(
        // Use imported 'metrics'
        'chat_orchestrator.admin.checkpoint_stats',
        1,
      );
      // Optionally, check if an error metric WAS called (if implemented in controller)
      // expect(mockMetrics.increment).toHaveBeenCalledWith('chat_orchestrator.admin.checkpoint_stats.error', 1);
    });
  });

  describe('cleanupCheckpoints', () => {
    it('should clean up expired checkpoints', async () => {
      // Act
      const result = await controller.cleanupCheckpoints();

      // Assert
      expect(result).toEqual({ deletedCount: 5 });
      expect(mockServices.checkpointer.initialize).toHaveBeenCalled();
      expect(mockServices.checkpointer.cleanup).toHaveBeenCalled();
      expect(metrics.increment).toHaveBeenCalledWith(
        // Use imported 'metrics'
        'chat_orchestrator.admin.checkpoint_cleanup',
        1,
      );
      expect(metrics.increment).toHaveBeenCalledWith(
        // Use imported 'metrics'
        'chat_orchestrator.admin.checkpoints_deleted',
        5,
      );
    });

    it('should handle errors when cleaning up checkpoints', async () => {
      // Arrange
      mockServices.checkpointer.cleanup = vi.fn().mockRejectedValue(new Error('Test error'));

      // Act & Assert
      await expect(controller.cleanupCheckpoints()).rejects.toThrow('Test error');
      expect(metrics.increment).not.toHaveBeenCalledWith(
        // Use imported 'metrics'
        'chat_orchestrator.admin.checkpoint_cleanup',
        1,
      );
      // Optionally check for error metric
      // expect(mockMetrics.increment).toHaveBeenCalledWith('chat_orchestrator.admin.checkpoint_cleanup.error', 1);
    });
  });

  describe('getDataRetentionStats', () => {
    it('should return data retention statistics', async () => {
      // Act
      const stats = await controller.getDataRetentionStats();

      // Assert
      expect(stats).toEqual({
        totalRecords: 200,
        recordsByCategory: { chatHistory: 150, userPreferences: 50 },
        recordsByUser: { 'test-user': 20 },
        oldestRecord: expect.any(Number),
        newestRecord: expect.any(Number),
      });
      expect(mockServices.checkpointer.initialize).toHaveBeenCalled();
      expect(mockServices.dataRetention.initialize).toHaveBeenCalled();
      expect(mockServices.dataRetention.getStats).toHaveBeenCalled();
      expect(metrics.increment).toHaveBeenCalledWith(
        // Use imported 'metrics'
        'chat_orchestrator.admin.data_retention_stats',
        1,
      );
    });

    it('should handle errors when getting data retention stats', async () => {
      // Arrange
      mockServices.dataRetention.getStats = vi.fn().mockRejectedValue(new Error('Test error'));

      // Act & Assert
      await expect(controller.getDataRetentionStats()).rejects.toThrow('Test error');
      expect(metrics.increment).not.toHaveBeenCalledWith(
        // Use imported 'metrics'
        'chat_orchestrator.admin.data_retention_stats',
        1,
      );
      // Optionally check for error metric
      // expect(mockMetrics.increment).toHaveBeenCalledWith('chat_orchestrator.admin.data_retention_stats.error', 1);
    });
  });

  describe('cleanupExpiredData', () => {
    it('should clean up expired data', async () => {
      // Act
      const result = await controller.cleanupExpiredData();

      // Assert
      expect(result).toEqual({ deletedCount: 10 });
      expect(mockServices.checkpointer.initialize).toHaveBeenCalled();
      expect(mockServices.dataRetention.initialize).toHaveBeenCalled();
      expect(mockServices.dataRetention.cleanupExpiredData).toHaveBeenCalled();
      expect(metrics.increment).toHaveBeenCalledWith('chat_orchestrator.admin.data_cleanup', 1); // Use imported 'metrics'
    });

    it('should handle errors when cleaning up expired data', async () => {
      // Arrange
      mockServices.dataRetention.cleanupExpiredData = vi
        .fn()
        .mockRejectedValue(new Error('Test error'));

      // Act & Assert
      await expect(controller.cleanupExpiredData()).rejects.toThrow('Test error');
      expect(metrics.increment).not.toHaveBeenCalledWith('chat_orchestrator.admin.data_cleanup', 1); // Use imported 'metrics'
      // Optionally check for error metric
      // expect(metrics.increment).toHaveBeenCalledWith('chat_orchestrator.admin.data_cleanup.error', 1);
    });
  });

  describe('deleteUserData', () => {
    it('should delete user data', async () => {
      // Act
      const result = await controller.deleteUserData('test-user');

      // Assert
      expect(result).toEqual({ deletedCount: 15 });
      expect(mockServices.checkpointer.initialize).toHaveBeenCalled();
      expect(mockServices.dataRetention.initialize).toHaveBeenCalled();
      expect(mockServices.dataRetention.deleteUserData).toHaveBeenCalledWith('test-user');
      expect(metrics.increment).toHaveBeenCalledWith(
        // Use imported 'metrics'
        'chat_orchestrator.admin.user_data_deleted',
        1,
        {
          userId: 'test-user',
        },
      );
      expect(metrics.increment).toHaveBeenCalledWith('chat_orchestrator.admin.records_deleted', 15); // Use imported 'metrics'
    });

    it('should handle errors when deleting user data', async () => {
      // Arrange
      mockServices.dataRetention.deleteUserData = vi
        .fn()
        .mockRejectedValue(new Error('Test error'));

      // Act & Assert
      await expect(controller.deleteUserData('test-user')).rejects.toThrow('Test error');
      expect(metrics.increment).not.toHaveBeenCalledWith(
        // Use imported 'metrics'
        'chat_orchestrator.admin.user_data_deleted',
        1,
      );
      // Optionally check for error metric
      // expect(mockMetrics.increment).toHaveBeenCalledWith('chat_orchestrator.admin.user_data_deleted.error', 1);
    });
  });

  describe('recordConsent', () => {
    it('should record user consent', async () => {
      // Act
      const result = await controller.recordConsent('test-user', 'chatHistory', {
        durationDays: 30,
      });

      // Assert
      expect(result).toEqual({ success: true });
      expect(mockServices.checkpointer.initialize).toHaveBeenCalled();
      expect(mockServices.dataRetention.initialize).toHaveBeenCalled();
      expect(mockServices.dataRetention.recordConsent).toHaveBeenCalledWith(
        'test-user',
        'chatHistory',
        30,
      );
      expect(metrics.increment).toHaveBeenCalledWith(
        // Use imported 'metrics'
        'chat_orchestrator.admin.consent_recorded',
        1,
        {
          userId: 'test-user',
          dataCategory: 'chatHistory',
        },
      );
    });

    it('should handle errors when recording user consent', async () => {
      // Arrange
      mockServices.dataRetention.recordConsent = vi.fn().mockRejectedValue(new Error('Test error'));

      // Act & Assert
      await expect(
        controller.recordConsent('test-user', 'chatHistory', { durationDays: 30 }),
      ).rejects.toThrow('Test error');
      expect(metrics.increment).not.toHaveBeenCalledWith(
        // Use imported 'metrics'
        'chat_orchestrator.admin.consent_recorded',
        1,
      );
      // Optionally check for error metric
      // expect(mockMetrics.increment).toHaveBeenCalledWith('chat_orchestrator.admin.consent_recorded.error', 1);
    });

    it('should validate the consent request', async () => {
      // Act & Assert
      await expect(
        controller.recordConsent('test-user', 'chatHistory', { durationDays: 0 }),
      ).rejects.toThrow();
      await expect(
        controller.recordConsent('test-user', 'chatHistory', { durationDays: 366 * 5 }),
      ).rejects.toThrow();
    });
  });
});
