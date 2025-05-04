import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ObservabilityService } from '../../src/services/observabilityService';

// Mock the metrics and logger
vi.mock('@dome/common', () => {
  // Create a mockLogger that can be reused
  const mockChildLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => mockChildLogger),
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

vi.mock('@dome/metrics', () => ({
  ServiceMetrics: vi.fn().mockImplementation(() => ({
    counter: vi.fn(),
    gauge: vi.fn(),
    timing: vi.fn(),
  })),
}));

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
    it('should initialize a trace and return the traceId', () => {
      // Act
      const traceId = ObservabilityService.initTrace(mockEnv, 'user123', mockState);

      // Assert
      expect(traceId).toMatch(/^trace-user123-\d+$/);

      // Verify the trace exists in the internal storage
      const trace = ObservabilityService.getTrace(traceId);
      expect(trace).not.toBeNull();
      expect(trace.userId).toBe('user123');
    });
  });

  describe('startSpan', () => {
    it('should start a span and return the spanId', () => {
      // Arrange
      const traceId = ObservabilityService.initTrace(mockEnv, 'user123', mockState);

      // Act
      const spanId = ObservabilityService.startSpan(mockEnv, traceId, 'testSpan', mockState);

      // Assert
      expect(spanId).toMatch(new RegExp(`^${traceId}-testSpan-\\d+$`));
    });
  });

  describe('endSpan', () => {
    it('should end a span and update its status', () => {
      // Arrange
      const traceId = ObservabilityService.initTrace(mockEnv, 'user123', mockState);
      const spanId = ObservabilityService.startSpan(mockEnv, traceId, 'testNode', mockState);

      // Act
      ObservabilityService.endSpan(mockEnv, traceId, spanId, 'testNode', mockState, mockState, 100);

      // Assert
      const trace = ObservabilityService.getTrace(traceId);
      expect(trace).not.toBeNull();

      const span = trace.spans[spanId];
      expect(span).toBeDefined();
      expect(span.endTime).toBeDefined();
      expect(span.status).toBe('success');
    });
  });

  describe('logEvent', () => {
    it('should log an event within a span', () => {
      // Arrange
      const traceId = ObservabilityService.initTrace(mockEnv, 'user123', mockState);
      const spanId = ObservabilityService.startSpan(mockEnv, traceId, 'testNode', mockState);
      const eventData = { key: 'value' };

      // Act
      ObservabilityService.logEvent(mockEnv, traceId, spanId, 'testEvent', eventData);

      // Assert
      const trace = ObservabilityService.getTrace(traceId);
      expect(trace).not.toBeNull();

      const span = trace.spans[spanId];
      expect(span).toBeDefined();
      expect(span.events.length).toBe(1);
      expect(span.events[0].name).toBe('testEvent');
      expect(span.events[0].attributes.key).toBe('value');
    });
  });

  describe('endTrace', () => {
    it('should end a trace and update its status', () => {
      // Arrange
      const traceId = ObservabilityService.initTrace(mockEnv, 'user123', mockState);

      // Act
      ObservabilityService.endTrace(mockEnv, traceId, mockState, 300);

      // Assert
      const trace = ObservabilityService.getTrace(traceId);
      expect(trace).not.toBeNull();
      expect(trace.endTime).toBeDefined();
      expect(trace.status).toBe('success');
    });
  });

  describe('logLlmCall', () => {
    it('should log an LLM call as an event', () => {
      // Arrange
      const traceId = ObservabilityService.initTrace(mockEnv, 'user123', mockState);
      const spanId = ObservabilityService.startSpan(mockEnv, traceId, 'testNode', mockState);
      const messages = [{ role: 'user', content: 'Test message' }];
      const response = 'Test response';
      const tokenCounts = { prompt: 10, completion: 5, total: 15 };

      // Act
      ObservabilityService.logLlmCall(
        mockEnv,
        traceId,
        spanId,
        'gpt-4',
        messages,
        response,
        150,
        tokenCounts,
      );

      // Assert
      const trace = ObservabilityService.getTrace(traceId);
      expect(trace).not.toBeNull();

      const span = trace.spans[spanId];
      expect(span).toBeDefined();
      expect(span.events.length).toBe(1);
      expect(span.events[0].name).toBe('llm_call');
      expect(span.events[0].attributes.model).toBe('gpt-4');
    });
  });

  describe('logRetrieval', () => {
    it('should log a retrieval operation as an event', () => {
      // Arrange
      const traceId = ObservabilityService.initTrace(mockEnv, 'user123', mockState);
      const spanId = ObservabilityService.startSpan(mockEnv, traceId, 'testNode', mockState);
      const query = 'Test query';
      const results = [{ id: 'doc1', score: 0.9 }];

      // Act
      ObservabilityService.logRetrieval(mockEnv, traceId, spanId, query, results, 50);

      // Assert
      const trace = ObservabilityService.getTrace(traceId);
      expect(trace).not.toBeNull();

      const span = trace.spans[spanId];
      expect(span).toBeDefined();
      expect(span.events.length).toBe(1);
      expect(span.events[0].name).toBe('retrieval');
      expect(span.events[0].attributes.query).toBe(query);
    });
  });

  describe('collectMetrics', () => {
    it('should collect metrics from the agent state', () => {
      // Act
      const metrics = ObservabilityService.collectMetrics(mockState);

      // Assert
      expect(metrics).toEqual({
        totalExecutionTimeMs: 300,
        messageCount: 1,
        documentCount: 1,
        nodeTime_retrieve: 100,
        nodeTime_generateAnswer: 200,
        tokenCount_prompt: 100,
        tokenCount_completion: 50,
        tokenCount_total: 150,
      });
    });
  });
});
