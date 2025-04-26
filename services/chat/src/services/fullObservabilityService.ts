import { getLogger } from '@dome/logging';
import { AgentState } from '../types';
import { getUserId } from '../utils/stateUtils';
import { ServiceMetrics } from '@dome/metrics';

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
 */
export class FullObservabilityService {
  private static readonly logger = getLogger().child({ component: 'FullObservabilityService' });
  private static readonly metrics = new ServiceMetrics('chat');

  // Trace and span storage for in-memory correlation
  private static traces: Map<string, {
    userId: string;
    startTime: number;
    endTime?: number;
    spans: Map<string, {
      name: string;
      startTime: number;
      endTime?: number;
      status: SpanStatus;
      events: Array<{
        name: string;
        timestamp: number;
        attributes: Record<string, any>;
      }>;
    }>;
    status: SpanStatus;
  }> = new Map();

  /**
   * Initialize a trace for a conversation
   * @param env Environment bindings
   * @param userId User ID
   * @param initialState Initial agent state
   * @returns Trace context
   */
  static initTrace(env: Env, userId: string, initialState: AgentState): TraceContext {
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
    this.logger.info(
      {
        traceId,
        userId,
        messageCount: initialState.messages?.length || 0,
        environment: env.ENVIRONMENT || 'unknown',
      },
      'Initialized trace',
    );

    // Record trace initialization metric
    this.metrics.counter('trace.init', 1, {
      traceId,
      userId,
      environment: env.ENVIRONMENT || 'unknown',
      service: 'chat-orchestrator',
    });

    return { traceId, spanId };
  }

  /**
   * Start a span for a node execution
   * @param env Environment bindings
   * @param context Trace context
   * @param spanName Span name
   * @param state Current agent state
   * @returns Updated trace context with new span ID
   */
  static startSpan(
    env: Env,
    context: TraceContext,
    spanName: string,
    state: AgentState,
  ): TraceContext {
    const { traceId, spanId: parentSpanId } = context;
    const spanId = `${traceId}-${spanName}-${Date.now()}`;
    const startTime = Date.now();
    const userId = getUserId(state);

    // Get the trace
    const trace = this.traces.get(traceId);
    if (!trace) {
      this.logger.warn({ traceId, spanName }, 'Attempted to start span for unknown trace');
      return { traceId, spanId, parentSpanId };
    }

    // Create the span
    trace.spans.set(spanId, {
      name: spanName,
      startTime,
      status: 'unset',
      events: [],
    });

    // Record span start in logs
    this.logger.info(
      {
        traceId,
        spanId,
        parentSpanId,
        spanName,
        userId,
      },
      'Started span',
    );

    // Record span start metric
    this.metrics.counter('span.start', 1, {
      traceId,
      spanId,
      spanName,
      userId,
      environment: env.ENVIRONMENT || 'unknown',
      service: 'chat-orchestrator',
    });

    return { traceId, spanId, parentSpanId };
  }

