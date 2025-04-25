# Debugging Guide

This guide provides techniques and best practices for debugging the Chat RAG Graph solution. It covers common issues, debugging tools, and troubleshooting strategies.

## Debugging Architecture

The Chat RAG Graph solution includes several features that facilitate debugging:

1. **Comprehensive Logging**: Detailed logs at each processing step
2. **State Tracking**: Complete state history throughout graph execution
3. **Error Handling**: Robust error handling with detailed error information
4. **Observability**: Metrics and tracing for monitoring system behavior
5. **Node Timings**: Performance metrics for each node

## Logging

Logging is the primary tool for debugging the Chat RAG Graph solution. The system uses the `@dome/logging` package to provide structured logging.

### Log Levels

The system supports the following log levels:

- **debug**: Detailed debugging information
- **info**: General information about system operation
- **warn**: Warning messages that don't affect operation
- **error**: Error messages that affect operation

### Configuring Log Level

You can configure the log level using the `LOG_LEVEL` environment variable:

```
LOG_LEVEL=debug
```

### Log Structure

Logs are structured as JSON objects with the following fields:

- **timestamp**: The time the log was generated
- **level**: The log level (debug, info, warn, error)
- **message**: A human-readable message
- **context**: Additional context information
- **component**: The component that generated the log
- **node**: The node that generated the log (for node-specific logs)
- **err**: Error information (for error logs)

### Node-Specific Logging

Each node in the graph includes detailed logging:

```typescript
export const splitRewrite = async (state: AgentState): Promise<AgentState> => {
  const logger = getLogger().child({ node: 'splitRewrite' });

  logger.info(
    {
      originalQuery: lastUserMessage.content,
      messageCount: state.messages.length,
    },
    'Processing user query',
  );

  // ...

  logger.debug({ tokenCount }, 'Counted tokens in query');

  // ...

  logger.info(
    {
      executionTimeMs: executionTime,
      originalQuery,
      rewrittenQuery,
    },
    'Split/rewrite complete',
  );

  // ...
};
```

### Viewing Logs

In development, logs are output to the console. In production, logs are sent to Cloudflare's logging system and can be viewed in the Cloudflare dashboard.

## State Inspection

The state object contains all the information about the current execution. You can inspect the state at any point in the graph to understand what's happening.

### State Structure

The state object has the following structure:

```typescript
export interface AgentState {
  // User information
  userId: string;

  // Conversation history
  messages: Message[];

  // Configuration options
  options: {
    enhanceWithContext: boolean;
    maxContextItems: number;
    includeSourceInfo: boolean;
    maxTokens: number;
    temperature?: number;
  };

  // Intermediate processing data
  tasks?: {
    originalQuery?: string;
    rewrittenQuery?: string;
    requiredTools?: string[];
    toolResults?: ToolResult[];
    needsWidening?: boolean;
    wideningAttempts?: number;
    queryAnalysis?: QueryAnalysisResult;
    toolToRun?: string;
  };

  // Retrieved documents
  docs?: Document[];

  // Generated content
  generatedText?: string;

  // Metadata for tracking and debugging
  metadata?: {
    startTime: number;
    nodeTimings: Record<string, number>;
    tokenCounts: Record<string, number>;
    currentNode?: string;
    isFinalState?: boolean;
    errors?: ErrorRecord[];
    traceId?: string;
  };
}
```

### State Tracking

The graph execution engine tracks state changes throughout execution:

```typescript
// Add state change listener for logging
graph.onStateChange((oldState, newState, nodeName) => {
  // Update current node in metadata
  newState.metadata = {
    ...newState.metadata,
    currentNode: nodeName,
    isFinalState: nodeName === END,
  };

  logger.debug(
    {
      node: nodeName,
      stateChanges: getStateDiff(oldState, newState),
    },
    'State transition',
  );
});
```

The `getStateDiff` function identifies key changes between states:

```typescript
function getStateDiff(oldState: AgentState, newState: AgentState): Record<string, any> {
  const changes: Record<string, any> = {};

  // Check for new docs
  if (newState.docs?.length !== oldState.docs?.length) {
    changes.docsCount = {
      from: oldState.docs?.length || 0,
      to: newState.docs?.length || 0,
    };
  }

  // Check for new tool results
  if (newState.tasks?.toolResults?.length !== oldState.tasks?.toolResults?.length) {
    changes.toolResultsCount = {
      from: oldState.tasks?.toolResults?.length || 0,
      to: newState.tasks?.toolResults?.length || 0,
    };
  }

  // Check for generated text
  if (newState.generatedText && !oldState.generatedText) {
    changes.generatedText = true;
  }

  return changes;
}
```

## Error Handling

The system includes robust error handling at each processing step. Errors are caught, logged, and included in the state metadata.

### Error Structure

Errors are structured as follows:

```typescript
export interface ErrorRecord {
  node: string;
  message: string;
  timestamp: number;
  details?: unknown;
}
```

### Error Handling in Nodes

