import { getLogger } from '@dome/logging';
import { AgentState } from '../types';
import { getUserId } from '../utils/stateUtils';

/**
 * Performance metric type
 */
export type MetricValue = number | boolean | string;

/**
 * Performance metric with metadata
 */
export interface Metric {
  name: string;
  value: MetricValue;
  timestamp: number;
  labels: Record<string, string>;
}

/**
 * Span data interface
 */
export interface SpanData {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTime: number;
  endTime?: number;
  attributes: Record<string, any>;
  events: Array<{
    name: string;
    timestamp: number;
    attributes: Record<string, any>;
  }>;
  status: 'success' | 'error' | 'unset';
  metrics: Metric[];
}

/**
 * Trace data interface
 */
export interface TraceData {
  traceId: string;
  userId: string;
  startTime: number;
  endTime?: number;
  spans: Record<string, SpanData>;
  rootSpanId?: string;
  metrics: Metric[];
  status: 'success' | 'error' | 'unset';
}

/**
 * Enhanced service for observability and performance monitoring
 */
export class EnhancedObservabilityService {
  private static readonly logger = getLogger().child({ component: 'EnhancedObservabilityService' });
  private static traces: Record<string, TraceData> = {};
  private static metrics: Metric[] = [];
  private static readonly MAX_METRICS = 1000; // Maximum number of metrics to store in memory
  private static readonly MAX_TRACES = 100; // Maximum number of traces to store in memory
  private static readonly METRIC_FLUSH_INTERVAL_MS = 60000; // 1 minute
  private static flushInterval: NodeJS.Timeout | null = null;

  // Initialize the service
  static {
    // Set up metric flushing interval
    if (typeof setInterval !== 'undefined') {
      this.flushInterval = setInterval(() => {
        this.flushMetrics();
      }, this.METRIC_FLUSH_INTERVAL_MS);
    }
  }

  /**
   * Initialize a trace for a conversation
   * @param env Environment bindings
   * @param userId User ID
   * @param initialState Initial agent state
   * @returns Trace ID
   */
  static initTrace(env: Env, userId: string, initialState: AgentState): string {
    const traceId = `trace-${userId}-${Date.now()}`;
    const startTime = Date.now();

    // Create the trace
    this.traces[traceId] = {
      traceId,
      userId,
      startTime,
      spans: {},
      metrics: [],
      status: 'unset',
    };

    // Record trace initialization metric
    this.recordMetric(env, 'trace.init', 1, {
      traceId,
      userId,
      environment: env.ENVIRONMENT || 'unknown',
    });

    this.logger.info(
      {
        traceId,
        userId,
        messageCount: initialState.messages.length,
      },
      'Initialized trace',
    );

    // Clean up old traces if we have too many
    this.cleanupOldTraces();

    return traceId;
  }

  /**
   * Start a span for a node execution
   * @param env Environment bindings
   * @param traceId Trace ID
   * @param spanName Span name
   * @param state Current agent state
   * @param parentSpanId Optional parent span ID
   * @returns Span ID
   */
  static startSpan(
    env: Env,
    traceId: string,
    spanName: string,
    state: AgentState,
    parentSpanId?: string,
  ): string {
    const spanId = `${traceId}-${spanName}-${Date.now()}`;
    const startTime = Date.now();

    // Get the trace
    const trace = this.traces[traceId];
    if (!trace) {
      this.logger.warn({ traceId, spanName }, 'Attempted to start span for unknown trace');
      return spanId;
    }

    // Create the span
    trace.spans[spanId] = {
      traceId,
      spanId,
      parentSpanId,
      name: spanName,
      startTime,
      attributes: {
        userId: getUserId(state),
        messageCount: state.messages.length,
      },
      events: [],
      status: 'unset',
      metrics: [],
    };

    // Set root span if this is the first span
    if (!trace.rootSpanId) {
      trace.rootSpanId = spanId;
    }

    // Record span start metric
    this.recordMetric(env, 'span.start', 1, {
      traceId,
      spanId,
      spanName,
      userId: getUserId(state),
      environment: env.ENVIRONMENT || 'unknown',
    });

    this.logger.info(
      {
        traceId,
        spanId,
        spanName,
        parentSpanId,
      },
      'Started span',
    );

    return spanId;
  }

