# Chat RAG Graph Technical Documentation

This document provides comprehensive technical documentation for the Chat RAG Graph implementation, including architecture, components, configuration options, and troubleshooting guides.

## 1. Architecture Overview

The Chat RAG Graph implementation is based on a state machine architecture that processes user queries through a series of specialized nodes. Each node performs a specific function in the conversation flow, with conditional routing between nodes based on the state of the conversation.

### 1.1 High-Level Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│                 │     │                 │     │                 │
│   dome-api      │────▶│ chat-orchestrator│────▶│  External       │
│   (Frontend)    │     │   (Graph Engine) │     │  Services       │
│                 │     │                 │     │                 │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                               │  ▲
                               │  │
                               ▼  │
                        ┌─────────────────┐
                        │                 │
                        │  D1 Database    │
                        │  (Checkpoints)  │
                        │                 │
                        └─────────────────┘
```

### 1.2 Key Components

1. **dome-api**: Frontend API that receives user requests and forwards them to the chat-orchestrator.
2. **chat-orchestrator**: Core service that implements the RAG graph and processes user queries.
3. **D1 Database**: Stores conversation checkpoints for resuming conversations.
4. **External Services**: Including search services, LLM providers, and tool integrations.

### 1.3 Data Flow

1. User sends a query to dome-api
2. dome-api validates the request and forwards it to chat-orchestrator
3. chat-orchestrator initializes the graph with the user's state
4. The graph processes the query through various nodes
5. Results are streamed back to the user via dome-api
6. Conversation state is checkpointed in D1 for future reference

## 2. Graph Components

### 2.1 State Definition

The core state interface that flows through the graph:

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
    queryAnalysis?: QueryAnalysis;
    requiredTools?: string[];
    toolResults?: ToolResult[];
    needsWidening?: boolean;
    wideningAttempts?: number;
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
    errors?: Error[];
  };
}
```

### 2.2 Node Types

The graph consists of the following node types:

1. **Split/Rewrite Node**: Analyzes and potentially rewrites the user query
2. **Retrieve Node**: Fetches relevant documents based on the query
3. **Route After Retrieve Node**: Determines next steps after retrieval
4. **Dynamic Widen Node**: Adjusts search parameters for better retrieval
5. **Tool Router Node**: Determines which tool to use
6. **Run Tool Node**: Executes the selected tool
7. **Generate Answer Node**: Generates the final response

### 2.3 Graph Structure

```
                           ┌───────────────┐
                           │               │
                           │     Start     │
                           │               │
                           └───────┬───────┘
                                   │
                                   ▼
                           ┌───────────────┐
                           │               │
                           │ Split/Rewrite │
                           │               │
                           └───────┬───────┘
                                   │
                                   ▼
                           ┌───────────────┐
                           │               │
                           │   Retrieve    │
                           │               │
                           └───────┬───────┘
                                   │
                                   ▼
                           ┌───────────────┐
                           │  Route After  │
┌──────────────────────────┤   Retrieve    ├───────────────┐
│                          │               │               │
│                          └───────────────┘               │
│                                  │                       │
▼                                  ▼                       ▼
┌───────────────┐          ┌───────────────┐      ┌───────────────┐
│               │          │               │      │               │
│ Dynamic Widen │          │  Tool Router  │      │    Generate   │
│               │          │               │      │    Answer     │
└───────┬───────┘          └───────┬───────┘      │               │
        │                          │              └───────────────┘
        │                          ▼
        │                  ┌───────────────┐
        │                  │               │
        │                  │   Run Tool    │
        │                  │               │
        │                  └───────┬───────┘
        │                          │
        └──────────────────────────┘
```

## 3. Node Implementations

### 3.1 Split/Rewrite Node

The Split/Rewrite node analyzes the user's query and potentially rewrites it to improve retrieval.

**Key Functions:**
- Extract the last user message
- Analyze query complexity
- Rewrite multi-part questions
- Expand ambiguous references
- Track token usage

**Configuration Options:**
- `enableQueryRewriting`: Whether to enable query rewriting (default: true)
- `complexityThreshold`: Threshold for determining complex queries (default: 0.7)

### 3.2 Retrieve Node

The Retrieve node fetches relevant documents based on the query.