Each node includes error handling:

```typescript
try {
  // Node logic...
} catch (error) {
  logger.error({ err: error }, 'Error in node');

  // Return state with error information
  return {
    ...state,
    metadata: {
      ...state.metadata,
      errors: [
        ...(state.metadata?.errors || []),
        {
          node: 'nodeName',
          message: error.message,
          timestamp: Date.now(),
          details: {
            /* Additional error details */
          },
        },
      ],
    },
  };
}
```

### Graceful Degradation

The system is designed to continue execution even when errors occur. For example, if the LLM service fails, the system will provide a fallback response:

```typescript
try {
  // Call LLM to generate response
  const response = await LlmService.generateResponse(env, messages, {
    temperature: state.options.temperature || 0.7,
    maxTokens: state.options.maxTokens || 1000,
  });

  // ...
} catch (error) {
  logger.error({ err: error }, 'Error generating answer');

  // Provide fallback response
  return {
    ...state,
    generatedText:
      "I'm sorry, but I encountered an issue while generating a response. Please try again.",
    metadata: {
      ...state.metadata,
      errors: [
        ...(state.metadata?.errors || []),
        {
          node: 'generateAnswer',
          message: error.message,
          timestamp: Date.now(),
        },
      ],
    },
  };
}
```

## Observability

The system includes comprehensive observability features for monitoring and debugging.

### Tracing

The system uses a tracing system to track the execution of requests:

```typescript
// Initialize trace
const traceId = ObservabilityService.initTrace(env, userId, query);

// Start span
const spanId = ObservabilityService.startSpan(env, traceId, 'splitRewrite', { query });

// End span
ObservabilityService.endSpan(env, spanId, { executionTimeMs });

// Log event
ObservabilityService.logEvent(env, traceId, userId, 'query_rewritten', {
  originalQuery,
  rewrittenQuery,
});

// End trace
ObservabilityService.endTrace(env, traceId, { executionTimeMs: getTotalExecutionTime(state) });
```

### Metrics

The system collects metrics for monitoring performance:

```typescript
// Record metrics
env.METRICS.record({
  'llm.tokens.prompt': attributes.promptTokens,
  'llm.tokens.completion': attributes.completionTokens,
  'llm.tokens.total': attributes.promptTokens + attributes.completionTokens,
});
```

### Node Timings

The system tracks execution time for each node:

```typescript
// Update state with timing information
const endTime = performance.now();
const executionTime = endTime - startTime;

return {
  ...state,
  metadata: {
    ...state.metadata,
    nodeTimings: {
      ...state.metadata?.nodeTimings,
      nodeName: executionTime,
    },
  },
};
```

## Common Issues and Solutions

### 1. LLM Service Errors

**Symptoms:**

- Error messages from the LLM service
- Fallback responses in the output

**Possible Causes:**

- LLM service is unavailable
- Invalid input to the LLM service
- Rate limiting or quota issues

**Solutions:**

- Check the LLM service status
- Verify that the input is valid
- Check rate limits and quotas
- Implement retry logic with exponential backoff

### 2. Retrieval Issues

**Symptoms:**

- No documents retrieved
- Irrelevant documents retrieved
- Search widening attempts

**Possible Causes:**

- Vector database is unavailable
- Query is too specific or ambiguous
- No relevant documents in the knowledge base

**Solutions:**

- Check the vector database status
- Improve query rewriting
- Add more documents to the knowledge base
- Adjust relevance thresholds

### 3. Tool Execution Errors

**Symptoms:**

- Error messages from tool execution
- Missing tool results

**Possible Causes:**

- Tool is unavailable
- Invalid input to the tool
- Tool execution timeout

**Solutions:**

- Check the tool status
- Verify that the input is valid
- Increase tool execution timeout
- Implement retry logic

### 4. Performance Issues

**Symptoms:**

- Slow response times
- High resource usage

**Possible Causes:**

- Inefficient node implementations
- Large state objects
- Slow external services

**Solutions:**

- Optimize node implementations
- Reduce state size
- Implement caching
- Use more efficient algorithms

## Debugging Tools

### 1. Wrangler Dev

The Wrangler CLI provides a development server that allows you to run the system locally:

```bash
wrangler dev
```

This command starts a local development server that simulates the Cloudflare Workers environment. It provides:

- Local execution of the worker
- Live reloading on code changes
- Access to the Cloudflare Workers runtime
- Console output for logs

### 2. Wrangler Tail

The Wrangler CLI also provides a command to stream logs from a deployed worker:

```bash
wrangler tail
```

This command streams logs from a deployed worker in real-time, allowing you to monitor production behavior.

### 3. Cloudflare Dashboard

The Cloudflare dashboard provides several tools for debugging:

- **Workers**: View and manage workers
- **KV**: View and manage KV namespaces
- **D1**: View and manage D1 databases
- **Logs**: View and search logs
- **Analytics**: View performance metrics

### 4. Postman

Postman is a useful tool for testing API endpoints:

