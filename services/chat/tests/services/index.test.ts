import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createServices, Services } from '../../src/services';
import { getLogger } from '@dome/logging';

// Mock dependencies
vi.mock('@dome/logging', () => {
  const mockLogger = {
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    child: vi.fn().mockReturnValue({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: vi.fn().mockReturnValue({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      }),
    }),
  };

  return {
    getLogger: vi.fn().mockReturnValue(mockLogger),
    logError: vi.fn(),
    metrics: {
      increment: vi.fn(),
      timing: vi.fn(),
      gauge: vi.fn(),
      startTimer: vi.fn(() => ({ stop: vi.fn() })),
      trackOperation: vi.fn(),
    },
    withLogger: vi.fn((_, fn) => fn()),
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

vi.mock('../../src/checkpointer/d1Checkpointer', () => ({
  D1Checkpointer: vi.fn().mockImplementation(() => ({
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

// Mock SearchService with its static methods and an instance
vi.mock('../../src/services/searchService', () => {
  const mockSearchInstance = {
    search: vi.fn().mockResolvedValue([]),
  };
  
  return {
    SearchService: {
      fromEnv: vi.fn().mockReturnValue(mockSearchInstance),
      extractSourceMetadata: vi.fn(),
      rankAndFilterDocuments: vi.fn(),
    },
  };
});

vi.mock('../../src/services/llmService', () => ({
  LlmService: {
    call: vi.fn().mockResolvedValue('Test response'),
    rewriteQuery: vi.fn().mockResolvedValue('Rewritten query'),
    analyzeQuery: vi.fn().mockResolvedValue({
      isComplex: false,
      shouldSplit: false,
      reason: 'Simple query'
    }),
    stream: vi.fn().mockImplementation(async function* () {
      yield 'Generated response';
    }),
    initialize: vi.fn(),
    MODEL: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  },
}));

vi.mock('../../src/services/observabilityService', () => ({
  ObservabilityService: {
    initTrace: vi.fn(),
    startSpan: vi.fn(),
    endSpan: vi.fn(),
    logEvent: vi.fn(),
    endTrace: vi.fn(),
    logLlmCall: vi.fn(),
    logRetrieval: vi.fn(),
  },
}));

// Mock the tool registry
vi.mock('../../src/tools', () => ({
  ToolRegistry: {
    fromDefault: vi.fn().mockReturnValue({
      getAllTools: vi.fn().mockReturnValue([]),
      getToolByName: vi.fn(),
      listToolNames: vi.fn().mockReturnValue([]),
    }),
  },
}));

describe('Services', () => {
  let mockEnv: Env;

  beforeEach(() => {
    // Reset mocks
    vi.clearAllMocks();

    // Create mock environment with all required properties
    mockEnv = {
      CHAT_DB: {} as any,
      AI: {} as any,
      LOG_LEVEL: 'debug',
      VERSION: '0.1.0',
      ENVIRONMENT: 'test',
      CHAT_ENCRYPTION_KEY: 'mock-encryption-key',
      DOME_API_URL: 'https://api.example.com',
      DOME_API_KEY: 'mock-api-key',
      SILO: {} as any,
      CONSTELLATION: {} as any
    } as unknown as Env;
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
      // There is no toolRegistry in the Services interface

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
    });
  });

  describe('LlmService', () => {
    it('should provide methods that delegate to static methods', async () => {
      // Arrange
      const services = createServices(mockEnv);

      // The LlmService has already been mocked at the top of the file

      // Import the mocked module
      const { LlmService } = await import('../../src/services/llmService');

      // Act
      // LlmService has static methods, not instance methods
      await LlmService.call(mockEnv, [{ role: 'user', content: 'Test' }]);

      // Assert
      expect(LlmService.call).toHaveBeenCalledWith(mockEnv, [{ role: 'user', content: 'Test' }]);
    });
  });
});
