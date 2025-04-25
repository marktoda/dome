# Chat RAG Graph Migration Plan

This document outlines the step-by-step migration plan from the current ChatService implementation to the new RAG graph-based Chat Orchestrator. The migration is designed to be direct and complete, ensuring a clean transition to the new architecture.

## 1. Current Architecture

The existing chat implementation consists of:

- **ChatController**: Handles HTTP requests and input validation
- **ChatService**: Core service that orchestrates the chat flow
- **PromptBuilder**: Builds prompts with context from retrieved documents
- **LlmClient**: Handles interactions with the AI service
- **SearchService**: Retrieves relevant documents for RAG

The current flow is linear and monolithic:

1. Validate input
2. Retrieve context (optional)
3. Build prompt with context
4. Call LLM
5. Return response

## 2. Target Architecture

The new architecture will be based on a state machine graph:

- **ChatController**: Remains largely unchanged, but calls the new orchestrator
- **Chat Orchestrator Worker**: New service implementing the RAG graph
- **StateGraph**: Core component from LangGraph.js that manages the flow
- **Node Functions**: Specialized functions for each step in the graph
- **D1 Checkpointer**: Persistence layer for conversation state

The new flow will be more flexible and modular:

1. Initialize graph with state
2. Process through nodes based on conditional logic
3. Stream results back to the client
4. Checkpoint state for resumption

## 3. Migration Phases

### Phase 1: Infrastructure Setup (Week 1)

1. **Create New Worker Project**

   - Set up new `chat-orchestrator` worker
   - Configure Wrangler and dependencies
   - Set up D1 database for checkpointing

2. **Implement Core Components**

   - Create basic state interfaces
   - Implement D1 Checkpointer
   - Set up logging and metrics

3. **Port Initial Graph Structure**
   - Implement minimal graph with placeholder nodes
   - Set up streaming response handling
   - Create test harness

**Deliverables:**

- Working chat-orchestrator worker with minimal functionality
- D1 database schema for checkpoints
- Basic test suite

### Phase 2: Node Implementation (Week 2)

1. **Implement Core Nodes**

   - Split/Rewrite node
   - Retrieve node (integrating with existing SearchService)
   - Generate Answer node

2. **Implement Routing Logic**

   - Route after retrieve
   - Basic conditional edges

3. **Set Up Observability**
   - Implement Langfuse tracing
   - Add detailed metrics for each node
   - Set up logging with context

**Deliverables:**

- Functional RAG implementation with basic nodes
- Comprehensive observability setup
- Integration tests for core nodes

### Phase 3: Feature Parity and Integration (Week 3)

1. **Implement Advanced Features**

   - Dynamic widening
   - Tool routing and execution
   - Enhanced context management

2. **Integrate with Dome API**

   - Update ChatController to use the new implementation exclusively
   - Remove any legacy code paths
   - Update tests to use only the new implementation

3. **Performance Optimization**
   - Optimize token usage
   - Implement caching strategies
   - Fine-tune checkpoint frequency

**Deliverables:**

- Complete feature parity with current implementation
- Full integration with Dome API
- Performance benchmarks

### Phase 4: Deployment and Legacy Removal (Week 4)

1. **Final Testing**

   - Comprehensive testing in staging environment
   - Load testing
   - Edge case testing

2. **Direct Deployment**

   - Deploy the new implementation to production
   - Monitor error rates and performance
   - Gather user feedback

3. **Legacy Code Removal**
   - Remove old ChatService implementation
   - Update documentation
   - Clean up unused code

**Deliverables:**

- Full production deployment
- Removal of legacy implementation
- Complete documentation and knowledge transfer

## 4. Integration Strategy

### 4.1 Dome API Changes

The integration with Dome API will require minimal changes:

```typescript
// Current implementation
async chat(c: Context) {
  const { messages, stream = false } = await c.req.json();
  const userId = c.req.header('x-user-id');

  if (stream) {
    return await this.chatService.streamResponse(c.env, {
      messages,
      userId,
      enhanceWithContext: true,
    });
  } else {
    const response = await this.chatService.generateResponse(c.env, {
      messages,
      userId,
      enhanceWithContext: true,
    });

    return c.json({ success: true, response });
  }
}

// New implementation
async chat(c: Context) {
  const { messages } = await c.req.json();
  const userId = c.req.header('x-user-id');

  // Call Chat Orchestrator
  const initialState = {
    messages,
    userId,
    options: {
      enhanceWithContext: true,
      maxContextItems: 10,
      includeSourceInfo: true,
    },
  };

  const response = await c.env.CHAT_ORCHESTRATOR.fetch('/chat', {
    method: 'POST',
    body: JSON.stringify({ initialState }),
    headers: { 'Content-Type': 'application/json' },
  });

  return response; // SSE stream
}
```

## 5. Testing Strategy

### 5.1 Unit Testing

- Test each node function in isolation
- Mock dependencies and state
- Verify state transformations