  /**
   * End a span for a node execution
   * @param env Environment bindings
   * @param context Trace context
   * @param spanName Span name
   * @param startState State before node execution
   * @param endState State after node execution
   * @param executionTimeMs Execution time in milliseconds
   */
  static endSpan(
    env: Env,
    context: TraceContext,
    spanName: string,
    startState: AgentState,
    endState: AgentState,
    executionTimeMs: number,
  ): void {
    const { traceId, spanId } = context;
    const endTime = Date.now();
    const userId = getUserId(startState);

    // Get the trace and span
    const trace = this.traces.get(traceId);
    if (!trace) {
      this.logger.warn({ traceId, spanId, spanName }, 'Attempted to end span for unknown trace');
      return;
    }

    const span = trace.spans.get(spanId);
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
        this.logEvent(env, context, 'error', {
          message: error.message,
          timestamp: error.timestamp,
          node: error.node || spanName,
        });
      }
    }

    // Record span end in logs
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

    // Record span metrics
    this.metrics.counter('span.end', 1, {
      traceId,
      spanId,
      spanName,
      userId,
      environment: env.ENVIRONMENT || 'unknown',
      service: 'chat-orchestrator',
      status: span.status,
    });

    // this.metrics.histogram('span.duration', executionTimeMs, {
    //   traceId,
    //   spanId,
    //   spanName,
    //   userId,
    //   environment: env.ENVIRONMENT || 'unknown',
    //   service: 'chat-orchestrator',
    // });
    //
    // // Record node-specific metrics if this is a node execution
    // this.metrics.histogram(`node.${spanName}.duration`, executionTimeMs, {
    //   traceId,
    //   userId,
    //   environment: env.ENVIRONMENT || 'unknown',
    //   service: 'chat-orchestrator',
    // });
  }

  /**
   * Log an event within a span
   * @param env Environment bindings
   * @param context Trace context
   * @param eventName Event name
   * @param data Event data
   */
  static logEvent(
    env: Env,
    context: TraceContext,
    eventName: string,
    data: Record<string, any>,
  ): void {
    const { traceId, spanId } = context;
    const timestamp = Date.now();

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

    // Add the event
    span.events.push({
      name: eventName,
      timestamp,
      attributes: data,
    });

    // Record event in logs
    this.logger.info(
      {
        traceId,
        spanId,
        eventName,
        ...data,
      },
      'Logged event',
    );

    // Record event metric
    this.metrics.counter('event', 1, {
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
   * @param context Trace context
   * @param finalState Final agent state
   * @param totalExecutionTimeMs Total execution time in milliseconds
   */
  static endTrace(
    env: Env,
    context: TraceContext,
    finalState: AgentState,
    totalExecutionTimeMs: number,
  ): void {
    const { traceId } = context;
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

    // Record trace metrics
    this.metrics.counter('trace.end', 1, {
      traceId,
      userId,
      environment: env.ENVIRONMENT || 'unknown',
      service: 'chat-orchestrator',
      status: trace.status,
    });

    // this.metrics.histogram('trace.duration', totalExecutionTimeMs, {
    //   traceId,
    //   userId,
    //   environment: env.ENVIRONMENT || 'unknown',
    //   service: 'chat-orchestrator',
    // });
    //
    // // Record node timing metrics
    // if (finalState.metadata?.nodeTimings) {
    //   for (const [nodeName, duration] of Object.entries(finalState.metadata.nodeTimings)) {
    //     this.metrics.histogram('node.duration', duration as number, {
    //       traceId,
    //       nodeName,
    //       userId,
    //       environment: env.ENVIRONMENT || 'unknown',
    //       service: 'chat-orchestrator',
    //     });
    //   }
    // }
    //
    // // Record token count metrics
    // if (finalState.metadata?.tokenCounts) {
    //   for (const [tokenType, count] of Object.entries(finalState.metadata.tokenCounts)) {
    //     this.metrics.histogram('token.count', count as number, {
    //       traceId,
    //       tokenType,
    //       userId,
    //       environment: env.ENVIRONMENT || 'unknown',
    //       service: 'chat-orchestrator',
    //     });
    //   }
    // }

    // Clean up the trace after a delay to allow for any late spans
    setTimeout(() => {
      this.traces.delete(traceId);
    }, 60000); // 1 minute
  }

  /**
   * Log an LLM call
   * @param env Environment bindings
   * @param context Trace context
   * @param model Model name
   * @param messages Messages sent to the LLM
   * @param response Response from the LLM
   * @param executionTimeMs Execution time in milliseconds
   * @param tokenCounts Token counts
   */
  static logLlmCall(
    env: Env,
    context: TraceContext,
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
    this.logEvent(env, context, 'llm_call', {
      model,
      messageCount: messages.length,
      responseLength: response.length,
      executionTimeMs,
      tokenCounts,
    });

    // Record LLM metrics
    this.metrics.counter('llm.call', 1, {
      traceId: context.traceId,
      spanId: context.spanId,
      model,
      environment: env.ENVIRONMENT || 'unknown',
      service: 'chat-orchestrator',
    });

    // this.metrics.histogram('llm.latency', executionTimeMs, {
    //   traceId: context.traceId,
    //   spanId: context.spanId,
    //   model,
    //   environment: env.ENVIRONMENT || 'unknown',
    //   service: 'chat-orchestrator',
    // });
    //
    // if (tokenCounts) {
    //   if (tokenCounts.prompt) {
    //     this.metrics.histogram('llm.tokens.prompt', tokenCounts.prompt, {
    //       traceId: context.traceId,
    //       spanId: context.spanId,
    //       model,
    //       environment: env.ENVIRONMENT || 'unknown',
    //       service: 'chat-orchestrator',
    //     });
    //   }
    //
    //   if (tokenCounts.completion) {
    //     this.metrics.histogram('llm.tokens.completion', tokenCounts.completion, {
    //       traceId: context.traceId,
    //       spanId: context.spanId,
    //       model,
    //       environment: env.ENVIRONMENT || 'unknown',
    //       service: 'chat-orchestrator',
    //     });
    //   }
    //
    //   if (tokenCounts.total) {
    //     this.metrics.histogram('llm.tokens.total', tokenCounts.total, {
    //       traceId: context.traceId,
    //       spanId: context.spanId,
    //       model,
    //       environment: env.ENVIRONMENT || 'unknown',
    //       service: 'chat-orchestrator',
    //     });
    //   }
    // }
  }

  /**
   * Log a retrieval operation
   * @param env Environment bindings
   * @param context Trace context
   * @param query Query used for retrieval
   * @param results Results of the retrieval
   * @param executionTimeMs Execution time in milliseconds
   */
  static logRetrieval(
    env: Env,
    context: TraceContext,
    query: string,
    results: Array<{ id: string; score: number }>,
    executionTimeMs: number,
  ): void {
    // Log the event
    this.logEvent(env, context, 'retrieval', {
      query,
      resultCount: results.length,
      topResults: results.slice(0, 3),
      executionTimeMs,
    });

    // Record retrieval metrics
    this.metrics.counter('retrieval.call', 1, {
      traceId: context.traceId,
      spanId: context.spanId,
      environment: env.ENVIRONMENT || 'unknown',
      service: 'chat-orchestrator',
    });

    // this.metrics.histogram('retrieval.latency', executionTimeMs, {
    //   traceId: context.traceId,
    //   spanId: context.spanId,
    //   environment: env.ENVIRONMENT || 'unknown',
    //   service: 'chat-orchestrator',
    // });
    //
    // this.metrics.histogram('retrieval.result_count', results.length, {
    //   traceId: context.traceId,
    //   spanId: context.spanId,
    //   environment: env.ENVIRONMENT || 'unknown',
    //   service: 'chat-orchestrator',
    // });

    // Record top result score if available
    if (results.length > 0) {
      this.metrics.gauge('retrieval.top_score', results[0].score, {
        traceId: context.traceId,
        spanId: context.spanId,
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
    // const baseUrl = env.OBSERVABILITY_DASHBOARD_URL || 'https://api.dome.cloud';
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
