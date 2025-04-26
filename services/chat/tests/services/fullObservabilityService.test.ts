import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  FullObservabilityService,
  TraceContext,
} from '../../src/services/fullObservabilityService';
import { getLogger } from '@dome/logging';
import { Metrics } from '@dome/metrics';

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
}));

vi.mock('@dome/metrics', () => {
  return {
    Metrics: vi.fn().mockImplementation(() => ({
      counter: vi.fn(),
      histogram: vi.fn(),
      gauge: vi.fn(),
    })),
  };
});

describe('FullObservabilityService', () => {
  let mockEnv: Env;
  let mockState: any;
  let mockContext: TraceContext;

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

    // Create mock trace context
    mockContext = {
      traceId: 'test-trace-id',
      spanId: 'test-span-id',
    };

    // Reset any in-memory state in the service
    FullObservabilityService.dispose();
  });

  afterEach(() => {
    // Clean up
    FullObservabilityService.dispose();
  });

  describe('initTrace', () => {
    it('should initialize a trace and return a trace context', () => {
      // Act
      const context = FullObservabilityService.initTrace(mockEnv, 'user123', mockState);

      // Assert
      expect(context).toBeDefined();
      expect(context.traceId).toContain('trace-user123');
      expect(context.spanId).toBeDefined();

      // Verify logger was called
      expect(getLogger().child().info).toHaveBeenCalledWith(
        expect.objectContaining({
          traceId: context.traceId,
          userId: 'user123',
          messageCount: 1,
        }),
        'Initialized trace',
      );

      // Verify metrics were recorded
      const metricsInstance = new Metrics();
      expect(metricsInstance.counter).toHaveBeenCalledWith(
        'trace.init',
        1,
        expect.objectContaining({
          traceId: context.traceId,
          userId: 'user123',
          environment: 'test',
        }),
      );
    });
  });

  describe('startSpan', () => {
    it('should start a span and return an updated context', () => {
      // Act
      const newContext = FullObservabilityService.startSpan(
        mockEnv,
        mockContext,
        'testSpan',
        mockState,
      );

      // Assert
      expect(newContext).toBeDefined();
      expect(newContext.traceId).toBe(mockContext.traceId);
      expect(newContext.spanId).toContain('testSpan');
      expect(newContext.parentSpanId).toBe(mockContext.spanId);

      // Verify logger was called
      expect(getLogger().child().info).toHaveBeenCalledWith(
        expect.objectContaining({
          traceId: mockContext.traceId,
          spanId: newContext.spanId,
          spanName: 'testSpan',
        }),
        'Started span',
      );

      // Verify metrics were recorded
      const metricsInstance = new Metrics();
      expect(metricsInstance.counter).toHaveBeenCalledWith(
        'span.start',
        1,
        expect.objectContaining({
          traceId: mockContext.traceId,
          spanId: newContext.spanId,
          spanName: 'testSpan',
        }),
      );
    });

    it('should handle starting a span for an unknown trace', () => {
      // Arrange
      const unknownContext = { traceId: 'unknown-trace', spanId: 'unknown-span' };

      // Act
      const newContext = FullObservabilityService.startSpan(
        mockEnv,
        unknownContext,
        'testSpan',
        mockState,
      );

      // Assert
      expect(newContext).toBeDefined();
      expect(newContext.traceId).toBe(unknownContext.traceId);
      expect(newContext.spanId).toContain('testSpan');

      // Verify warning was logged
      expect(getLogger().child().warn).toHaveBeenCalledWith(
        expect.objectContaining({
          traceId: unknownContext.traceId,
          spanName: 'testSpan',
        }),
        'Attempted to start span for unknown trace',
      );
    });
  });

  describe('endSpan', () => {
    it('should end a span correctly', () => {
      // Arrange
      const context = FullObservabilityService.initTrace(mockEnv, 'user123', mockState);
      const spanContext = FullObservabilityService.startSpan(
        mockEnv,
        context,
        'testSpan',
        mockState,
      );

      // Act
      FullObservabilityService.endSpan(mockEnv, spanContext, 'testSpan', mockState, mockState, 150);

      // Assert
      // Verify logger was called
      expect(getLogger().child().info).toHaveBeenCalledWith(
        expect.objectContaining({
          traceId: spanContext.traceId,
          spanId: spanContext.spanId,
          spanName: 'testSpan',
          executionTimeMs: 150,
        }),
        'Ended span',
      );

      // Verify metrics were recorded
      const metricsInstance = new Metrics();
      expect(metricsInstance.counter).toHaveBeenCalledWith(
        'span.end',
        1,
        expect.objectContaining({
          traceId: spanContext.traceId,
          spanId: spanContext.spanId,
          spanName: 'testSpan',
        }),
      );

      expect(metricsInstance.histogram).toHaveBeenCalledWith(
        'span.duration',
        150,
        expect.objectContaining({
          traceId: spanContext.traceId,
          spanId: spanContext.spanId,
          spanName: 'testSpan',
        }),
      );
    });

    it('should handle errors in the end state', () => {
      // Arrange
      const context = FullObservabilityService.initTrace(mockEnv, 'user123', mockState);
      const spanContext = FullObservabilityService.startSpan(
        mockEnv,
        context,
        'testSpan',
        mockState,
      );

      const stateWithError = {
        ...mockState,
        metadata: {
          ...mockState.metadata,
          errors: [
            {
              message: 'Test error',
              timestamp: Date.now(),
              node: 'testSpan',
            },
          ],
        },
      };

      // Act
      FullObservabilityService.endSpan(
        mockEnv,
        spanContext,
        'testSpan',
        mockState,
        stateWithError,
        150,
      );

      // Assert
      // Verify error event was logged
      expect(getLogger().child().info).toHaveBeenCalledWith(
        expect.objectContaining({
          traceId: spanContext.traceId,
          spanId: spanContext.spanId,
          eventName: 'error',
        }),
        'Logged event',
      );
    });
  });

  describe('logEvent', () => {
    it('should log an event correctly', () => {
      // Arrange
      const context = FullObservabilityService.initTrace(mockEnv, 'user123', mockState);
      const spanContext = FullObservabilityService.startSpan(
        mockEnv,
        context,
        'testSpan',
        mockState,
      );

      // Act
      FullObservabilityService.logEvent(mockEnv, spanContext, 'testEvent', {
        key1: 'value1',
        key2: 'value2',
      });

      // Assert
      // Verify logger was called
      expect(getLogger().child().info).toHaveBeenCalledWith(
        expect.objectContaining({
          traceId: spanContext.traceId,
          spanId: spanContext.spanId,
          eventName: 'testEvent',
          key1: 'value1',
          key2: 'value2',
        }),
        'Logged event',
      );

      // Verify metrics were recorded
      const metricsInstance = new Metrics();
      expect(metricsInstance.counter).toHaveBeenCalledWith(
        'event',
        1,
        expect.objectContaining({
          traceId: spanContext.traceId,
          spanId: spanContext.spanId,
          eventName: 'testEvent',
        }),
      );
    });
  });

  describe('endTrace', () => {
    it('should end a trace correctly', () => {
      // Arrange
      const context = FullObservabilityService.initTrace(mockEnv, 'user123', mockState);

      // Act
      FullObservabilityService.endTrace(mockEnv, context, mockState, 500);

      // Assert
      // Verify logger was called
      expect(getLogger().child().info).toHaveBeenCalledWith(
        expect.objectContaining({
          traceId: context.traceId,
          totalExecutionTimeMs: 500,
          nodeTimings: mockState.metadata.nodeTimings,
          tokenCounts: mockState.metadata.tokenCounts,
        }),
        'Ended trace',
      );

      // Verify metrics were recorded
      const metricsInstance = new Metrics();
      expect(metricsInstance.counter).toHaveBeenCalledWith(
        'trace.end',
        1,
        expect.objectContaining({
          traceId: context.traceId,
        }),
      );

      expect(metricsInstance.histogram).toHaveBeenCalledWith(
        'trace.duration',
        500,
        expect.objectContaining({
          traceId: context.traceId,
        }),
      );

      // Verify node timing metrics
      expect(metricsInstance.histogram).toHaveBeenCalledWith(
        'node.duration',
        100,
        expect.objectContaining({
          traceId: context.traceId,
          nodeName: 'retrieve',
        }),
      );

      expect(metricsInstance.histogram).toHaveBeenCalledWith(
        'node.duration',
        200,
        expect.objectContaining({
          traceId: context.traceId,
          nodeName: 'generateAnswer',
        }),
      );

      // Verify token count metrics
      expect(metricsInstance.histogram).toHaveBeenCalledWith(
        'token.count',
        100,
        expect.objectContaining({
          traceId: context.traceId,
          tokenType: 'prompt',
        }),
      );
    });
  });

  describe('logLlmCall', () => {
    it('should log an LLM call correctly', () => {
      // Arrange
      const context = FullObservabilityService.initTrace(mockEnv, 'user123', mockState);
      const spanContext = FullObservabilityService.startSpan(
        mockEnv,
        context,
        'testSpan',
        mockState,
      );

      const messages = [{ role: 'user', content: 'Test message' }];
      const response = 'Test response';
      const tokenCounts = {
        prompt: 100,
        completion: 50,
        total: 150,
      };

      // Act
      FullObservabilityService.logLlmCall(
        mockEnv,
        spanContext,
        'gpt-4',
        messages,
        response,
        300,
        tokenCounts,
      );

      // Assert
      // Verify event was logged
      expect(getLogger().child().info).toHaveBeenCalledWith(
        expect.objectContaining({
          traceId: spanContext.traceId,
          spanId: spanContext.spanId,
          eventName: 'llm_call',
          model: 'gpt-4',
          messageCount: 1,
          responseLength: 13,
          executionTimeMs: 300,
          tokenCounts,
        }),
        'Logged event',
      );

      // Verify metrics were recorded
      const metricsInstance = new Metrics();
      expect(metricsInstance.counter).toHaveBeenCalledWith(
        'llm.call',
        1,
        expect.objectContaining({
          traceId: spanContext.traceId,
          spanId: spanContext.spanId,
          model: 'gpt-4',
        }),
      );

      expect(metricsInstance.histogram).toHaveBeenCalledWith(
        'llm.latency',
        300,
        expect.objectContaining({
          traceId: spanContext.traceId,
          spanId: spanContext.spanId,
          model: 'gpt-4',
        }),
      );

      // Verify token count metrics
      expect(metricsInstance.histogram).toHaveBeenCalledWith(
        'llm.tokens.prompt',
        100,
        expect.objectContaining({
          traceId: spanContext.traceId,
          spanId: spanContext.spanId,
          model: 'gpt-4',
        }),
      );
    });
  });

  describe('logRetrieval', () => {
    it('should log a retrieval operation correctly', () => {
      // Arrange
      const context = FullObservabilityService.initTrace(mockEnv, 'user123', mockState);
      const spanContext = FullObservabilityService.startSpan(
        mockEnv,
        context,
        'testSpan',
        mockState,
      );

      const query = 'Test query';
      const results = [
        { id: 'doc1', score: 0.9 },
        { id: 'doc2', score: 0.8 },
        { id: 'doc3', score: 0.7 },
      ];

      // Act
      FullObservabilityService.logRetrieval(mockEnv, spanContext, query, results, 200);

      // Assert
      // Verify event was logged
      expect(getLogger().child().info).toHaveBeenCalledWith(
        expect.objectContaining({
          traceId: spanContext.traceId,
          spanId: spanContext.spanId,
          eventName: 'retrieval',
          query,
          resultCount: 3,
          topResults: results.slice(0, 3),
          executionTimeMs: 200,
        }),
        'Logged event',
      );

      // Verify metrics were recorded
      const metricsInstance = new Metrics();
      expect(metricsInstance.counter).toHaveBeenCalledWith(
        'retrieval.call',
        1,
        expect.objectContaining({
          traceId: spanContext.traceId,
          spanId: spanContext.spanId,
        }),
      );

      expect(metricsInstance.histogram).toHaveBeenCalledWith(
        'retrieval.latency',
        200,
        expect.objectContaining({
          traceId: spanContext.traceId,
          spanId: spanContext.spanId,
        }),
      );

      expect(metricsInstance.histogram).toHaveBeenCalledWith(
        'retrieval.result_count',
        3,
        expect.objectContaining({
          traceId: spanContext.traceId,
          spanId: spanContext.spanId,
        }),
      );

      expect(metricsInstance.gauge).toHaveBeenCalledWith(
        'retrieval.top_score',
        0.9,
        expect.objectContaining({
          traceId: spanContext.traceId,
          spanId: spanContext.spanId,
        }),
      );
    });
  });

  describe('collectMetrics', () => {
    it('should collect metrics from agent state', () => {
      // Act
      const metrics = FullObservabilityService.collectMetrics(mockState);

      // Assert
      expect(metrics).toEqual({
        totalExecutionTimeMs: 300, // 100 + 200
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

  describe('createDashboardUrl', () => {
    it('should create a dashboard URL', () => {
      // Act
      const url = FullObservabilityService.createDashboardUrl(mockEnv, 'test-trace-id');

      // Assert
      expect(url).toContain('/monitoring/dashboard');
      expect(url).toContain('service=chat-orchestrator');
      expect(url).toContain('environment=test');
      expect(url).toContain('traceId=test-trace-id');
    });

    it('should create a dashboard URL without trace ID', () => {
      // Act
      const url = FullObservabilityService.createDashboardUrl(mockEnv);

      // Assert
      expect(url).toContain('/monitoring/dashboard');
      expect(url).toContain('service=chat-orchestrator');
      expect(url).toContain('environment=test');
      expect(url).not.toContain('traceId=');
    });
  });

  describe('getTrace and exportTraces', () => {
    it('should get a trace by ID', () => {
      // Arrange
      const context = FullObservabilityService.initTrace(mockEnv, 'user123', mockState);
      const spanContext = FullObservabilityService.startSpan(
        mockEnv,
        context,
        'testSpan',
        mockState,
      );

      // Act
      const trace = FullObservabilityService.getTrace(context.traceId);

      // Assert
      expect(trace).toBeDefined();
      expect(trace.userId).toBe('user123');
      expect(trace.spans).toBeDefined();
      expect(Object.keys(trace.spans)).toContain(spanContext.spanId);
    });

    it('should export all traces', () => {
      // Arrange
      const context1 = FullObservabilityService.initTrace(mockEnv, 'user123', mockState);
      const context2 = FullObservabilityService.initTrace(mockEnv, 'user456', mockState);

      // Act
      const traces = FullObservabilityService.exportTraces();

      // Assert
      expect(traces).toBeDefined();
      expect(Object.keys(traces)).toContain(context1.traceId);
      expect(Object.keys(traces)).toContain(context2.traceId);
    });
  });
});
