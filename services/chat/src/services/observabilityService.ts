import { MetricsService, getLogger } from '@dome/common';
import { AgentState } from '../types';
import { getUserId } from '../utils/stateUtils';

/**
 * Trace context interface
 */
export interface TraceContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
}

/**
 * Span status type
 */
export type SpanStatus = 'success' | 'error' | 'unset';

/**
 * Comprehensive service for observability, tracing, and metrics
 * This is a consolidated service that merges the functionality of
 * the previous ObservabilityService and FullObservabilityService
 */
export class ObservabilityService {
  private static readonly logger = getLogger().child({ component: 'ObservabilityService' });
  private static readonly metrics = new MetricsService();
  private static readonly MAX_STRING_LENGTH = 200;
  private static readonly MAX_ARRAY_LENGTH = 10;
  private static readonly MAX_OBJECT_KEYS = 20;

  // Trace and span storage for in-memory correlation
  private static traces: Map<
    string,
    {
      userId: string;
      startTime: number;
      endTime?: number;
      spans: Map<
        string,
        {
          name: string;
          startTime: number;
          endTime?: number;
          status: SpanStatus;
          events: Array<{
            name: string;
            timestamp: number;
            attributes: Record<string, any>;
          }>;
        }
      >;
      status: SpanStatus;
    }
  > = new Map();

