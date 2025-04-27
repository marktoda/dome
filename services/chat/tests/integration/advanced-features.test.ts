import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildChatGraph } from '../../src/graph';
import { AgentState, Document } from '../../src/types';
import { LlmService } from '../../src/services/llmService';
import { SearchService } from '../../src/services/searchService';
import { ObservabilityService } from '../../src/services/observabilityService';
import { FeatureFlagService, FeatureFlag } from '../../src/utils/featureFlags';
import { ToolRegistry, ToolCategory } from '../../src/tools/registry';
import { registerDefaultTools } from '../../src/tools/defaultTools';
import { getCache } from '../../src/utils/cache';

// Mock dependencies
vi.mock('../../src/services/llmService');
vi.mock('../../src/services/searchService');
vi.mock('../../src/services/observabilityService');

// Mock logger
vi.mock('@dome/logging', () => {
  // Create a mockLogger that can be reused
  const mockLogger = {
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
  };

  return {
    getLogger: vi.fn(() => mockLogger),
    logError: vi.fn(),
    metrics: {
      increment: vi.fn(),
      timing: vi.fn(),
      gauge: vi.fn(),
      startTimer: vi.fn(() => ({ stop: vi.fn() })),
      trackOperation: vi.fn(),
    },
    withLogger: vi.fn((_, fn) => fn()),
    baseLogger: mockLogger,
    createLogger: vi.fn(() => mockLogger),
    createServiceMetrics: vi.fn(() => ({
      counter: vi.fn(),
      gauge: vi.fn(),
      timing: vi.fn(),
      startTimer: vi.fn(() => ({ stop: vi.fn() })),
      trackOperation: vi.fn(),
    })),
  };
});

// Mock D1Checkpointer
vi.mock('../../src/checkpointer/d1Checkpointer', () => {
  return {
    D1Checkpointer: class MockCheckpointer {
      constructor() {}
      initialize = vi.fn().mockResolvedValue(undefined);
      get = vi.fn().mockResolvedValue(null);
      put = vi.fn().mockResolvedValue(undefined);
    },
  };
});

