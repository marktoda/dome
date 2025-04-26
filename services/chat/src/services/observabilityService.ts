import { getLogger } from '@dome/logging';
import { AgentState } from '../types';
import { getUserId } from '../utils/stateUtils';
import { FullObservabilityService, TraceContext } from './fullObservabilityService';

/**
 * Service for observability and tracing
 * This is an adapter that maintains the same API as the old ObservabilityService
 * but uses the new FullObservabilityService internally
 */
export class ObservabilityService {
  private static readonly logger = getLogger();

  /**
   * Initialize a trace for a conversation
   * @param env Environment bindings
   * @param userId User ID
   * @param initialState Initial agent state
   * @returns Trace ID
   */
  static initTrace(env: Env, userId: string, initialState: AgentState): string {
    const context = FullObservabilityService.initTrace(env, userId, initialState);
    return context.traceId;
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
    // Create a context object from the traceId
    const context: TraceContext = { traceId, spanId: '' };
    
    // Call the new service
    const newContext = FullObservabilityService.startSpan(env, context, nodeName, state);
    
    // Return just the spanId to maintain the old API
    return newContext.spanId;
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
    // Create a context object
    const context: TraceContext = { traceId, spanId };
    
    // Call the new service
    FullObservabilityService.endSpan(
      env,
      context,
      nodeName,
      startState,
      endState,
      executionTimeMs,
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
    // Create a context object
    const context: TraceContext = { traceId, spanId };
    
    // Call the new service
    FullObservabilityService.logEvent(env, context, eventName, data);
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
    // Create a context object
    const context: TraceContext = { traceId, spanId: '' };
    
    // Call the new service
    FullObservabilityService.endTrace(env, context, finalState, totalExecutionTimeMs);
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
    // Create a context object
    const context: TraceContext = { traceId, spanId };
    
    // Call the new service
    FullObservabilityService.logLlmCall(
      env,
      context,
      model,
      messages,
      response,
      executionTimeMs,
      tokenCounts,
    );
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
    // Create a context object
    const context: TraceContext = { traceId, spanId };
    
    // Call the new service
    FullObservabilityService.logRetrieval(env, context, query, results, executionTimeMs);
  }

  /**
   * Collect metrics for a conversation
   * @param state Agent state
   * @returns Metrics object
   */
  static collectMetrics(state: AgentState): Record<string, number> {
    return FullObservabilityService.collectMetrics(state);
  }
}
