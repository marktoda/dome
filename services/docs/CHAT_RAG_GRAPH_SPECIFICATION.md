# Dome Chat Orchestrator — RAG Graph Implementation Specification
*v 1.0 • 2025-04-24*

## 1. Executive Summary

This document outlines the specification for implementing a revamped chat solution for Dome based on the RAG (Retrieval-Augmented Generation) graph approach. The implementation will leverage `@langchain/langgraph` to create a state-machine-based orchestration layer that enhances the current chat functionality with more sophisticated retrieval, context management, and tool integration capabilities.

The new Chat Orchestrator will replace the current monolithic ChatService with a modular, graph-based approach that provides better observability, extensibility, and performance. This implementation will serve as the foundation for future enhancements to Dome's conversational AI capabilities.

## 2. Key Concepts and Components

### 2.1 Core Architecture

The RAG graph approach is built on the following key concepts:

1. **StateGraph**: A directed graph where nodes represent processing steps and edges represent transitions between steps. The graph maintains state that evolves as messages flow through the system.

2. **Nodes**: Specialized functions that perform specific tasks such as:
   - `splitRewrite`: Analyzes user input and reformulates queries
   - `retrieve`: Fetches relevant documents from knowledge sources
   - `dynamicWiden`: Expands search context when needed
   - `toolRouter`: Determines if tools should be invoked
   - `runTool`: Executes specific tools
   - `generateAnswer`: Creates the final response

3. **Conditional Edges**: Logic that determines the flow between nodes based on the current state, enabling dynamic routing decisions.

4. **State Management**: A structured approach to maintaining conversation context, retrieved documents, and intermediate processing results.

5. **Checkpointing**: Persistence of graph state to enable resumption of long-running conversations and recovery from failures.

### 2.2 Technical Foundation

The implementation will be built on:

- **LangGraph.js**: Official JavaScript/TypeScript port of the Python LangGraph framework
- **Cloudflare Workers**: Edge runtime environment for the orchestrator
- **D1 Database**: For state persistence and checkpointing
- **Langfuse**: For observability and tracing

## 3. Functional Requirements

### 3.1 Core Functionality

The MVP implementation must support:

1. **Conversational Interface**
   - Support for multi-turn conversations
   - Maintenance of conversation history and context
   - Streaming responses with step metadata

2. **RAG Capabilities**
   - Document retrieval based on user queries
   - Context-aware responses that incorporate retrieved information
   - Dynamic widening of search context when initial results are insufficient
   - Source attribution in responses

3. **Tool Integration**
   - Ability to detect when tool use is appropriate
   - Routing to specific tools based on user intent
   - Incorporation of tool outputs into responses

4. **State Management**
   - Persistence of conversation state between turns
   - Efficient handling of document references
   - Token-aware context management

### 3.2 API Contract

The Chat Orchestrator will expose a single endpoint:

```
POST /chat
```

**Request Body:**
```typescript
{
  initialState: {
    messages: Array<{
      role: 'user' | 'assistant' | 'system',
      content: string
    }>,
    userId: string,
    // Optional parameters
    enhanceWithContext?: boolean,
    maxContextItems?: number,
    includeSourceInfo?: boolean
  }
}
```

**Response:**
Server-Sent Events (SSE) stream with the following event types:

```
event: workflow_step
data: {"step":"retrieve"}

event: answer
data: {"delta":"• Delaware recognises ...", "sources":[...]}

event: done
```

### 3.3 User Experience Requirements

1. **Responsiveness**
   - Initial response time < 500ms
   - Complete response generation < 5 seconds for typical queries

2. **Streaming**
   - Progressive rendering of responses
   - Visibility into processing steps (optional UI indicators)

3. **Context Awareness**
   - Responses should clearly incorporate relevant retrieved information
   - Source attribution should be clear and accurate

## 4. Technical Constraints and Considerations

### 4.1 Performance Constraints

1. **Memory Usage**
   - Workers have limited memory (128MB)
   - Need efficient state management for long conversations
   - Checkpoint after each super-step to avoid memory issues

2. **Bundle Size**
   - LangGraph.js and dependencies may result in large bundle
   - Use tree-shaking and external dependencies where possible

