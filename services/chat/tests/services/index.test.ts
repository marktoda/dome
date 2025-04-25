import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createServices, Services } from '../../src/services';
import { getLogger } from '@dome/logging';

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

vi.mock('../../src/checkpointer/secureD1Checkpointer', () => ({
  SecureD1Checkpointer: vi.fn().mockImplementation(() => ({
    initialize: vi.fn(),
    getState: vi.fn(),
    setState: vi.fn(),
    getStats: vi.fn(),
    cleanup: vi.fn(),
  })),
}));

vi.mock('../../src/utils/dataRetentionManager', () => ({
  DataRetentionManager: vi.fn().mockImplementation(() => ({
    initialize: vi.fn(),
    registerDataRecord: vi.fn(),
    getStats: vi.fn(),
    cleanupExpiredData: vi.fn(),
    deleteUserData: vi.fn(),
    recordConsent: vi.fn(),
  })),
}));

vi.mock('../../src/tools/secureToolExecutor', () => ({
  initializeToolRegistry: vi.fn().mockReturnValue({}),
}));

describe('Services', () => {
  let mockEnv: Env;

  beforeEach(() => {
    // Reset mocks
    vi.clearAllMocks();

    // Create mock environment
    mockEnv = {
      CHAT_DB: {} as any,
      AI: {} as any,
    } as Env;
  });

  describe('createServices', () => {
    it('should create all required services', () => {
      // Act
      const services = createServices(mockEnv);

      // Assert
      expect(services).toBeDefined();
      expect(services.llm).toBeDefined();
      expect(services.search).toBeDefined();
      expect(services.observability).toBeDefined();
      expect(services.checkpointer).toBeDefined();
      expect(services.dataRetention).toBeDefined();
      expect(services.toolRegistry).toBeDefined();

      // Verify logger was called
      expect(getLogger().child).toHaveBeenCalledWith({ component: 'ServiceFactory' });
    });

    it('should initialize services with the correct dependencies', () => {
      // Act
      const services = createServices(mockEnv);

      // Assert
      // Check that the checkpointer was created with the correct parameters
      expect(services.checkpointer).toBeDefined();

      // Check that the data retention manager was created with the correct parameters
      expect(services.dataRetention).toBeDefined();

      // Check that the tool registry was initialized
      expect(services.toolRegistry).toBeDefined();
    });
  });

  describe('LlmService', () => {
    it('should provide methods that delegate to static methods', async () => {
      // Arrange
      const services = createServices(mockEnv);

      // Mock the static methods
      const originalCall = require('../../src/services/llmService').LlmService.call;
      require('../../src/services/llmService').LlmService.call = vi
        .fn()
        .mockResolvedValue('Test response');

      // Act
      await services.llm.call(mockEnv, [{ role: 'user', content: 'Test' }]);

      // Assert
      expect(require('../../src/services/llmService').LlmService.call).toHaveBeenCalledWith(
        mockEnv,
        [{ role: 'user', content: 'Test' }],
      );

      // Restore the original method
      require('../../src/services/llmService').LlmService.call = originalCall;
    });
  });
});