  /**
   * End a span for a node execution
   * @param env Environment bindings
   * @param traceId Trace ID
   * @param spanId Span ID
   * @param spanName Span name
   * @param startState State before node execution
   * @param endState State after node execution
   * @param executionTimeMs Execution time in milliseconds
   */
  static endSpan(
    env: Env,
    traceId: string,
    spanId: string,
    spanName: string,
    startState: AgentState,
    endState: AgentState,
    executionTimeMs: number,
  ): void {
    const endTime = Date.now();

    // Get the trace and span
    const trace = this.traces[traceId];
    if (!trace) {
      this.logger.warn({ traceId, spanId, spanName }, 'Attempted to end span for unknown trace');
      return;
    }

    const span = trace.spans[spanId];
    if (!span) {
      this.logger.warn({ traceId, spanId, spanName }, 'Attempted to end unknown span');
      return;
    }

    // Update the span
    span.endTime = endTime;
    span.status = 'success';

    // Check for errors in the end state
    if (endState.metadata?.errors && endState.metadata.errors.length > 0) {
      span.status = 'error';

      // Add error events
      for (const error of endState.metadata.errors) {
        this.logEvent(env, traceId, spanId, 'error', {
          message: error.message,
          timestamp: error.timestamp,
          node: error.node || spanName,
        });
      }
    }

    // Record span end metric
    this.recordMetric(env, 'span.end', 1, {
      traceId,
      spanId,
      spanName,
      userId: getUserId(startState),
      environment: env.ENVIRONMENT || 'unknown',
      status: span.status,
    });

    // Record span duration metric
    this.recordMetric(env, 'span.duration', executionTimeMs, {
      traceId,
      spanId,
      spanName,
      userId: getUserId(startState),
      environment: env.ENVIRONMENT || 'unknown',
    });

    this.logger.info(
      {
        traceId,
        spanId,
        spanName,
        executionTimeMs,
        status: span.status,
      },
      'Ended span',
    );
  }

  /**
   * Log an event within a span
   * @param env Environment bindings
   * @param traceId Trace ID
   * @param spanId Span ID
   * @param eventName Event name
   * @param data Event data
   */
  static logEvent(
    env: Env,
    traceId: string,
    spanId: string,
    eventName: string,
    data: Record<string, any>,
  ): void {
    const timestamp = Date.now();

    // Get the trace and span
    const trace = this.traces[traceId];
    if (!trace) {
      this.logger.warn({ traceId, spanId, eventName }, 'Attempted to log event for unknown trace');
      return;
    }

    const span = trace.spans[spanId];
    if (!span) {
      this.logger.warn({ traceId, spanId, eventName }, 'Attempted to log event for unknown span');
      return;
    }

    // Add the event
    span.events.push({
      name: eventName,
      timestamp,
      attributes: data,
    });

    // Record event metric
    this.recordMetric(env, 'event', 1, {
      traceId,
      spanId,
      eventName,
      environment: env.ENVIRONMENT || 'unknown',
    });

    this.logger.info(
      {
        traceId,
        spanId,
        eventName,
        ...data,
      },
      'Logged event',
    );
  }

  /**
   * End a trace
   * @param env Environment bindings
   * @param traceId Trace ID
   * @param finalState Final agent state
   * @param totalExecutionTimeMs Total execution time in milliseconds
   */
  static endTrace(
    env: Env,
    traceId: string,
    finalState: AgentState,
    totalExecutionTimeMs: number,
  ): void {
    const endTime = Date.now();

    // Get the trace
    const trace = this.traces[traceId];
    if (!trace) {
      this.logger.warn({ traceId }, 'Attempted to end unknown trace');
      return;
    }

    // Update the trace
    trace.endTime = endTime;
    trace.status = 'success';

    // Check for errors in the final state
    if (finalState.metadata?.errors && finalState.metadata.errors.length > 0) {
      trace.status = 'error';
    }

    // Record trace end metric
    this.recordMetric(env, 'trace.end', 1, {
      traceId,
      userId: getUserId(finalState),
      environment: env.ENVIRONMENT || 'unknown',
      status: trace.status,
    });

    // Record trace duration metric
    this.recordMetric(env, 'trace.duration', totalExecutionTimeMs, {
      traceId,
      userId: getUserId(finalState),
      environment: env.ENVIRONMENT || 'unknown',
    });

    // Record node timing metrics
    if (finalState.metadata?.nodeTimings) {
      for (const [nodeName, duration] of Object.entries(finalState.metadata.nodeTimings)) {
        this.recordMetric(env, 'node.duration', duration as number, {
          traceId,
          nodeName,
          userId: getUserId(finalState),
          environment: env.ENVIRONMENT || 'unknown',
        });
      }
    }

    // Record token count metrics
    if (finalState.metadata?.tokenCounts) {
      for (const [tokenType, count] of Object.entries(finalState.metadata.tokenCounts)) {
        this.recordMetric(env, 'token.count', count as number, {
          traceId,
          tokenType,
          userId: getUserId(finalState),
          environment: env.ENVIRONMENT || 'unknown',
        });
      }
    }

    this.logger.info(
      {
        traceId,
        totalExecutionTimeMs,
        nodeTimings: finalState.metadata?.nodeTimings,
        tokenCounts: finalState.metadata?.tokenCounts,
        status: trace.status,
      },
      'Ended trace',
    );
  }