3. **Execution Time**
   - Workers have execution time limits (30 seconds)
   - Need to optimize graph execution for complex flows

### 4.2 Scalability Considerations

1. **Concurrent Requests**
   - Design for high concurrency with minimal state in memory
   - Use Durable Objects for long-running sessions

2. **Data Volume**
   - Handle varying sizes of retrieved document sets
   - Implement token-aware truncation strategies

### 4.3 Security and Privacy

1. **User Data**
   - Ensure user context is isolated between requests
   - Implement proper authentication checks

2. **Dependency Management**
   - Pin dependency versions to avoid unexpected changes
   - Regularly audit dependencies for vulnerabilities

## 5. Integration Points

### 5.1 Dome API Integration

The Chat Orchestrator will be integrated with the Dome API service:

```typescript
// In Dome API
const resp = await env.CHAT_ORCHESTRATOR.fetch('/chat', {
  method: 'POST',
  body: JSON.stringify({ initialState }),
  headers: { 'Content-Type': 'application/json' },
});
return resp; // SSE stream
```

### 5.2 Search Service Integration

The `retrieve` node will integrate with the existing SearchService:

```typescript
// In retrieve node
const searchResults = await searchService.search(env, {
  userId,
  query,
  limit: maxItems,
});
```

### 5.3 Metrics and Logging

Integration with existing logging and metrics infrastructure:

```typescript
// Wrap nodes with metrics
const retrieveWithMetrics = withMetrics(retrieve, 'retrieve');

// Log state transitions
graph.onStateChange((oldState, newState) => {
  logger.info({
    stateTransition: {
      from: summarizeState(oldState),
      to: summarizeState(newState),
    },
  });
});
```

### 5.4 Langfuse Integration

```typescript
// Add Langfuse tracing
const callbacks = [langfuseHandler(env)];
const stream = graph.astream(initialState, { callbacks, env });
```

## 6. Implementation Plan

### 6.1 Phase 1: Core Graph Implementation (Week 1)

1. Set up project structure and dependencies
2. Implement basic StateGraph with core nodes
3. Create mock data for testing
4. Develop and test in Miniflare environment

### 6.2 Phase 2: Persistence and Observability (Week 2)

1. Implement D1 Checkpointer
2. Add Langfuse callbacks
3. Implement metrics decorators
4. Add comprehensive logging

### 6.3 Phase 3: Integration and Testing (Week 3)

1. Integrate with Dome API behind feature flag
2. Implement shadow traffic routing (10%)
3. Conduct A/B testing and performance analysis
4. Refine implementation based on results

### 6.4 Phase 4: Rollout (Week 4)

1. Remove legacy ChatService.buildPrompt
2. Make Orchestrator the default implementation
3. Monitor performance and user feedback
4. Document final implementation

## 7. Success Criteria

### 7.1 Functional Success

1. **Complete Feature Parity**
   - All existing chat functionality is preserved
   - New RAG capabilities are fully implemented

2. **Reliability**
   - Error rates < 0.1%
   - Successful recovery from transient failures

3. **Correctness**
   - Responses accurately incorporate retrieved information
   - Tool selection and execution is appropriate

### 7.2 Performance Success

1. **Latency**
   - P95 response time < 5 seconds
   - Initial token delivery < 500ms

2. **Resource Utilization**
   - Memory usage < 80% of Worker limit
   - CPU utilization < 70% of available resources

3. **Scalability**
   - Handles 10x current request volume without degradation

### 7.3 Developer Experience

1. **Maintainability**
   - Clear separation of concerns
   - Well-documented code and architecture
   - Testable components

2. **Extensibility**
   - New nodes can be added without modifying existing code
   - New tools can be integrated easily

### 7.4 User Experience

1. **Satisfaction**
   - Improved response quality (measured by user feedback)
   - Reduced need for query reformulation

2. **Engagement**
   - Increased conversation length
   - Higher usage frequency

## 8. Risks and Mitigations

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Large npm bundle size | High | High | Use `esbuild --external` to tree-shake; cloudflare-minify |
| Memory in long streams | High | Medium | Checkpoint after each super-step; GC old history tokens |
| Multiple package versions of `@langchain/core` | Medium | High | Pin via `resolutions` in `package.json` |
| Performance degradation | High | Medium | Implement circuit breakers; fallback to simpler implementation |
| Integration complexity | Medium | Medium | Phased approach with feature flags; shadow testing |