describe('Chat RAG Graph Advanced Features Tests', () => {
  // Mock environment
  const mockEnv = {
    AI: {
      run: vi.fn(),
    },
    DOME_API_URL: 'https://api.dome.cloud',
    DOME_API_KEY: 'test-api-key',
    D1: {},
    ENABLE_DYNAMIC_WIDENING: 'true',
    ENABLE_TOOL_REGISTRY: 'true',
    ENABLE_ADVANCED_RETRIEVAL: 'true',
    ENABLE_CACHING: 'true',
    ENABLE_PARALLEL_PROCESSING: 'false',
  } as unknown as Env;

  // Mock user ID
  const mockUserId = 'user-123';

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
        url: 'https://example.com/doc1',
        mimeType: 'text/plain',
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
        url: 'https://example.com/doc2',
        mimeType: 'text/plain',
      },
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();

    // Initialize feature flags
    FeatureFlagService.initialize({
      flags: {
        [FeatureFlag.ENABLE_DYNAMIC_WIDENING]: true,
        [FeatureFlag.ENABLE_TOOL_REGISTRY]: true,
        [FeatureFlag.ENABLE_ADVANCED_RETRIEVAL]: true,
        [FeatureFlag.ENABLE_CACHING]: true,
        [FeatureFlag.ENABLE_PARALLEL_PROCESSING]: false,
      },
    });

    // Register default tools
    registerDefaultTools();

    // Initialize caches
    getCache<string>('llm-responses', { ttl: 15 * 60 * 1000, maxSize: 1000 });
    getCache<any[]>('search-results', { ttl: 5 * 60 * 1000, maxSize: 500 });

    // Mock LlmService methods
    vi.mocked(LlmService.rewriteQuery).mockResolvedValue('rewritten query');
    vi.mocked(LlmService.analyzeQueryComplexity).mockResolvedValue({
      isComplex: false,
      shouldSplit: false,
      reason: 'Query is simple',
    });
    vi.mocked(LlmService.generateResponse).mockResolvedValue('This is a test response');
    vi.mocked(LlmService.call).mockImplementation(async (env, messages, options) => {
      // Mock different responses based on the content of the messages
      const lastMessage = messages[messages.length - 1].content;

      if (lastMessage.includes('tool selection')) {
        return JSON.stringify({
          toolName: 'calculator',
          confidence: 0.9,
          reason: 'The query is asking for a calculation',
        });
      } else if (lastMessage.includes('parameter extraction')) {
        return JSON.stringify({
          expression: '2 + 2',
        });
      }

      return 'This is a test response';
    });

    // Mock SearchService methods
    vi.mocked(SearchService.search).mockResolvedValue(mockDocs);
    vi.mocked(SearchService.extractSourceMetadata).mockReturnValue(
      mockDocs.map(doc => ({
        id: doc.id,
        title: doc.title,
        source: doc.metadata.source,
        url: doc.metadata.url || null,
        relevanceScore: doc.metadata.relevanceScore,
      })),
    );
    vi.mocked(SearchService.rankAndFilterDocuments).mockReturnValue(mockDocs);

    // Mock ObservabilityService methods
    vi.mocked(ObservabilityService.initTrace).mockReturnValue('test-trace-id');
    vi.mocked(ObservabilityService.startSpan).mockReturnValue('test-span-id');
    vi.mocked(ObservabilityService.endSpan).mockImplementation(() => {});
    vi.mocked(ObservabilityService.logEvent).mockImplementation(() => {});
    vi.mocked(ObservabilityService.endTrace).mockImplementation(() => {});
    vi.mocked(ObservabilityService.logLlmCall).mockImplementation(() => {});
    vi.mocked(ObservabilityService.logRetrieval).mockImplementation(() => {});
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('should use dynamic widening when few results are found', async () => {
    // First return empty results, then return results after widening
    vi.mocked(SearchService.search)
      .mockResolvedValueOnce([]) // First call returns no results
      .mockResolvedValueOnce(mockDocs); // Second call after widening returns results

    // Create the graph
    const graph = await buildChatGraph(mockEnv);

    // Create initial state
    const initialState: AgentState = {
      userId: mockUserId,
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
        traceId: 'test-trace-id',
      },
    };

    // Execute the graph
    const result = await graph.invoke({
      configurable: {
        state: initialState,
        config: {
          runId: 'test-advanced-1',
        },
      },
    });

    // Verify the result
    expect(result).toBeDefined();
    expect(result.generatedText).toBeDefined();

    // Verify that search was called twice (initial + widening)
    expect(SearchService.search).toHaveBeenCalledTimes(2);

    // Verify that widening attempts were tracked
    expect(result.tasks?.wideningAttempts).toBe(1);

    // Verify that a widening strategy was selected
    expect(result.tasks?.wideningStrategy).toBeDefined();
    expect(result.tasks?.wideningParams).toBeDefined();

    // Verify that observability was used
    expect(ObservabilityService.logEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.any(String),
      'widening_parameters_adjusted',
      expect.objectContaining({
        wideningAttempts: 1,
        strategy: expect.any(String),
      }),
    );
  });

  it('should use the tool registry to execute a calculator tool', async () => {
    // Create the graph
    const graph = await buildChatGraph(mockEnv);

    // Create initial state with a calculation query
    const initialState: AgentState = {
      userId: mockUserId,
      messages: [{ role: 'user', content: 'Calculate 2 + 2' }],
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
        traceId: 'test-trace-id',
      },
      tasks: {
        requiredTools: ['calculator'],
      },
    };

    // Execute the graph
    const result = await graph.invoke({
      configurable: {
        state: initialState,
        config: {
          runId: 'test-advanced-2',
        },
      },
    });

    // Verify the result
    expect(result).toBeDefined();
    expect(result.generatedText).toBeDefined();

    // Verify that the tool router was used
    expect(result.tasks?.toolToRun).toBe('calculator');

    // Verify that the tool was executed
    expect(result.tasks?.toolResults).toBeDefined();
    expect(result.tasks?.toolResults?.length).toBe(1);
    expect(result.tasks?.toolResults?.[0].toolName).toBe('calculator');

    // Verify that observability was used
    expect(ObservabilityService.logEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.any(String),
      'tool_execution_complete',
      expect.objectContaining({
        toolName: 'calculator',
      }),
    );
  });

  it('should use caching for LLM responses', async () => {
    // Get the LLM response cache
    const cache = getCache<string>('llm-responses', { ttl: 15 * 60 * 1000 });

    // Set a cached response
    const cacheKey = 'llm:What is the capital of France?';
    cache.set(cacheKey, 'Paris is the capital of France.');

    // Create the graph
    const graph = await buildChatGraph(mockEnv);

    // Create initial state
    const initialState: AgentState = {
      userId: mockUserId,
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
        traceId: 'test-trace-id',
      },
    };

    // Execute the graph
    const result = await graph.invoke({
      configurable: {
        state: initialState,
        config: {
          runId: 'test-advanced-3',
        },
      },
    });

    // Verify the result
    expect(result).toBeDefined();
    expect(result.generatedText).toBeDefined();

    // Verify cache statistics
    const stats = cache.getStats();
    expect(stats.hits).toBeGreaterThan(0);
  });

  it('should handle tool execution errors gracefully', async () => {
    // Create a mock tool that throws an error
    ToolRegistry.registerTool({
      name: 'error_tool',
      description: 'A tool that always throws an error',
      category: ToolCategory.UTILITY,
      requiresAuth: false,
      parameters: [],
      examples: ['Test the error tool'],
      execute: async () => {
        throw new Error('Test error');
      },
    });

    // Create the graph
    const graph = await buildChatGraph(mockEnv);

    // Create initial state with the error tool
    const initialState: AgentState = {
      userId: mockUserId,
      messages: [{ role: 'user', content: 'Test the error tool' }],
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
        traceId: 'test-trace-id',
      },
      tasks: {
        requiredTools: ['error_tool'],
      },
    };

    // Execute the graph
    const result = await graph.invoke({
      configurable: {
        state: initialState,
        config: {
          runId: 'test-advanced-4',
        },
      },
    });

    // Verify the result
    expect(result).toBeDefined();
    expect(result.generatedText).toBeDefined();

    // Verify that the tool error was captured
    expect(result.tasks?.toolResults).toBeDefined();
    expect(result.tasks?.toolResults?.length).toBe(1);
    expect(result.tasks?.toolResults?.[0].error).toBe('Test error');

    // Verify that the error was logged
    expect(ObservabilityService.logEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.any(String),
      'tool_execution_error',
      expect.objectContaining({
        error: 'Test error',
      }),
    );

    // Verify that the graph continued to generate an answer despite the error
    expect(result.generatedText).toBeDefined();
  });
});