  /**
   * Log an LLM call
   * @param env Environment bindings
   * @param traceId Trace ID
   * @param spanId Span ID
   * @param model Model name
   * @param messages Messages sent to the LLM
   * @param response Response from the LLM
   * @param executionTimeMs Execution time in milliseconds
   * @param tokenCounts Token counts
   */
  static logLlmCall(
    env: Env,
    traceId: string,
    spanId: string,
    model: string,
    messages: Array<{ role: string; content: string }>,
    response: string,
    executionTimeMs: number,
    tokenCounts?: {
      prompt?: number;
      completion?: number;
      total?: number;
    },
  ): void {
    // Log the event
    this.logEvent(env, traceId, spanId, 'llm_call', {
      model,
      messageCount: messages.length,
      responseLength: response.length,
      executionTimeMs,
      tokenCounts,
    });

    // Record LLM metrics
    this.recordMetric(env, 'llm.call', 1, {
      traceId,
      spanId,
      model,
      environment: env.ENVIRONMENT || 'unknown',
    });

    this.recordMetric(env, 'llm.latency', executionTimeMs, {
      traceId,
      spanId,
      model,
      environment: env.ENVIRONMENT || 'unknown',
    });

    if (tokenCounts) {
      if (tokenCounts.prompt) {
        this.recordMetric(env, 'llm.tokens.prompt', tokenCounts.prompt, {
          traceId,
          spanId,
          model,
          environment: env.ENVIRONMENT || 'unknown',
        });
      }

      if (tokenCounts.completion) {
        this.recordMetric(env, 'llm.tokens.completion', tokenCounts.completion, {
          traceId,
          spanId,
          model,
          environment: env.ENVIRONMENT || 'unknown',
        });
      }

      if (tokenCounts.total) {
        this.recordMetric(env, 'llm.tokens.total', tokenCounts.total, {
          traceId,
          spanId,
          model,
          environment: env.ENVIRONMENT || 'unknown',
        });
      }
    }
  }

  /**
   * Log a retrieval operation
   * @param env Environment bindings
   * @param traceId Trace ID
   * @param spanId Span ID
   * @param query Query used for retrieval
   * @param results Results of the retrieval
   * @param executionTimeMs Execution time in milliseconds
   */
  static logRetrieval(
    env: Env,
    traceId: string,
    spanId: string,
    query: string,
    results: Array<{ id: string; score: number }>,
    executionTimeMs: number,
  ): void {
    // Log the event
    this.logEvent(env, traceId, spanId, 'retrieval', {
      query,
      resultCount: results.length,
      topResults: results.slice(0, 3),
      executionTimeMs,
    });

    // Record retrieval metrics
    this.recordMetric(env, 'retrieval.call', 1, {
      traceId,
      spanId,
      environment: env.ENVIRONMENT || 'unknown',
    });

    this.recordMetric(env, 'retrieval.latency', executionTimeMs, {
      traceId,
      spanId,
      environment: env.ENVIRONMENT || 'unknown',
    });

    this.recordMetric(env, 'retrieval.result_count', results.length, {
      traceId,
      spanId,
      environment: env.ENVIRONMENT || 'unknown',
    });

    // Record top result score if available
    if (results.length > 0) {
      this.recordMetric(env, 'retrieval.top_score', results[0].score, {
        traceId,
        spanId,
        environment: env.ENVIRONMENT || 'unknown',
      });
    }
  }