## 9. Technical Pseudocode

### 9.1 Graph Definition

```typescript
// src/graph.ts
import { StateGraph, START, END } from '@langchain/langgraph';
import * as nodes from './nodes';

export type AgentState = {
  messages: Message[];
  chatHistory: ChatHistory;
  tasks?: Tasks;
  docs?: Doc[];
  // Other state properties
};

export const buildChatGraph = (env: Bindings) => {
  const graph = new StateGraph<AgentState>()
    // Add nodes
    .addNode('split_rewrite', nodes.splitRewrite)
    .addNode('retrieve', nodes.retrieve)
    .addNode('dynamic_widen', nodes.dynamicWiden)
    .addNode('tool_router', nodes.toolRouter)
    .addNode('run_tool', nodes.runTool)
    .addNode('generate_answer', nodes.generateAnswer)
    
    // Add edges
    .addEdge(START, 'split_rewrite')
    .addEdge('split_rewrite', 'retrieve')
    
    // Add conditional edges
    .addConditionalEdges('retrieve', nodes.routeAfterRetrieve, {
      widen: 'dynamic_widen',
      tool: 'tool_router',
      answer: 'generate_answer',
    })
    .addEdge('dynamic_widen', 'retrieve')
    .addConditionalEdges('tool_router', nodes.routeAfterTool, {
      run_tool: 'run_tool',
      answer: 'generate_answer',
    })
    .addEdge('run_tool', 'generate_answer')
    .addEdge('generate_answer', END);
    
  // Compile with checkpointer and reducers
  return graph.compile({
    checkpointer: new D1Checkpointer(env.D1),
    reducers: {
      docs: 'append',
      tasks: 'merge',
    },
  });
};
```

### 9.2 Node Implementations

```typescript
// src/nodes/splitRewrite.ts
export const splitRewrite = async (state: AgentState): Promise<AgentState> => {
  const lastMessage = getLastUserMessage(state.messages);
  const rewrittenQuery = await rewriteQuery(lastMessage.content);
  
  return {
    ...state,
    tasks: {
      ...state.tasks,
      query: rewrittenQuery,
    },
  };
};

// src/nodes/retrieve.ts
export const retrieve = async (state: AgentState, env: Bindings): Promise<AgentState> => {
  const { query } = state.tasks;
  const { userId } = state;
  
  const searchResults = await searchService.search(env, {
    userId,
    query,
    limit: state.maxContextItems || 10,
  });
  
  return {
    ...state,
    docs: searchResults.results,
  };
};

// src/nodes/routeAfterRetrieve.ts
export const routeAfterRetrieve = (state: AgentState): 'widen' | 'tool' | 'answer' => {
  if (!state.docs || state.docs.length === 0) {
    return 'widen';
  }
  
  if (detectToolIntent(state.tasks.query)) {
    return 'tool';
  }
  
  return 'answer';
};

// Additional node implementations...
```

### 9.3 Worker Entrypoint

```typescript
// src/index.ts
import { buildChatGraph } from './graph';
import { langfuseHandler } from './observability/langfuse';

export default {
  async fetch(req: Request, env: Bindings, ctx: ExecutionContext) {
    // Parse request
    const { initialState } = await req.json();
    
    // Build graph
    const graph = buildChatGraph(env);
    
    // Execute graph with streaming
    const stream = graph.astream(initialState, {
      callbacks: [langfuseHandler(env)],
      env,
    });
    
    // Transform to SSE
    const sseStream = transformToSSE(stream);
    
    // Return response
    return new Response(sseStream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  },
};
```

## 10. Conclusion

The RAG graph approach represents a significant advancement in Dome's chat capabilities. By leveraging LangGraph.js and implementing a state-machine-based orchestration layer, we can create a more modular, observable, and extensible chat system that better serves user needs.

This specification provides a comprehensive roadmap for implementing the new Chat Orchestrator, with clear requirements, technical considerations, and success criteria. Following this plan will enable the team to deliver a high-quality implementation within the 4-week timeframe.