**Key Functions:**
- Search for relevant documents
- Rank and filter results
- Track token usage
- Handle search errors

**Configuration Options:**
- `maxContextItems`: Maximum number of documents to retrieve (default: 10)
- `minRelevanceScore`: Minimum relevance score for documents (default: 0.7)
- `includeMetadata`: Whether to include document metadata (default: true)

### 3.3 Route After Retrieve Node

The Route After Retrieve node determines the next step after retrieval.

**Key Functions:**
- Check if search widening is needed
- Detect tool intent
- Route to appropriate next node

**Routing Options:**
- `widen`: Route to Dynamic Widen node if few results are found
- `tool`: Route to Tool Router if tool intent is detected
- `answer`: Route to Generate Answer node (default)

### 3.4 Dynamic Widen Node

The Dynamic Widen node adjusts search parameters to widen the retrieval scope.

**Key Functions:**
- Increment widening attempts
- Adjust search parameters
- Apply different widening strategies

**Widening Strategies:**
- `semantic`: Expand search to include semantically related terms
- `temporal`: Adjust date ranges to include more historical content
- `relevance`: Progressively reduce relevance thresholds
- `category`: Expand to related categories
- `synonym`: Include synonyms and related terms

### 3.5 Tool Router Node

The Tool Router node determines which tool to use.

**Key Functions:**
- Analyze query for tool intent
- Select appropriate tool
- Extract tool parameters
- Handle ambiguous tool requests

**Available Tools:**
- `calculator`: Performs mathematical calculations
- `calendar`: Retrieves calendar information
- `weather`: Retrieves weather information
- `web_search`: Searches the web for information

### 3.6 Run Tool Node

The Run Tool node executes the selected tool.

**Key Functions:**
- Execute the selected tool
- Handle tool errors
- Format tool results
- Track tool usage

**Error Handling:**
- Retry logic with exponential backoff
- Fallback mechanisms for tool failures
- Detailed error reporting

### 3.7 Generate Answer Node

The Generate Answer node generates the final response.

**Key Functions:**
- Format context from retrieved documents
- Build prompt with conversation history
- Call LLM for response generation
- Format response with source attribution

**Configuration Options:**
- `maxTokens`: Maximum tokens for the response (default: 1000)
- `temperature`: Temperature for response generation (default: 0.7)
- `includeSourceInfo`: Whether to include source information (default: true)

## 4. Streaming Implementation

The Chat RAG Graph implementation supports streaming responses to the client.

### 4.1 Stream Format

Responses are streamed using Server-Sent Events (SSE) with the following event types:

- `workflow_step`: Indicates a step in the workflow has completed
- `token`: Contains a token of the generated response
- `sources`: Contains information about the sources used
- `done`: Indicates the response is complete

### 4.2 Stream Transformation

The streaming implementation transforms the graph execution into a stream of events:

```typescript
async function transformToStream(graph, initialState) {
  // Create a new ReadableStream
  const stream = new ReadableStream({
    async start(controller) {
      try {
        // Execute the graph with callbacks for each step
        await graph.invoke(initialState, {
          onNodeStart: (nodeName) => {
            controller.enqueue(`event: workflow_step\ndata: {"node": "${nodeName}", "status": "start"}\n\n`);
          },
          onNodeComplete: (nodeName, result) => {
            controller.enqueue(`event: workflow_step\ndata: {"node": "${nodeName}", "status": "complete"}\n\n`);
          },
          onToken: (token) => {
            controller.enqueue(`event: token\ndata: {"token": "${token}"}\n\n`);
          },
          onSources: (sources) => {
            controller.enqueue(`event: sources\ndata: ${JSON.stringify({ sources })}\n\n`);
          },
        });
        
        // Signal completion
        controller.enqueue(`event: done\ndata: {}\n\n`);
        controller.close();
      } catch (error) {
        // Handle errors
        controller.enqueue(`event: error\ndata: {"message": "${error.message}"}\n\n`);
        controller.close();
      }
    }
  });
  
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
```

## 5. Checkpointing

The Chat RAG Graph implementation uses a D1 database for checkpointing conversation state.

### 5.1 Checkpoint Schema

```sql
CREATE TABLE IF NOT EXISTS checkpoints (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_checkpoints_user_id ON checkpoints(user_id);
```

