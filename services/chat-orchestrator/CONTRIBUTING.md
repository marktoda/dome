# Contributing to Chat Orchestrator

Thank you for your interest in contributing to the Chat Orchestrator service! This document provides guidelines and instructions for contributing to the project.

## Table of Contents

- [Contributing to Chat Orchestrator](#contributing-to-chat-orchestrator)
  - [Table of Contents](#table-of-contents)
  - [Architecture Overview](#architecture-overview)
  - [Development Setup](#development-setup)
  - [Working with the RAG Graph](#working-with-the-rag-graph)
    - [Adding New Nodes](#adding-new-nodes)
    - [Modifying Existing Nodes](#modifying-existing-nodes)
    - [Conditional Routing](#conditional-routing)
  - [Testing Requirements](#testing-requirements)
    - [Unit Tests](#unit-tests)
    - [Integration Tests](#integration-tests)
    - [Performance Tests](#performance-tests)
  - [Code Style Guidelines](#code-style-guidelines)
  - [Documentation](#documentation)
  - [Pull Request Process](#pull-request-process)

## Architecture Overview

The Chat Orchestrator is built on a directed graph architecture using the `@langchain/langgraph` library. Each node in the graph represents a specific processing step, and edges define the flow between nodes.

Key components:
- **Graph Nodes**: Individual processing steps (e.g., retrieve, generate answer)
- **State Management**: Shared state passed between nodes
- **Checkpointing**: Persistence of conversation state in D1 database
- **Stream Transformation**: Converting graph output to SSE events

## Development Setup

1. Clone the repository:
   ```bash
   git clone https://github.com/your-org/dome.git
   cd dome
   ```

2. Install dependencies:
   ```bash
   pnpm install
   ```

3. Set up local environment:
   ```bash
   cd services/chat-orchestrator
   cp .env.example .dev.vars
   ```

4. Start the development server:
   ```bash
   pnpm dev
   ```

5. Run tests:
   ```bash
   pnpm test
   ```

## Working with the RAG Graph

### Adding New Nodes

To add a new node to the RAG graph:

1. Create a new file in `src/nodes/` for your node implementation:

```typescript
// src/nodes/myNewNode.ts
import { getLogger } from '@dome/logging';
import { AgentState } from '../types';

/**
 * My new node that does something useful
 */
export const myNewNode = async (state: AgentState, env: Env): Promise<AgentState> => {
  const logger = getLogger().child({ node: 'myNewNode' });
  const startTime = performance.now();
  
  // Your node implementation here
  // ...
  
  // Update state with timing information
  const endTime = performance.now();
  const executionTime = endTime - startTime;
  
  return {
    ...state,
    // Add your state updates here
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

2. Add your node to the graph in `src/graph.ts`:

```typescript
// Add import
import { myNewNode } from './nodes/myNewNode';

// In the buildChatGraph function:
const graph = new StateGraph<AgentState>()
  // Add existing nodes
  .addNode('split_rewrite', nodes.splitRewrite)
  .addNode('retrieve', nodes.retrieve)
  // Add your new node
  .addNode('my_new_node', myNewNode)
  
  // Add edges
  .addEdge('some_existing_node', 'my_new_node')
  .addEdge('my_new_node', 'next_node');
```

3. If your node requires conditional routing, implement a router function:

```typescript
/**
 * Determine next step after my new node
 * @returns 'path_a' | 'path_b'
 */
export const routeAfterMyNewNode = (state: AgentState): 'path_a' | 'path_b' => {
  // Your routing logic here
  if (someCondition) {
    return 'path_a';
  }
  return 'path_b';
};

// In the graph:
.addConditionalEdges('my_new_node', routeAfterMyNewNode, {
  path_a: 'node_for_path_a',
  path_b: 'node_for_path_b',
})
```

### Modifying Existing Nodes

When modifying existing nodes:

1. Maintain the same function signature and return type
2. Preserve existing functionality unless explicitly changing it
3. Update tests to reflect changes
4. Document changes in comments and PR description

Example of modifying the retrieve node:

```typescript
export const retrieve = async (state: AgentState, env: Env): Promise<AgentState> => {
  const logger = getLogger().child({ node: 'retrieve' });
  const startTime = performance.now();
  
  // Existing code...
  
  // Your modifications here
  const enhancedSearchParams = {
    ...searchParams,
    // New parameters
    semanticBoost: 1.5,
    includeMetadata: true,
  };
  
  // Use enhanced parameters
  const searchResults = await searchService.search(env, enhancedSearchParams);
  
  // Rest of existing code...
  
  return {
    ...state,
    docs: processedDocs,
    // Add any new state properties
    tasks: {
      ...state.tasks,
      needsWidening: docsCount < 2 && wideningAttempts < 2,
      wideningAttempts,
      // New property
      searchEnhanced: true,
    },
    metadata: {
      ...state.metadata,
      nodeTimings: {
        ...state.metadata?.nodeTimings,
        retrieve: executionTime,
      },
    },
  };
};
```

### Conditional Routing

The graph uses conditional routing to determine the flow between nodes. When adding or modifying routing:

1. Define clear conditions for each path
2. Return string literals that match the edge names in the graph
3. Keep routing functions pure (no side effects)
4. Add appropriate tests for each routing condition

Example:

```typescript
/**
 * Determine if we should use semantic search
 */
export const routeSearchStrategy = (state: AgentState): 'semantic' | 'keyword' | 'hybrid' => {
  const query = state.tasks?.rewrittenQuery || '';
  
  if (query.length > 100) {
    return 'semantic';
  } else if (/\b(what|who|when|where|why|how)\b/i.test(query)) {
    return 'hybrid';
  } else {
    return 'keyword';
  }
};

// In the graph:
.addConditionalEdges('pre_search', routeSearchStrategy, {
  semantic: 'semantic_search',
  keyword: 'keyword_search',
  hybrid: 'hybrid_search',
})
```

## Testing Requirements

All contributions must include appropriate tests:

### Unit Tests

- Each node should have unit tests covering its functionality
- Test both success and error paths
- Mock external dependencies

Example:

```typescript
describe('myNewNode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Set up mocks
  });
  
  it('should process data correctly', async () => {
    const initialState = {
      // Test state
    };
    
    const result = await myNewNode(initialState, mockEnv);
    
    expect(result).toHaveProperty('someProperty');
    expect(result.metadata.nodeTimings).toHaveProperty('myNewNode');
  });
  
  it('should handle errors gracefully', async () => {
    // Mock a failure
    mockService.someMethod.mockRejectedValue(new Error('Test error'));
    
    const initialState = {
      // Test state
    };
    
    const result = await myNewNode(initialState, mockEnv);
    
    expect(result.metadata.errors).toContainEqual(
      expect.objectContaining({
        node: 'myNewNode',
        message: 'Test error',
      })
    );
  });
});
```

### Integration Tests

- Test the complete graph flow
- Verify interactions between nodes
- Test with realistic data

Example:

```typescript
describe('Graph Integration', () => {
  it('should process a query through the entire graph including my new node', async () => {
    const graph = await buildChatGraph(mockEnv);
    
    const initialState = {
      // Test state that will trigger your node
    };
    
    const result = await graph.invoke({
      configurable: {
        state: initialState,
        config: {
          runId: 'test-run-id',
        }
      }
    });
    
    // Verify your node was executed
    expect(result.metadata?.nodeTimings).toHaveProperty('myNewNode');
    // Verify expected outcomes
    expect(result).toHaveProperty('someProperty');
  });
});
```

### Performance Tests

For significant changes, include performance tests:

```typescript
describe('Performance', () => {
  it('should process queries efficiently', async () => {
    const startTime = performance.now();
    
    // Execute your node or the graph
    
    const endTime = performance.now();
    const executionTime = endTime - startTime;
    
    expect(executionTime).toBeLessThan(1000); // Less than 1 second
  });
});
```

## Code Style Guidelines

Follow these style guidelines for consistency:

1. **TypeScript**: Use TypeScript for all new code
   - Define proper interfaces for all data structures
   - Use strict typing (no `any` unless absolutely necessary)
   - Use optional chaining and nullish coalescing where appropriate

2. **Naming Conventions**:
   - Use camelCase for variables and functions
   - Use PascalCase for classes and interfaces
   - Use snake_case for database fields
   - Prefix interfaces with `I` (e.g., `ISearchParams`)

3. **Comments and Documentation**:
   - Use JSDoc comments for functions and classes
   - Document parameters and return types
   - Explain complex logic with inline comments

4. **Error Handling**:
   - Use try/catch blocks for error handling
   - Log errors with appropriate context
   - Return graceful fallbacks rather than throwing errors in graph nodes

5. **Logging**:
   - Use structured logging with the `@dome/logging` package
   - Include relevant context in log entries
   - Use appropriate log levels (debug, info, warn, error)

6. **Asynchronous Code**:
   - Use async/await instead of Promises
   - Handle Promise rejections properly
   - Avoid nested async calls where possible

## Documentation

Update documentation when making changes:

1. **Code Comments**: Update JSDoc comments for modified functions
2. **README.md**: Update if adding new features or changing existing ones
3. **API Documentation**: Update if changing API endpoints or parameters
4. **Architecture Diagrams**: Update if changing the graph structure

## Pull Request Process

1. Create a feature branch from `main`
2. Make your changes following the guidelines above
3. Run tests to ensure they pass
4. Update documentation as needed
5. Submit a pull request with a clear description of the changes
6. Address any feedback from code reviews
7. Once approved, your PR will be merged

Thank you for contributing to the Chat Orchestrator service!