- Create and save API requests
- Set up environments for different configurations
- Automate testing with collections
- Visualize response data

## Debugging Strategies

### 1. Isolate the Issue

When debugging an issue, start by isolating it to a specific component:

1. Check if the issue occurs in a specific node
2. Check if the issue occurs with specific input
3. Check if the issue occurs in a specific environment

### 2. Reproduce the Issue

Once you've isolated the issue, try to reproduce it consistently:

1. Create a minimal test case that reproduces the issue
2. Document the steps to reproduce the issue
3. Identify the conditions under which the issue occurs

### 3. Analyze Logs

Logs are the primary source of information for debugging:

1. Set the log level to `debug` for detailed information
2. Look for error messages and warnings
3. Trace the execution flow through the logs
4. Identify any unexpected behavior

### 4. Inspect State

The state object contains all the information about the current execution:

1. Add logging to output the state at key points
2. Check if the state contains the expected data
3. Look for missing or incorrect data in the state
4. Trace state changes through the execution

### 5. Use Breakpoints

If you're debugging locally, you can use breakpoints to pause execution:

1. Add `debugger` statements to the code
2. Use the Chrome DevTools to inspect the state
3. Step through the code to understand the execution flow
4. Evaluate expressions to test hypotheses

### 6. Test in Isolation

If you suspect a specific component is causing the issue, test it in isolation:

1. Create a simple test case that exercises the component
2. Provide controlled input to the component
3. Verify that the output matches expectations
4. Identify any discrepancies

## Advanced Debugging Techniques

### 1. Custom Debugging Middleware

You can create custom middleware to add debugging information to requests:

```typescript
export const debugMiddleware = async (c: Context, next: Next): Promise<Response | void> => {
  const logger = getLogger().child({ middleware: 'debug' });

  // Add request ID for tracing
  const requestId = crypto.randomUUID();
  c.set('requestId', requestId);

  // Log request details
  logger.debug(
    {
      requestId,
      method: c.req.method,
      path: c.req.path,
      headers: Object.fromEntries(c.req.raw.headers.entries()),
    },
    'Request received',
  );

  // Process request
  const response = await next();

  // Log response details
  logger.debug(
    {
      requestId,
      status: response instanceof Response ? response.status : 200,
      headers: response instanceof Response ? Object.fromEntries(response.headers.entries()) : {},
    },
    'Response sent',
  );

  return response;
};
```

### 2. State Snapshots

You can create snapshots of the state at key points for later analysis:

```typescript
function createStateSnapshot(state: AgentState, label: string): void {
  // Create a deep copy of the state
  const snapshot = JSON.parse(JSON.stringify(state));

  // Add snapshot metadata
  snapshot.snapshotLabel = label;
  snapshot.snapshotTime = Date.now();

  // Store the snapshot
  const snapshotId = `${state.userId}:${label}:${snapshot.snapshotTime}`;
  env.KV.put(`snapshot:${snapshotId}`, JSON.stringify(snapshot));

  // Log snapshot creation
  logger.debug({ snapshotId, label }, 'Created state snapshot');
}
```

### 3. Execution Tracing

You can add detailed tracing to track the execution flow:

```typescript
async function executeWithTracing<T>(
  name: string,
  fn: () => Promise<T>,
  context: Record<string, any> = {},
): Promise<T> {
  const logger = getLogger().child({ function: name });
  const startTime = performance.now();

  logger.debug(context, `Starting ${name}`);

  try {
    const result = await fn();

    const endTime = performance.now();
    const executionTime = endTime - startTime;

    logger.debug(
      {
        ...context,
        executionTimeMs: executionTime,
      },
      `Completed ${name}`,
    );

    return result;
  } catch (error) {
    const endTime = performance.now();
    const executionTime = endTime - startTime;

    logger.error(
      {
        ...context,
        err: error,
        executionTimeMs: executionTime,
      },
      `Error in ${name}`,
    );

    throw error;
  }
}
```

## Best Practices for Debugging

1. **Use Structured Logging**: Use structured logging with context information for easier analysis.

2. **Add Detailed Error Handling**: Catch and log errors with detailed information.

3. **Include Context Information**: Include relevant context in logs and error messages.

4. **Use Consistent Naming**: Use consistent naming for components, nodes, and functions.

5. **Monitor Performance**: Track execution time and resource usage for performance issues.

6. **Test Edge Cases**: Test edge cases and error conditions to identify potential issues.

7. **Document Known Issues**: Document known issues and their workarounds.

8. **Use Version Control**: Use version control to track changes and revert if necessary.

9. **Implement Feature Flags**: Use feature flags to enable/disable features for debugging.

10. **Review Logs Regularly**: Review logs regularly to identify potential issues before they become problems.

## Conclusion

Effective debugging is essential for maintaining the reliability and performance of the Chat RAG Graph solution. By using the techniques and best practices outlined in this guide, you can quickly identify and resolve issues.

For more information on other aspects of the system, see the [Technical Documentation](../technical/README.md).