### 5.2 Checkpoint Operations

- **Initialize**: Set up the checkpoint database
- **Get**: Retrieve a checkpoint by ID
- **Put**: Store a checkpoint
- **List**: List checkpoints for a user
- **Delete**: Remove a checkpoint

### 5.3 Checkpoint Frequency

Checkpoints are created at the following points:

- After completing a conversation turn
- Before executing long-running operations
- When the user explicitly requests a checkpoint

## 6. Configuration Options

### 6.1 Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `CHAT_MODEL` | LLM model to use | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` |
| `MAX_TOKENS` | Maximum tokens for responses | `1000` |
| `DEFAULT_TEMPERATURE` | Default temperature for responses | `0.7` |
| `ENABLE_CONTEXT` | Whether to enable RAG context | `true` |
| `MAX_CONTEXT_ITEMS` | Maximum context items to retrieve | `10` |
| `INCLUDE_SOURCE_INFO` | Whether to include source information | `true` |
| `ENABLE_TOOLS` | Whether to enable tool usage | `true` |
| `ENABLE_CHECKPOINTING` | Whether to enable checkpointing | `true` |

### 6.2 Runtime Configuration

The following options can be configured at runtime:

```typescript
interface ChatOptions {
  enhanceWithContext: boolean;
  maxContextItems: number;
  includeSourceInfo: boolean;
  maxTokens: number;
  temperature?: number;
  enableTools?: boolean;
  enableCheckpointing?: boolean;
}
```

## 7. Observability

### 7.1 Logging

The Chat RAG Graph implementation uses structured logging with the following components:

- **Request Context**: User ID, request ID, timestamp
- **Node Execution**: Node name, execution time, input/output summary
- **LLM Calls**: Model, prompt size, response size, tokens used
- **Retrieval**: Query, results count, retrieval time
- **Tool Usage**: Tool name, input parameters, execution time
- **Errors**: Error type, message, stack trace

### 7.2 Metrics

The following metrics are collected:

- **Request Rate**: Requests per minute
- **Error Rate**: Errors per minute
- **Latency**: Response time percentiles (p50, p95, p99)
- **Token Usage**: Tokens used per request
- **Retrieval Performance**: Documents retrieved, relevance scores
- **Tool Usage**: Tool invocations, success rate
- **Checkpoint Operations**: Checkpoint reads/writes

### 7.3 Tracing

Distributed tracing is implemented using the following spans:

- **Request**: Overall request processing
- **Node Execution**: Individual node execution
- **LLM Call**: LLM API calls
- **Retrieval**: Document retrieval
- **Tool Execution**: Tool execution
- **Checkpoint**: Checkpoint operations

## 8. Error Handling

### 8.1 Error Types

- **ValidationError**: Invalid input parameters
- **RetrievalError**: Error retrieving documents
- **LlmError**: Error calling the LLM
- **ToolError**: Error executing a tool
- **CheckpointError**: Error with checkpointing
- **TimeoutError**: Operation timed out

### 8.2 Error Responses

Errors are returned to the client in the following format:

```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable error message"
  }
}
```

### 8.3 Fallback Mechanisms

- **LLM Fallback**: If the primary LLM fails, fall back to a simpler model
- **Retrieval Fallback**: If retrieval fails, proceed without context
- **Tool Fallback**: If a tool fails, provide an error message in the response
- **Checkpoint Fallback**: If checkpointing fails, continue without checkpointing

## 9. Performance Optimization

### 9.1 Caching

- **Document Cache**: Cache frequently retrieved documents
- **LLM Response Cache**: Cache LLM responses for identical inputs
- **Tool Result Cache**: Cache tool results for identical parameters

### 9.2 Token Optimization

- **Context Pruning**: Remove irrelevant context to save tokens
- **Message Summarization**: Summarize long conversation history
- **Prompt Compression**: Use efficient prompt templates

### 9.3 Parallel Processing

- **Parallel Retrieval**: Execute multiple retrieval operations in parallel
- **Parallel Tool Execution**: Execute multiple tools in parallel
- **Background Checkpointing**: Perform checkpointing in the background

## 10. Security Considerations

### 10.1 Authentication

- All requests require a valid user ID
- Admin endpoints require API key authentication