  /**
   * Sanitize potentially large or deeply-nested objects before they are sent
   * to the logger. This prevents oversized log entries that can overflow the
   * 256 KB Cloudflare log limit.
   */
  private static sanitizeForLog(value: unknown, depth: number = 0): unknown {
    if (value === null || value === undefined) return value;

    // Primitive values can be returned as-is (except long strings)
    if (typeof value === 'string') {
      return value.length > this.MAX_STRING_LENGTH
        ? `${value.substring(0, this.MAX_STRING_LENGTH)}…[truncated ${value.length - this.MAX_STRING_LENGTH
        } chars]`
        : value;
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
      return value;
    }

    // Limit recursion depth to avoid excessive processing
    if (depth >= 2) {
      return '[truncated]';
    }

    if (Array.isArray(value)) {
      const sliced = value
        .slice(0, this.MAX_ARRAY_LENGTH)
        .map(v => this.sanitizeForLog(v, depth + 1));
      if (value.length > this.MAX_ARRAY_LENGTH) {
        sliced.push(`…(${value.length - this.MAX_ARRAY_LENGTH} more items)`);
      }
      return sliced;
    }

    if (typeof value === 'object') {
      const obj: Record<string, unknown> = {};
      const keys = Object.keys(value as Record<string, unknown>);
      for (const key of keys.slice(0, this.MAX_OBJECT_KEYS)) {
        obj[key] = this.sanitizeForLog((value as Record<string, unknown>)[key], depth + 1);
      }
      if (keys.length > this.MAX_OBJECT_KEYS) {
        obj['…'] = `(${keys.length - this.MAX_OBJECT_KEYS} more keys)`;
      }
      return obj;
    }

    // Fallback – stringify unknown types
    try {
      return String(value);
    } catch {
      return '[unserializable]';
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
    const spanId = `root-${traceId}`;
    const startTime = Date.now();

    // Create trace in memory
    this.traces.set(traceId, {
      userId,
      startTime,
      spans: new Map(),
      status: 'unset',
    });

    // Record trace initialization in logs
    this.logger.debug(
      {
        traceId,
        userId,
        messageCount: initialState.messages?.length || 0,
        environment: env.ENVIRONMENT || 'unknown',
      },
      'Initialized trace',
    );

    // Record trace initialization metric
    this.metrics.increment('trace.init', 1, {
      traceId,
      userId,
      environment: env.ENVIRONMENT || 'unknown',
      service: 'chat-orchestrator',
    });

    return traceId;
  }

  /**
   * Start a span for a node execution
   * @param env Environment bindings
   * @param traceId Trace ID
   * @param nodeName Node name
   * @param state Current agent state
   * @returns Span ID
   */
  static startSpan(env: Env, traceId: string, nodeName: string, state: AgentState): string {
    const context: TraceContext = { traceId, spanId: '' };
    const parentSpanId = context.spanId;
    const spanId = `${traceId}-${nodeName}-${Date.now()}`;
    const startTime = Date.now();
    const userId = getUserId(state);

    // Get the trace
    const trace = this.traces.get(traceId);
    if (!trace) {
      this.logger.warn(
        { traceId, spanName: nodeName },
        'Attempted to start span for unknown trace',
      );
      return spanId;
    }

    // Create the span
    trace.spans.set(spanId, {
      name: nodeName,
      startTime,
      status: 'unset',
      events: [],
    });

    // Record span start in logs
    this.logger.debug(
      {
        traceId,
        spanId,
        parentSpanId,
        spanName: nodeName,
        userId,
      },
      'Started span',
    );

    // Record span start metric
    this.metrics.increment('span.start', 1, {
      traceId,
      spanId,
      spanName: nodeName,
      userId,
      environment: env.ENVIRONMENT || 'unknown',
      service: 'chat-orchestrator',
    });

    return spanId;
  }

  /**
   * End a span for a node execution
   * @param env Environment bindings
   * @param traceId Trace ID
   * @param spanId Span ID
   * @param nodeName Node name
   * @param startState State before node execution
   * @param endState State after node execution
   * @param executionTimeMs Execution time in milliseconds
   */
  static endSpan(
    env: Env,
    traceId: string,
    spanId: string,
    nodeName: string,
    startState: AgentState,
    endState: AgentState,
    executionTimeMs: number,
  ): void {
    const context: TraceContext = { traceId, spanId };
    const endTime = Date.now();
    const userId = getUserId(startState);

    // Get the trace and span
    const trace = this.traces.get(traceId);
    if (!trace) {
      this.logger.warn(
        { traceId, spanId, spanName: nodeName },
        'Attempted to end span for unknown trace',
      );
      return;
    }

    const span = trace.spans.get(spanId);
    if (!span) {
      this.logger.warn({ traceId, spanId, spanName: nodeName }, 'Attempted to end unknown span');
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
          node: error.node || nodeName,
        });
      }
    }

    // Record span end in logs
    this.logger.debug(
      {
        traceId,
        spanId,
        spanName: nodeName,
        executionTimeMs,
        status: span.status,
      },
      'Ended span',
    );

    // Record span metrics
    this.metrics.increment('span.end', 1, {
      traceId,
      spanId,
      spanName: nodeName,
      userId,
      environment: env.ENVIRONMENT || 'unknown',
      service: 'chat-orchestrator',
      status: span.status,
    });
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
    const context: TraceContext = { traceId, spanId };
    const timestamp = Date.now();

    // Sanitize attributes to ensure we don't exceed log payload limits
    const safeData = this.sanitizeForLog(data) as Record<string, unknown>;

    // Get the trace and span
    const trace = this.traces.get(traceId);
    if (!trace) {
      this.logger.warn({ traceId, spanId, eventName }, 'Attempted to log event for unknown trace');
      return;
    }

    const span = trace.spans.get(spanId);
    if (!span) {
      this.logger.warn({ traceId, spanId, eventName }, 'Attempted to log event for unknown span');
      return;
    }

    // Add the event (store sanitized form as well – original data is not required for observability)
    span.events.push({
      name: eventName,
      timestamp,
      attributes: safeData,
    });

    // Record event in logs (sanitized)
    this.logger.debug(
      {
        traceId,
        spanId,
        eventName,
        ...safeData,
      },
      'Logged event',
    );

    // Record event metric
    this.metrics.increment('event', 1, {
      traceId,
      spanId,
      eventName,
      environment: env.ENVIRONMENT || 'unknown',
      service: 'chat-orchestrator',
    });
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
    const context: TraceContext = { traceId, spanId: '' };
    const endTime = Date.now();
    const userId = getUserId(finalState);

    // Get the trace
    const trace = this.traces.get(traceId);
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

    // Record trace end in logs
    this.logger.debug(
      {
        traceId,
        totalExecutionTimeMs,
        nodeTimings: finalState.metadata?.nodeTimings,
        tokenCounts: finalState.metadata?.tokenCounts,
        status: trace.status,
      },
      'Ended trace',
    );

    // Record trace metrics
    this.metrics.increment('trace.end', 1, {
      traceId,
      userId,
      environment: env.ENVIRONMENT || 'unknown',
      service: 'chat-orchestrator',
      status: trace.status,
    });

    // Clean up the trace after a delay to allow for any late spans
    setTimeout(() => {
      this.traces.delete(traceId);
    }, 60000); // 1 minute
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
    this.metrics.increment('llm.call', 1, {
      traceId,
      spanId,
      model,
      environment: env.ENVIRONMENT || 'unknown',
      service: 'chat-orchestrator',
    });
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
    this.metrics.increment('retrieval.call', 1, {
      traceId,
      spanId,
      environment: env.ENVIRONMENT || 'unknown',
      service: 'chat-orchestrator',
    });

    // Record top result score if available
    if (results.length > 0) {
      this.metrics.gauge('retrieval.top_score', results[0].score, {
        traceId,
        spanId,
        environment: env.ENVIRONMENT || 'unknown',
        service: 'chat-orchestrator',
      });
    }
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
   * Get a trace by ID
   * @param traceId Trace ID
   * @returns Trace data or null if not found
   */
  static getTrace(traceId: string): any {
    const trace = this.traces.get(traceId);
    if (!trace) return null;

    // Convert Maps to objects for serialization
    const spans: Record<string, any> = {};
    trace.spans.forEach((span, spanId) => {
      spans[spanId] = { ...span };
    });

    return {
      ...trace,
      spans,
    };
  }

  /**
   * Export all traces for debugging
   * @returns All traces
   */
  static exportTraces(): Record<string, any> {
    const result: Record<string, any> = {};

    this.traces.forEach((trace, traceId) => {
      const spans: Record<string, any> = {};
      trace.spans.forEach((span, spanId) => {
        spans[spanId] = { ...span };
      });

      result[traceId] = {
        ...trace,
        spans,
      };
    });

    return result;
  }

  /**
   * Clean up resources
   */
  static dispose(): void {
    // Clear all traces
    this.traces.clear();
  }
}
