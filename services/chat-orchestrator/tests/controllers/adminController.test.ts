import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AdminController } from '../../src/controllers/adminController';
import { Services } from '../../src/services';
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

describe('AdminController', () => {
  let controller: AdminController;
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
          recordsByCategory: { 'chatHistory': 150, 'userPreferences': 50 },
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
    vi.resetAllMocks();
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
      expect(metrics.increment).toHaveBeenCalledWith('chat_orchestrator.admin.checkpoint_stats', 1);
    });
    
    it('should handle errors when getting checkpoint stats', async () => {
      // Arrange
      mockServices.checkpointer.getStats = vi.fn().mockRejectedValue(new Error('Test error'));
      
      // Act & Assert
      await expect(controller.getCheckpointStats()).rejects.toThrow('Test error');
      expect(metrics.increment).not.toHaveBeenCalledWith('chat_orchestrator.admin.checkpoint_stats', 1);
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
      expect(metrics.increment).toHaveBeenCalledWith('chat_orchestrator.admin.checkpoint_cleanup', 1);
      expect(metrics.increment).toHaveBeenCalledWith('chat_orchestrator.admin.checkpoints_deleted', 5);
    });
    
    it('should handle errors when cleaning up checkpoints', async () => {
      // Arrange
      mockServices.checkpointer.cleanup = vi.fn().mockRejectedValue(new Error('Test error'));
      
      // Act & Assert
      await expect(controller.cleanupCheckpoints()).rejects.toThrow('Test error');
      expect(metrics.increment).not.toHaveBeenCalledWith('chat_orchestrator.admin.checkpoint_cleanup', 1);
    });
  });
  
  describe('getDataRetentionStats', () => {
    it('should return data retention statistics', async () => {
      // Act
      const stats = await controller.getDataRetentionStats();
      
      // Assert
      expect(stats).toEqual({
        totalRecords: 200,
        recordsByCategory: { 'chatHistory': 150, 'userPreferences': 50 },
        recordsByUser: { 'test-user': 20 },
        oldestRecord: expect.any(Number),
        newestRecord: expect.any(Number),
      });
      expect(mockServices.checkpointer.initialize).toHaveBeenCalled();
      expect(mockServices.dataRetention.initialize).toHaveBeenCalled();
      expect(mockServices.dataRetention.getStats).toHaveBeenCalled();
      expect(metrics.increment).toHaveBeenCalledWith('chat_orchestrator.admin.data_retention_stats', 1);
    });
    
    it('should handle errors when getting data retention stats', async () => {
      // Arrange
      mockServices.dataRetention.getStats = vi.fn().mockRejectedValue(new Error('Test error'));
      
      // Act & Assert
      await expect(controller.getDataRetentionStats()).rejects.toThrow('Test error');
      expect(metrics.increment).not.toHaveBeenCalledWith('chat_orchestrator.admin.data_retention_stats', 1);
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
      expect(metrics.increment).toHaveBeenCalledWith('chat_orchestrator.admin.data_cleanup', 1);
    });
    
    it('should handle errors when cleaning up expired data', async () => {
      // Arrange
      mockServices.dataRetention.cleanupExpiredData = vi.fn().mockRejectedValue(new Error('Test error'));
      
      // Act & Assert
      await expect(controller.cleanupExpiredData()).rejects.toThrow('Test error');
      expect(metrics.increment).not.toHaveBeenCalledWith('chat_orchestrator.admin.data_cleanup', 1);
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
      expect(metrics.increment).toHaveBeenCalledWith('chat_orchestrator.admin.user_data_deleted', 1, {
        userId: 'test-user'
      });
      expect(metrics.increment).toHaveBeenCalledWith('chat_orchestrator.admin.records_deleted', 15);
    });
    
    it('should handle errors when deleting user data', async () => {
      // Arrange
      mockServices.dataRetention.deleteUserData = vi.fn().mockRejectedValue(new Error('Test error'));
      
      // Act & Assert
      await expect(controller.deleteUserData('test-user')).rejects.toThrow('Test error');
      expect(metrics.increment).not.toHaveBeenCalledWith('chat_orchestrator.admin.user_data_deleted', 1);
    });
  });
  
  describe('recordConsent', () => {
    it('should record user consent', async () => {
      // Act
      const result = await controller.recordConsent('test-user', 'chatHistory', { durationDays: 30 });
      
      // Assert
      expect(result).toEqual({ success: true });
      expect(mockServices.checkpointer.initialize).toHaveBeenCalled();
      expect(mockServices.dataRetention.initialize).toHaveBeenCalled();
      expect(mockServices.dataRetention.recordConsent).toHaveBeenCalledWith(
        'test-user',
        'chatHistory',
        30
      );
      expect(metrics.increment).toHaveBeenCalledWith('chat_orchestrator.admin.consent_recorded', 1, {
        userId: 'test-user',
        dataCategory: 'chatHistory'
      });
    });
    
    it('should handle errors when recording user consent', async () => {
      // Arrange
      mockServices.dataRetention.recordConsent = vi.fn().mockRejectedValue(new Error('Test error'));
      
      // Act & Assert
      await expect(controller.recordConsent('test-user', 'chatHistory', { durationDays: 30 })).rejects.toThrow('Test error');
      expect(metrics.increment).not.toHaveBeenCalledWith('chat_orchestrator.admin.consent_recorded', 1);
    });
    
    it('should validate the consent request', async () => {
      // Act & Assert
      await expect(controller.recordConsent('test-user', 'chatHistory', { durationDays: 0 })).rejects.toThrow();
      await expect(controller.recordConsent('test-user', 'chatHistory', { durationDays: 366 * 5 })).rejects.toThrow();
    });
  });
});