### 10.2 Data Protection

- User data is isolated by user ID
- Sensitive information is not logged
- Checkpoints are encrypted at rest

### 10.3 Rate Limiting

- Requests are rate-limited by user ID
- LLM calls are rate-limited to prevent abuse
- Tool usage is monitored for unusual patterns

## 11. Extending the System

### 11.1 Adding New Nodes

To add a new node to the graph:

1. Create a new node function in `services/chat-orchestrator/src/nodes/`
2. Update the graph definition in `services/chat-orchestrator/src/graph.ts`
3. Add tests for the new node

Example node function:

```typescript
export const myNewNode = async (state: AgentState): Promise<AgentState> => {
  const logger = getLogger().child({ node: 'myNewNode' });
  const startTime = performance.now();
  
  // Node implementation
  
  const endTime = performance.now();
  const executionTime = endTime - startTime;
  
  return {
    ...state,
    metadata: {
      ...state.metadata,
      nodeTimings: {
        ...state.metadata?.nodeTimings,
        myNewNode: executionTime,
      },
    },
  };
};
```

### 11.2 Adding New Tools

To add a new tool:

1. Create a new tool implementation in `services/chat-orchestrator/src/tools/`
2. Register the tool in the tool registry
3. Add tests for the new tool

Example tool implementation:

```typescript
export const myNewTool = async (params: any): Promise<any> => {
  const logger = getLogger().child({ tool: 'myNewTool' });
  
  // Tool implementation
  
  return result;
};

// Register the tool
toolRegistry.register({
  name: 'my_new_tool',
  description: 'Description of my new tool',
  parameters: {
    param1: { type: 'string', description: 'Parameter 1' },
    param2: { type: 'number', description: 'Parameter 2' },
  },
  execute: myNewTool,
});
```

### 11.3 Custom Routing

To implement custom routing logic:

1. Create a new router node in `services/chat-orchestrator/src/nodes/`
2. Update the graph definition with conditional edges
3. Add tests for the new routing logic

Example router node:

```typescript
export const myCustomRouter = (state: AgentState): 'routeA' | 'routeB' => {
  const logger = getLogger().child({ node: 'myCustomRouter' });
  
  // Routing logic
  
  return condition ? 'routeA' : 'routeB';
};
```

## 12. Troubleshooting

### 12.1 Common Issues

#### LLM Errors

**Symptoms:**
- Error message: "Failed to generate response"
- Empty or incomplete responses

**Solutions:**
- Check LLM service status
- Verify API keys and quotas
- Reduce token usage
- Try a different model

#### Retrieval Issues

**Symptoms:**
- No documents retrieved
- Irrelevant documents retrieved

**Solutions:**
- Check search service status
- Verify query formatting
- Adjust relevance thresholds
- Check document indexing

#### Tool Execution Errors

**Symptoms:**
- Error message: "Tool execution failed"
- Incomplete tool results

**Solutions:**
- Check tool service status
- Verify tool parameters
- Check for rate limiting
- Verify tool permissions

#### Streaming Issues

**Symptoms:**
- Stream disconnects
- Missing events

**Solutions:**
- Check client connection
- Verify SSE format
- Check for timeouts
- Reduce response size

### 12.2 Debugging

#### Enabling Debug Logging

Set the `LOG_LEVEL` environment variable to `debug`:

```
LOG_LEVEL=debug
```

#### Tracing Requests

Add a `trace-id` header to the request:

```
trace-id: my-custom-trace-id
```

#### Inspecting State

Use the checkpoint API to inspect conversation state:

```
GET /admin/checkpoints/{checkpointId}
```

### 12.3 Support Resources

- **Documentation**: `services/docs/CHAT_RAG_GRAPH_*.md`
- **Issue Tracker**: GitHub Issues
- **Slack Channel**: #chat-rag-graph-support

## 13. Conclusion

The Chat RAG Graph implementation provides a flexible, modular, and observable architecture for building conversational AI applications. By leveraging a state machine approach, it enables complex conversation flows with conditional routing, context retrieval, tool usage, and more.

This documentation provides a comprehensive overview of the system's architecture, components, configuration options, and troubleshooting guides. For more detailed information on specific components, refer to the individual documentation files in the `services/docs/` directory.