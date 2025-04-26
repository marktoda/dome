import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ObservabilityService } from '../../src/services/observabilityService';
import { FullObservabilityService } from '../../src/services/fullObservabilityService';

// Mock the FullObservabilityService
vi.mock('../../src/services/fullObservabilityService', () => {
  return {
    FullObservabilityService: {
      initTrace: vi.fn().mockReturnValue({ traceId: 'mock-trace-id', spanId: 'mock-span-id' }),
      startSpan: vi.fn().mockReturnValue({ traceId: 'mock-trace-id', spanId: 'mock-span-id', parentSpanId: 'parent-span-id' }),
      endSpan: vi.fn(),
      logEvent: vi.fn(),
      endTrace: vi.fn(),
      logLlmCall: vi.fn(),
      logRetrieval: vi.fn(),
      collectMetrics: vi.fn().mockReturnValue({ metric1: 100, metric2: 200 }),
    },
    TraceContext: vi.fn(),
  };
});

describe('ObservabilityService', () => {
  let mockEnv: Env;
  let mockState: any;

  beforeEach(() => {
    // Reset mocks
    vi.clearAllMocks();

    // Create mock environment
    mockEnv = {
      ENVIRONMENT: 'test',
      VERSION: '1.0.0',
    } as Env;

    // Create mock agent state
    mockState = {
      messages: [{ role: 'user', content: 'Test message' }],
      docs: [{ id: 'doc1', content: 'Test document' }],
      metadata: {
        nodeTimings: {
          retrieve: 100,
          generateAnswer: 200,
        },
        tokenCounts: {
          prompt: 100,
          completion: 50,
          total: 150,
        },
      },
    };
  });

  describe('initTrace', () => {
    it('should call FullObservabilityService.initTrace and return the traceId', () => {
      // Act
      const traceId = ObservabilityService.initTrace(mockEnv, 'user123', mockState);

      // Assert
      expect(traceId).toBe('mock-trace-id');
      expect(FullObservabilityService.initTrace).toHaveBeenCalledWith(mockEnv, 'user123', mockState);
    });
  });

  describe('startSpan', () => {
    it('should call FullObservabilityService.startSpan and return the spanId', () => {
      // Act
      const spanId = ObservabilityService.startSpan(mockEnv, 'trace-123', 'testSpan', mockState);

      // Assert
      expect(spanId).toBe('mock-span-id');
      expect(FullObservabilityService.startSpan).toHaveBeenCalledWith(
        mockEnv,
        { traceId: 'trace-123', spanId: '' },
        'testSpan',
        mockState,
      );
    });
  });

  describe('endSpan', () => {
    it('should call FullObservabilityService.endSpan with the correct parameters', () => {
      // Act
      ObservabilityService.endSpan(
        mockEnv,
        'trace-123',
        'span-123',
        'testSpan',
        mockState,
        mockState,
        150,
      );

      // Assert
      expect(FullObservabilityService.endSpan).toHaveBeenCalledWith(
        mockEnv,
        { traceId: 'trace-123', spanId: 'span-123' },
        'testSpan',
        mockState,
        mockState,
        150,
      );
    });
  });

  describe('logEvent', () => {
    it('should call FullObservabilityService.logEvent with the correct parameters', () => {
      // Arrange
      const eventData = { key1: 'value1', key2: 'value2' };

      // Act
      ObservabilityService.logEvent(mockEnv, 'trace-123', 'span-123', 'testEvent', eventData);

      // Assert
      expect(FullObservabilityService.logEvent).toHaveBeenCalledWith(
        mockEnv,
        { traceId: 'trace-123', spanId: 'span-123' },
        'testEvent',
        eventData,
      );
    });
  });

  describe('endTrace', () => {
    it('should call FullObservabilityService.endTrace with the correct parameters', () => {
      // Act
      ObservabilityService.endTrace(mockEnv, 'trace-123', mockState, 500);

      // Assert
      expect(FullObservabilityService.endTrace).toHaveBeenCalledWith(
        mockEnv,
        { traceId: 'trace-123', spanId: '' },
        mockState,
        500,
      );
    });
  });

  describe('logLlmCall', () => {
    it('should call FullObservabilityService.logLlmCall with the correct parameters', () => {
      // Arrange
      const messages = [{ role: 'user', content: 'Test message' }];
      const response = 'Test response';
      const tokenCounts = {
        prompt: 100,
        completion: 50,
        total: 150,
      };

      // Act
      ObservabilityService.logLlmCall(
        mockEnv,
        'trace-123',
        'span-123',
        'gpt-4',
        messages,
        response,
        300,
        tokenCounts,
      );

      // Assert
      expect(FullObservabilityService.logLlmCall).toHaveBeenCalledWith(
        mockEnv,
        { traceId: 'trace-123', spanId: 'span-123' },
        'gpt-4',
        messages,
        response,
        300,
        tokenCounts,
      );
    });
  });

  describe('logRetrieval', () => {
    it('should call FullObservabilityService.logRetrieval with the correct parameters', () => {
      // Arrange
      const query = 'Test query';
      const results = [
        { id: 'doc1', score: 0.9 },
        { id: 'doc2', score: 0.8 },
      ];

      // Act
      ObservabilityService.logRetrieval(mockEnv, 'trace-123', 'span-123', query, results, 200);

      // Assert
      expect(FullObservabilityService.logRetrieval).toHaveBeenCalledWith(
        mockEnv,
        { traceId: 'trace-123', spanId: 'span-123' },
        query,
        results,
        200,
      );
    });
  });

  describe('collectMetrics', () => {
    it('should call FullObservabilityService.collectMetrics and return the result', () => {
      // Act
      const metrics = ObservabilityService.collectMetrics(mockState);

      // Assert
      expect(metrics).toEqual({ metric1: 100, metric2: 200 });
      expect(FullObservabilityService.collectMetrics).toHaveBeenCalledWith(mockState);
    });
  });
});