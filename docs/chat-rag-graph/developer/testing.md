# Testing Guide

This guide provides comprehensive instructions for testing the Chat RAG Graph solution. It covers unit testing, integration testing, end-to-end testing, and performance testing.

## Testing Architecture

The Chat RAG Graph solution uses a multi-layered testing approach:

1. **Unit Tests**: Test individual components in isolation
2. **Integration Tests**: Test interactions between components
3. **End-to-End Tests**: Test the complete system
4. **Performance Tests**: Test system performance under load

The testing framework is built on [Vitest](https://vitest.dev/), a Vite-native testing framework that provides fast, parallel test execution.

## Setting Up the Testing Environment

### Prerequisites

- Node.js (v18 or later)
- pnpm (v8 or later)
- Wrangler CLI (v3 or later)

### Installation

```bash
# Install dependencies
pnpm install

# Install Vitest globally (optional)
pnpm add -g vitest
```

### Test Configuration

The test configuration is defined in `vitest.config.ts`:

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    coverage: {
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules', 'dist', '**/*.test.ts'],
    },
    setupFiles: ['./tests/setup.js'],
    globals: true,
  },
});
```

### Test Setup

The test setup file (`tests/setup.js`) configures the testing environment:

```javascript
import { vi } from 'vitest';

// Mock environment bindings
global.Bindings = {};

// Mock logger
vi.mock('@dome/logging', () => ({
  getLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    child: vi.fn().mockReturnValue({
      info: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
    }),
  }),
  logError: vi.fn(),
}));

// Mock services
vi.mock('../src/services/llmService');
vi.mock('../src/services/searchService');
vi.mock('../src/services/observabilityService');

// Mock checkpointer
vi.mock('../src/checkpointer/d1Checkpointer');
```

## Unit Testing

Unit tests focus on testing individual components in isolation. Each node, service, and utility function should have corresponding unit tests.

### Testing Nodes

Nodes are the core processing units of the graph. Each node should have comprehensive unit tests that verify its behavior under various conditions.

Example test for the `splitRewrite` node:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { splitRewrite } from '../../src/nodes/splitRewrite';
import { AgentState } from '../../src/types';
import { LlmService } from '../../src/services/llmService';

// Mock dependencies
vi.mock('../../src/services/llmService', () => ({
  LlmService: {
    rewriteQuery: vi.fn(),
    analyzeQueryComplexity: vi.fn(),
  },
}));

describe('splitRewrite Node', () => {
  // Mock environment
  const mockEnv = {} as Bindings;

  // Initial state
  let initialState: AgentState;

  beforeEach(() => {
    initialState = {
      userId: 'user-123',
      messages: [{ role: 'user', content: 'What is the capital of France?' }],
      options: {
        enhanceWithContext: true,
        maxContextItems: 5,
        includeSourceInfo: true,
        maxTokens: 1000,
      },
      metadata: {
        startTime: Date.now(),
        nodeTimings: {},
        tokenCounts: {},
      },
    };

    // Reset mocks
    vi.clearAllMocks();

    // Mock LLM responses
    vi.mocked(LlmService.analyzeQueryComplexity).mockResolvedValue({
      isComplex: false,
      shouldSplit: false,
      reason: 'Query is simple',
    });

    vi.mocked(LlmService.rewriteQuery).mockResolvedValue('What is the capital of France?');
  });

  it('should extract the last user message', async () => {
    const result = await splitRewrite(initialState, mockEnv);

    expect(result.tasks?.originalQuery).toBe('What is the capital of France?');
  });

  it('should analyze query complexity', async () => {
    await splitRewrite(initialState, mockEnv);

    expect(LlmService.analyzeQueryComplexity).toHaveBeenCalledWith(
      mockEnv,
      'What is the capital of France?',
      expect.any(Object),
    );
  });

  it('should rewrite the query if needed', async () => {
    // Mock complex query
    vi.mocked(LlmService.analyzeQueryComplexity).mockResolvedValue({
      isComplex: true,
      shouldSplit: true,
      reason: 'Query contains multiple questions',
    });

    await splitRewrite(initialState, mockEnv);

    expect(LlmService.rewriteQuery).toHaveBeenCalled();
  });

  it('should handle missing user messages', async () => {
    const stateWithoutMessages = {
      ...initialState,
      messages: [],
    };

    const result = await splitRewrite(stateWithoutMessages, mockEnv);

    expect(result.tasks?.originalQuery).toBe('');
    expect(result.tasks?.rewrittenQuery).toBe('');
  });

  it('should track execution time', async () => {
    const result = await splitRewrite(initialState, mockEnv);

    expect(result.metadata?.nodeTimings).toHaveProperty('splitRewrite');
  });

  it('should track token counts', async () => {
    const result = await splitRewrite(initialState, mockEnv);

    expect(result.metadata?.tokenCounts).toHaveProperty('originalQuery');
    expect(result.metadata?.tokenCounts).toHaveProperty('rewrittenQuery');
  });
});
```

### Testing Services

Services provide functionality to nodes. Each service should have comprehensive unit tests that verify its behavior.

Example test for the `LlmService`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LlmService } from '../../src/services/llmService';

describe('LlmService', () => {
  // Mock environment
  const mockEnv = {
    AI: {
      run: vi.fn(),
    },
  } as unknown as Bindings;

  beforeEach(() => {
    vi.clearAllMocks();

    // Mock AI response
    mockEnv.AI.run.mockResolvedValue({
      response: 'This is a test response',
    });
  });

  describe('analyzeQueryComplexity', () => {
    it('should analyze query complexity', async () => {
      // Mock AI response for complexity analysis
      mockEnv.AI.run.mockResolvedValue({
        response: JSON.stringify({
          isComplex: true,
          shouldSplit: true,
          reason: 'Query contains multiple questions',
          suggestedQueries: ['What is the capital of France?', 'What is the population of Paris?'],
        }),
      });

      const result = await LlmService.analyzeQueryComplexity(
        mockEnv,
        'What is the capital of France and what is its population?',
        { temperature: 0.2 },
      );

      expect(result.isComplex).toBe(true);
      expect(result.shouldSplit).toBe(true);
      expect(result.suggestedQueries).toHaveLength(2);
      expect(mockEnv.AI.run).toHaveBeenCalledWith(
        LlmService.MODEL,
        expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({
              content: expect.stringContaining('Analyze the following user query'),
            }),
          ]),
          temperature: 0.2,
        }),
      );
    });

    it('should handle errors gracefully', async () => {
      // Mock AI error
      mockEnv.AI.run.mockRejectedValue(new Error('AI service error'));

      const result = await LlmService.analyzeQueryComplexity(
        mockEnv,
        'What is the capital of France?',
        { temperature: 0.2 },
      );

      expect(result.isComplex).toBe(false);
      expect(result.shouldSplit).toBe(false);
      expect(result.reason).toBe('Error analyzing query');
    });
  });

  // Additional tests for other methods...
});
```

### Testing Utilities

Utility functions should also have comprehensive unit tests.

Example test for the `tokenCounter` utility:

```typescript
import { describe, it, expect } from 'vitest';
import { countTokens } from '../../src/utils/tokenCounter';

describe('tokenCounter', () => {
  it('should count tokens in text', () => {
    const text = 'This is a test sentence.';
    const tokenCount = countTokens(text);

    // Approximate token count (may vary based on tokenizer)
    expect(tokenCount).toBeGreaterThan(0);
    expect(tokenCount).toBeLessThan(10);
  });

  it('should handle empty text', () => {
    const tokenCount = countTokens('');

    expect(tokenCount).toBe(0);
  });

  it('should handle special characters', () => {
    const text = 'This has special characters: !@#$%^&*()';
    const tokenCount = countTokens(text);

    expect(tokenCount).toBeGreaterThan(0);
  });

  it('should handle multilingual text', () => {
    const text = 'English, Français, Español, 日本語, 中文';
    const tokenCount = countTokens(text);

    expect(tokenCount).toBeGreaterThan(0);
  });
});
```

## Integration Testing

Integration tests verify that components work together correctly. For the Chat RAG Graph, integration tests focus on testing the graph execution with multiple nodes.

Example integration test:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildChatGraph } from '../../src/graph';
import { AgentState, Document } from '../../src/types';
import { LlmService } from '../../src/services/llmService';
import { SearchService } from '../../src/services/searchService';

// Mock dependencies
vi.mock('../../src/services/llmService');
vi.mock('../../src/services/searchService');

describe('Chat RAG Graph Integration', () => {
  // Mock environment
  const mockEnv = {
    AI: {
      run: vi.fn(),
    },
    D1: {},
  } as unknown as Bindings;

  // Mock documents
  const mockDocs: Document[] = [
    {
      id: 'doc-1',
      title: 'Sample Document 1',
      body: 'This is the content of sample document 1.',
      metadata: {
        source: 'knowledge-base',
        createdAt: new Date().toISOString(),
        relevanceScore: 0.95,
      },
    },
    {
      id: 'doc-2',
      title: 'Sample Document 2',
      body: 'This is the content of sample document 2.',
      metadata: {
        source: 'knowledge-base',
        createdAt: new Date().toISOString(),
        relevanceScore: 0.85,
      },
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();

    // Mock LLM responses
    vi.mocked(LlmService.analyzeQueryComplexity).mockResolvedValue({
      isComplex: false,
      shouldSplit: false,
      reason: 'Query is simple',
    });

    vi.mocked(LlmService.rewriteQuery).mockResolvedValue('What is the capital of France?');

    vi.mocked(LlmService.generateResponse).mockResolvedValue('The capital of France is Paris.');

    // Mock search results
    vi.mocked(SearchService.search).mockResolvedValue(mockDocs);

    vi.mocked(SearchService.rankAndFilterDocuments).mockReturnValue(mockDocs);

    vi.mocked(SearchService.extractSourceMetadata).mockReturnValue(
      mockDocs.map(doc => ({
        id: doc.id,
        title: doc.title,
        source: doc.metadata.source,
        relevanceScore: doc.metadata.relevanceScore,
      })),
    );
  });

  it('should process a simple query through the entire graph', async () => {
    // Create the graph
    const graph = await buildChatGraph(mockEnv);

    // Create initial state
    const initialState: AgentState = {
      userId: 'user-123',
      messages: [{ role: 'user', content: 'What is the capital of France?' }],
      options: {
        enhanceWithContext: true,
        maxContextItems: 5,
        includeSourceInfo: true,
        maxTokens: 1000,
      },
      metadata: {
        startTime: Date.now(),
        nodeTimings: {},
        tokenCounts: {},
      },
    };

    // Execute the graph
    const result = await graph.invoke(initialState);

    // Verify the result
    expect(result).toBeDefined();
    expect(result.generatedText).toBeDefined();
    expect(result.docs).toHaveLength(2);

    // Verify that all nodes were executed
    expect(result.metadata?.nodeTimings).toHaveProperty('splitRewrite');
    expect(result.metadata?.nodeTimings).toHaveProperty('retrieve');
    expect(result.metadata?.nodeTimings).toHaveProperty('generateAnswer');

    // Verify that the LLM service was called
    expect(LlmService.analyzeQueryComplexity).toHaveBeenCalled();
    expect(LlmService.generateResponse).toHaveBeenCalled();

    // Verify that the search service was called
    expect(SearchService.search).toHaveBeenCalled();
  });

  it('should handle retrieval widening when few results are found', async () => {
    // First return empty results, then return results after widening
    vi.mocked(SearchService.search)
      .mockResolvedValueOnce([]) // First call returns no results
      .mockResolvedValueOnce(mockDocs); // Second call after widening returns results

    // Create the graph
    const graph = await buildChatGraph(mockEnv);

    // Create initial state
    const initialState: AgentState = {
      userId: 'user-123',
      messages: [{ role: 'user', content: 'Tell me about a very obscure topic' }],
      options: {
        enhanceWithContext: true,
        maxContextItems: 5,
        includeSourceInfo: true,
        maxTokens: 1000,
      },
      metadata: {
        startTime: Date.now(),
        nodeTimings: {},
        tokenCounts: {},
      },
    };

    // Execute the graph
    const result = await graph.invoke(initialState);

    // Verify the result
    expect(result).toBeDefined();
    expect(result.generatedText).toBeDefined();

    // Verify that search was called twice (initial + widening)
    expect(SearchService.search).toHaveBeenCalledTimes(2);

    // Verify that widening attempts were tracked
    expect(result.tasks?.wideningAttempts).toBe(1);
  });

  it('should handle errors gracefully', async () => {
    // Mock an error in the LLM service
    vi.mocked(LlmService.generateResponse).mockRejectedValue(new Error('LLM service error'));

    // Create the graph
    const graph = await buildChatGraph(mockEnv);

    // Create initial state
    const initialState: AgentState = {
      userId: 'user-123',
      messages: [{ role: 'user', content: 'What is the capital of France?' }],
      options: {
        enhanceWithContext: true,
        maxContextItems: 5,
        includeSourceInfo: true,
        maxTokens: 1000,
      },
      metadata: {
        startTime: Date.now(),
        nodeTimings: {},
        tokenCounts: {},
      },
    };

    // Execute the graph
    const result = await graph.invoke(initialState);

    // Verify the result contains an error
    expect(result).toBeDefined();
    expect(result.metadata?.errors).toBeDefined();
    expect(result.metadata?.errors?.length).toBeGreaterThan(0);

    // Verify that a fallback response was provided
    expect(result.generatedText).toContain("I'm sorry");
  });
});
```

## End-to-End Testing

End-to-end tests verify that the complete system works correctly. For the Chat RAG Graph, end-to-end tests focus on testing the API endpoints.

Example end-to-end test:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { app } from '../../src/index';
import { ChatService } from '../../src/services/chatService';

// Mock dependencies
vi.mock('../../src/services/chatService');

describe('Chat API End-to-End', () => {
  // Mock environment
  const mockEnv = {
    AI: {
      run: vi.fn(),
    },
    D1: {},
  } as unknown as Bindings;

  beforeEach(() => {
    vi.clearAllMocks();

    // Mock chat service
    vi.mocked(ChatService.generateResponse).mockResolvedValue('This is a test response');

    // Mock stream response
    const mockStream = new ReadableStream({
      start(controller) {
        controller.enqueue('This is a test stream response');
        controller.close();
      },
    });

    const mockResponse = new Response(mockStream, {
      headers: {
        'Content-Type': 'text/event-stream',
      },
    });

    vi.mocked(ChatService.streamResponse).mockResolvedValue(mockResponse);
  });

  it('should handle chat requests', async () => {
    // Create request
    const request = new Request('http://localhost/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-token',
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'What is the capital of France?' }],
        options: {
          enhanceWithContext: true,
          maxContextItems: 5,
          includeSourceInfo: true,
        },
      }),
    });

    // Execute request
    const response = await app.fetch(request, mockEnv);

    // Verify response
    expect(response.status).toBe(200);

    const responseData = await response.json();
    expect(responseData.success).toBe(true);
    expect(responseData.response).toBe('This is a test response');

    // Verify that the chat service was called
    expect(ChatService.generateResponse).toHaveBeenCalled();
  });

  it('should handle streaming requests', async () => {
    // Create request
    const request = new Request('http://localhost/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-token',
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'What is the capital of France?' }],
        options: {
          enhanceWithContext: true,
          maxContextItems: 5,
          includeSourceInfo: true,
          stream: true,
        },
      }),
    });

    // Execute request
    const response = await app.fetch(request, mockEnv);

    // Verify response
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/event-stream');

    // Verify that the chat service was called
    expect(ChatService.streamResponse).toHaveBeenCalled();
  });

  it('should handle authentication errors', async () => {
    // Create request without authentication
    const request = new Request('http://localhost/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'What is the capital of France?' }],
      }),
    });

    // Execute request
    const response = await app.fetch(request, mockEnv);

    // Verify response
    expect(response.status).toBe(401);

    const responseData = await response.json();
    expect(responseData.success).toBe(false);
    expect(responseData.error.code).toBe('UNAUTHORIZED');
  });

  it('should handle validation errors', async () => {
    // Create request with invalid body
    const request = new Request('http://localhost/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-token',
      },
      body: JSON.stringify({
        // Missing messages
        options: {
          enhanceWithContext: true,
        },
      }),
    });

    // Execute request
    const response = await app.fetch(request, mockEnv);

    // Verify response
    expect(response.status).toBe(400);

    const responseData = await response.json();
    expect(responseData.success).toBe(false);
    expect(responseData.error.code).toBe('VALIDATION_ERROR');
  });
});
```

## Performance Testing

Performance tests verify that the system meets performance requirements. For the Chat RAG Graph, performance tests focus on response time and resource usage.

Example performance test:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildChatGraph } from '../../src/graph';
import { AgentState } from '../../src/types';

// Mock dependencies
vi.mock('../../src/services/llmService');
vi.mock('../../src/services/searchService');

describe('Chat RAG Graph Performance', () => {
  // Mock environment
  const mockEnv = {
    AI: {
      run: vi.fn(),
    },
    D1: {},
  } as unknown as Bindings;

  beforeEach(() => {
    vi.clearAllMocks();

    // Set up mocks for performance testing
    // ...
  });

  it('should process a query within acceptable time limits', async () => {
    // Create the graph
    const graph = await buildChatGraph(mockEnv);

    // Create initial state
    const initialState: AgentState = {
      userId: 'user-123',
      messages: [{ role: 'user', content: 'What is the capital of France?' }],
      options: {
        enhanceWithContext: true,
        maxContextItems: 5,
        includeSourceInfo: true,
        maxTokens: 1000,
      },
      metadata: {
        startTime: Date.now(),
        nodeTimings: {},
        tokenCounts: {},
      },
    };

    // Measure execution time
    const startTime = performance.now();
    const result = await graph.invoke(initialState);
    const endTime = performance.now();
    const executionTime = endTime - startTime;

    // Verify execution time is within acceptable limits
    // Note: This is a simplified example. In a real test, you would need to
    // account for the mock execution time vs. real execution time.
    expect(executionTime).toBeLessThan(5000); // 5 seconds

    // Verify individual node timings
    for (const [nodeName, timing] of Object.entries(result.metadata?.nodeTimings || {})) {
      expect(timing).toBeLessThan(2000); // 2 seconds per node
    }
  });

  it('should handle multiple concurrent requests', async () => {
    // Create the graph
    const graph = await buildChatGraph(mockEnv);

    // Create multiple initial states
    const initialStates = Array.from({ length: 10 }, (_, i) => ({
      userId: `user-${i}`,
      messages: [{ role: 'user', content: `Query ${i}` }],
      options: {
        enhanceWithContext: true,
        maxContextItems: 5,
        includeSourceInfo: true,
        maxTokens: 1000,
      },
      metadata: {
        startTime: Date.now(),
        nodeTimings: {},
        tokenCounts: {},
      },
    }));

    // Execute all requests concurrently
    const startTime = performance.now();
    const results = await Promise.all(initialStates.map(state => graph.invoke(state)));
    const endTime = performance.now();
    const totalExecutionTime = endTime - startTime;

    // Verify all requests completed successfully
    expect(results).toHaveLength(initialStates.length);
    results.forEach(result => {
      expect(result.generatedText).toBeDefined();
    });

    // Verify total execution time is within acceptable limits
    // This will depend on your specific performance requirements
    expect(totalExecutionTime).toBeLessThan(10000); // 10 seconds for 10 requests
  });
});
```

## Running Tests

### Running All Tests

```bash
pnpm test
```

### Running Specific Tests

```bash
# Run tests in a specific file
pnpm test src/nodes/splitRewrite.test.ts

# Run tests matching a pattern
pnpm test -- -t "should process a query"
```

### Running Tests with Coverage

```bash
pnpm test:coverage
```

## Continuous Integration

The Chat RAG Graph solution uses GitHub Actions for continuous integration. The CI pipeline runs all tests on every pull request and push to the main branch.

Example CI configuration:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: 18
          cache: 'pnpm'
      - run: pnpm install
      - run: pnpm lint
      - run: pnpm typecheck
      - run: pnpm test
```

## Best Practices for Testing

1. **Test Coverage**: Aim for high test coverage, especially for critical components.

2. **Test Isolation**: Ensure tests are isolated and don't depend on each other.

3. **Mock External Dependencies**: Use mocks for external services to ensure tests are reliable and fast.

4. **Test Edge Cases**: Include tests for edge cases and error conditions.

5. **Performance Testing**: Include performance tests to ensure the system meets performance requirements.

6. **Continuous Integration**: Run tests automatically on every pull request and push to the main branch.

7. **Test Documentation**: Document test scenarios and expected outcomes.

8. **Test Maintenance**: Keep tests up to date as the system evolves.

## Conclusion

Comprehensive testing is essential for ensuring the reliability and performance of the Chat RAG Graph solution. By following the testing practices outlined in this guide, you can ensure that the system works correctly and meets performance requirements.

For more information on other aspects of the system, see the [Technical Documentation](../technical/README.md).
