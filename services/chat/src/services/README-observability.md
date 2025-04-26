# Chat Service Observability

This document describes the observability solution implemented for the Chat Service.

## Overview

The Chat Service uses a comprehensive observability solution that provides:

1. **Distributed Tracing**: Track requests as they flow through the system
2. **Metrics Collection**: Gather performance and operational metrics
3. **Structured Logging**: Consistent, searchable logs with correlation IDs
4. **Error Tracking**: Capture and report errors with context
5. **Performance Monitoring**: Track execution times of critical operations

## Architecture

The observability solution consists of two main components:

1. **FullObservabilityService**: The core implementation that provides all observability features
2. **ObservabilityService**: An adapter that maintains backward compatibility with existing code

### Class Diagram

```
┌─────────────────────┐     ┌─────────────────────┐
│ ObservabilityService│     │FullObservabilityService│
│ (Adapter)           │────▶│ (Implementation)    │
└─────────────────────┘     └─────────────────────┘
         ▲                           │
         │                           │
         │                           ▼
┌─────────────────────┐     ┌─────────────────────┐
│ Application Code    │     │ Metrics & Logging   │
│ (Nodes, Controllers)│     │ (@dome/metrics,     │
└─────────────────────┘     │  @dome/logging)     │
                            └─────────────────────┘
```

## Key Concepts

### Traces and Spans

- **Trace**: Represents the entire lifecycle of a request/conversation
- **Span**: Represents a single operation within a trace (e.g., a node execution)
- **Event**: A point-in-time occurrence within a span (e.g., an LLM call)

### Metrics

The system collects various metrics including:

- **Counters**: Count occurrences (e.g., number of LLM calls)
- **Histograms**: Measure distributions (e.g., execution times)
- **Gauges**: Measure current values (e.g., retrieval scores)

## Usage

### Basic Usage

Most application code should continue to use the `ObservabilityService` as before:

```typescript
// Initialize a trace
const traceId = ObservabilityService.initTrace(env, userId, initialState);

// Start a span
const spanId = ObservabilityService.startSpan(env, traceId, 'nodeName', state);

// Log an event
ObservabilityService.logEvent(env, traceId, spanId, 'eventName', { key: 'value' });

// End a span
ObservabilityService.endSpan(
  env,
  traceId,
  spanId,
  'nodeName',
  startState,
  endState,
  executionTimeMs,
);

// End a trace
ObservabilityService.endTrace(env, traceId, finalState, totalExecutionTimeMs);
```

### Advanced Usage

For new code that needs advanced features, you can use the `FullObservabilityService` directly:

```typescript
// Initialize a trace
const context = FullObservabilityService.initTrace(env, userId, initialState);

// Start a span
const spanContext = FullObservabilityService.startSpan(env, context, 'nodeName', state);

// Log an event
FullObservabilityService.logEvent(env, spanContext, 'eventName', { key: 'value' });

// End a span
FullObservabilityService.endSpan(
  env,
  spanContext,
  'nodeName',
  startState,
  endState,
  executionTimeMs,
);

// End a trace
FullObservabilityService.endTrace(env, context, finalState, totalExecutionTimeMs);

// Get trace data
const traceData = FullObservabilityService.getTrace(context.traceId);

// Create a dashboard URL
const dashboardUrl = FullObservabilityService.createDashboardUrl(env, context.traceId);
```

## Special Operations

### LLM Calls

```typescript
ObservabilityService.logLlmCall(
  env,
  traceId,
  spanId,
  'gpt-4',
  messages,
  response,
  executionTimeMs,
  {
    prompt: 100,
    completion: 50,
    total: 150,
  },
);
```

### Retrieval Operations

```typescript
ObservabilityService.logRetrieval(env, traceId, spanId, query, results, executionTimeMs);
```

## Metrics Collection

The system collects the following metrics:

### Trace Metrics

- `trace.init`: Count of trace initializations
- `trace.end`: Count of trace completions
- `trace.duration`: Histogram of trace durations

### Span Metrics

- `span.start`: Count of span starts
- `span.end`: Count of span completions
- `span.duration`: Histogram of span durations
- `node.{nodeName}.duration`: Histogram of specific node durations

### LLM Metrics

- `llm.call`: Count of LLM calls
- `llm.latency`: Histogram of LLM call latencies
- `llm.tokens.prompt`: Histogram of prompt token counts
- `llm.tokens.completion`: Histogram of completion token counts
- `llm.tokens.total`: Histogram of total token counts

### Retrieval Metrics

- `retrieval.call`: Count of retrieval operations
- `retrieval.latency`: Histogram of retrieval latencies
- `retrieval.result_count`: Histogram of retrieval result counts
- `retrieval.top_score`: Gauge of top retrieval scores

## Error Handling

Errors are tracked as events within spans and can be used to set the status of spans and traces:

```typescript
// Log an error event
ObservabilityService.logEvent(env, traceId, spanId, 'error', {
  message: 'Something went wrong',
  code: 'ERR_SOMETHING',
  stack: error.stack,
});
```

## Dashboard Integration

The system can generate URLs to monitoring dashboards:

```typescript
const dashboardUrl = FullObservabilityService.createDashboardUrl(env, traceId);
```

## Future Enhancements

Potential future enhancements include:

1. Integration with OpenTelemetry for standardized tracing
2. Export to external monitoring systems (Prometheus, Datadog, etc.)
3. Real-time alerting based on error rates or performance degradation
4. Sampling strategies for high-volume production environments
5. Correlation with user feedback and satisfaction metrics