```typescript
// Example unit test for splitRewrite node
it('should rewrite multi-part questions', async () => {
  const state = {
    messages: [
      { role: 'user', content: 'What is the capital of France? And what is its population?' },
    ],
    // other state properties
  };

  const result = await splitRewrite(state);

  expect(result.tasks.originalQuery).toBe(
    'What is the capital of France? And what is its population?',
  );
  expect(result.tasks.rewrittenQuery).toBe('What is the capital of France?');
});
```

### 5.2 Integration Testing

- Test complete graph execution
- Verify conditional routing
- Test checkpoint persistence

```typescript
// Example integration test
it('should route to dynamic widen when no results found', async () => {
  const mockSearchService = {
    search: vi.fn().mockResolvedValue({ results: [] }),
  };

  // Mock dependencies
  vi.mock('../services/searchService', () => ({
    SearchService: vi.fn().mockImplementation(() => mockSearchService),
  }));

  const graph = buildChatGraph(mockEnv);
  const result = await graph.invoke({
    messages: [{ role: 'user', content: 'Tell me about obscure topic XYZ' }],
    userId: 'test-user',
    options: { enhanceWithContext: true },
  });

  // Verify the graph executed the widen path
  expect(result.tasks.wideningAttempts).toBeGreaterThan(0);
  expect(mockSearchService.search).toHaveBeenCalledTimes(2); // Initial + widened search
});
```

### 5.3 End-to-End Testing

- Test complete flow from API to response
- Verify streaming behavior
- Test error handling

```typescript
// Example E2E test
it('should stream responses with correct SSE format', async () => {
  const response = await fetch('http://localhost:8787/api/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-user-id': 'test-user',
    },
    body: JSON.stringify({
      messages: [{ role: 'user', content: 'Hello' }],
      stream: true,
    }),
  });

  expect(response.headers.get('Content-Type')).toBe('text/event-stream');

  // Parse SSE stream
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let events = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value);
    const eventMatches = chunk.match(/event: (\w+)\ndata: (.+)(?:\n\n)/g);

    if (eventMatches) {
      for (const match of eventMatches) {
        const [_, eventType, data] = match.match(/event: (\w+)\ndata: (.+)(?:\n\n)/);
        events.push({ type: eventType, data: JSON.parse(data) });
      }
    }
  }

  // Verify events
  expect(events.some(e => e.type === 'workflow_step')).toBe(true);
  expect(events.some(e => e.type === 'answer')).toBe(true);
  expect(events.some(e => e.type === 'done')).toBe(true);
});
```

## 6. Monitoring and Observability

### 6.1 Key Metrics

- **Latency**

  - Time to first token
  - Total response time
  - Per-node execution time

- **Resource Usage**

  - Memory consumption
  - Token usage
  - D1 database operations

- **Quality**
  - Error rates
  - Retrieval precision
  - Tool usage frequency

### 6.2 Dashboards

Create dashboards for:

- Overall system health
- Per-node performance
- Error rates and types
- User experience metrics

### 6.3 Alerts

Set up alerts for:

- Error rate spikes
- Latency increases
- Memory usage thresholds
- Checkpoint failures

## 7. Rollback Plan

In case of critical issues, the following rollback plan will be implemented:

1. **Immediate Rollback**

   - Revert to the previous version of the code
   - Deploy the previous version
   - Notify team via alert

2. **Issue Analysis**

   - Collect logs and metrics
   - Identify root cause
   - Create fix plan

3. **Re-deployment**
   - Apply fixes
   - Test thoroughly
   - Deploy fixed version

## 8. Success Criteria

The migration will be considered successful when:

1. **Functional Criteria**

   - All existing functionality is preserved
   - New features (dynamic widening, tool usage) are working correctly
   - No regression in response quality

2. **Performance Criteria**

   - Equal or better latency compared to legacy implementation
   - Resource usage within acceptable limits
   - Error rates below 0.1%

3. **Operational Criteria**
   - Comprehensive monitoring in place
   - Documentation updated
   - Team trained on new implementation

## 9. Timeline

| Week | Focus               | Key Milestones                                       |
| ---- | ------------------- | ---------------------------------------------------- |
| 1    | Infrastructure      | Worker setup, D1 schema, basic graph                 |
| 2    | Core Implementation | Node functions, routing, observability               |
| 3    | Integration         | Direct integration, performance optimization         |
| 4    | Deployment          | Production deployment, legacy removal, documentation |

## 10. Conclusion

This migration plan provides a structured approach to transitioning from the current monolithic ChatService to the new graph-based Chat Orchestrator. By following this plan, we can ensure a smooth migration with minimal disruption to users while introducing powerful new capabilities.

The graph-based approach will provide a more flexible, observable, and maintainable architecture that can be extended with new capabilities in the future. The direct migration strategy ensures a clean transition to the new implementation, reducing complexity and technical debt.