  /**
   * Record a performance metric
   * @param env Environment bindings
   * @param name Metric name
   * @param value Metric value
   * @param labels Metric labels
   */
  static recordMetric(
    env: Env,
    name: string,
    value: MetricValue,
    labels: Record<string, string> = {},
  ): void {
    const timestamp = Date.now();

    // Add the metric
    this.metrics.push({
      name,
      value,
      timestamp,
      labels: {
        ...labels,
        service: 'chat-orchestrator',
        version: env.VERSION || 'unknown',
        environment: env.ENVIRONMENT || 'unknown',
      },
    });

    // Clean up old metrics if we have too many
    if (this.metrics.length > this.MAX_METRICS) {
      this.metrics = this.metrics.slice(-this.MAX_METRICS);
    }
  }

  /**
   * Flush metrics to a monitoring system
   * In a real implementation, this would send metrics to a monitoring system
   */
  static flushMetrics(): void {
    if (this.metrics.length === 0) {
      return;
    }

    this.logger.info({ metricCount: this.metrics.length }, 'Flushing metrics');

    // In a real implementation, we would send metrics to a monitoring system
    // For now, we'll just log them and clear the array

    // Clear the metrics
    this.metrics = [];
  }

  /**
   * Clean up old traces
   */
  private static cleanupOldTraces(): void {
    const traceIds = Object.keys(this.traces);

    if (traceIds.length <= this.MAX_TRACES) {
      return;
    }

    // Sort traces by start time (oldest first)
    const sortedTraceIds = traceIds.sort((a, b) => {
      return this.traces[a].startTime - this.traces[b].startTime;
    });

    // Remove oldest traces
    const tracesToRemove = sortedTraceIds.slice(0, sortedTraceIds.length - this.MAX_TRACES);

    for (const traceId of tracesToRemove) {
      delete this.traces[traceId];
    }

    this.logger.info(
      { removedCount: tracesToRemove.length, remainingCount: Object.keys(this.traces).length },
      'Cleaned up old traces',
    );
  }

  /**
   * Get a trace by ID
   * @param traceId Trace ID
   * @returns Trace data or null if not found
   */
  static getTrace(traceId: string): TraceData | null {
    return this.traces[traceId] || null;
  }

  /**
   * Get all traces
   * @returns Record of all traces
   */
  static getAllTraces(): Record<string, TraceData> {
    return { ...this.traces };
  }

  /**
   * Get recent metrics
   * @param limit Maximum number of metrics to return
   * @returns Array of recent metrics
   */
  static getRecentMetrics(limit: number = 100): Metric[] {
    return this.metrics.slice(-limit);
  }

  /**
   * Collect metrics for a conversation
   * @param state Agent state
   * @returns Metrics object
   */
  static collectMetrics(state: AgentState): Record<string, number> {
    const metrics: Record<string, number> = {
      totalExecutionTimeMs: 0,
      messageCount: state.messages.length,
      documentCount: state.docs?.length || 0,
    };

    // Add node timings
    if (state.metadata?.nodeTimings) {
      Object.entries(state.metadata.nodeTimings).forEach(([nodeName, time]) => {
        metrics[`nodeTime_${nodeName}`] = time as number;
        metrics.totalExecutionTimeMs += time as number;
      });
    }

    // Add token counts
    if (state.metadata?.tokenCounts) {
      Object.entries(state.metadata.tokenCounts).forEach(([key, count]) => {
        metrics[`tokenCount_${key}`] = count as number;
      });
    }

    return metrics;
  }

  /**
   * Create a performance dashboard URL
   * @param env Environment bindings
   * @param traceId Optional trace ID to focus on
   * @returns Dashboard URL
   */
  static createDashboardUrl(env: Env, traceId?: string): string {
    // In a real implementation, this would generate a URL to a monitoring dashboard
    const baseUrl = 'https://api.dome.cloud';
    const dashboardPath = '/monitoring/dashboard';
    const params = new URLSearchParams();

    params.append('service', 'chat-orchestrator');
    params.append('environment', env.ENVIRONMENT || 'unknown');

    if (traceId) {
      params.append('traceId', traceId);
    }

    return `${baseUrl}${dashboardPath}?${params.toString()}`;
  }

  /**
   * Clean up resources
   */
  static dispose(): void {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }

    // Flush any remaining metrics
    this.flushMetrics();
  }
}
