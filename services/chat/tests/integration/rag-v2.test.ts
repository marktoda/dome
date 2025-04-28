// @ts-nocheck
/* 
 * This test file contains integration tests for the RAG Chat V2 implementation.
 * TypeScript checking is disabled for this file due to extensive mocking of services.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildChatGraph } from '../../src/graph';
import { AgentState, Document, UserTaskEntity, ToolResult, QueryAnalysis } from '../../src/types';
import { LlmService } from '../../src/services/llmService';
import { SearchService } from '../../src/services/searchService';
import { ObservabilityService } from '../../src/services/observabilityService';
import { ToolRegistry, ToolCategory, ToolParameter, ToolDefinition } from '../../src/tools/registry';
import { FeatureFlagService, FeatureFlag } from '../../src/utils/featureFlags';
import { getCache } from '../../src/utils/cache';

// Type declaration for Env to satisfy TypeScript
declare global {
  interface Env {
    AI: any;
    CHAT_DB: any;
    DOME_API_URL: string;
    DOME_API_KEY: string;
    D1: any;
    VERSION: string;
    LOG_LEVEL: string;
    ENVIRONMENT: string;
    ENABLE_DYNAMIC_WIDENING: string;
    ENABLE_TOOL_REGISTRY: string;
    ENABLE_ADVANCED_RETRIEVAL: string;
    ENABLE_CACHING: string;
    ENABLE_PARALLEL_PROCESSING: string;
    [key: string]: any;
  }
}

// Mock dependencies
vi.mock('../../src/services/llmService', () => ({
  LlmService: {
    rewriteQuery: vi.fn(),
    analyzeQuery: vi.fn(),
    call: vi.fn(),
    MODEL: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  },
}));

vi.mock('../../src/services/searchService', () => ({
  SearchService: {
    extractSourceMetadata: vi.fn(),
    rankAndFilterDocuments: vi.fn(),
  },
}));

vi.mock('../../src/services/observabilityService', () => ({
  ObservabilityService: {
    initTrace: vi.fn(),
    startSpan: vi.fn(),
    endSpan: vi.fn(),
    logEvent: vi.fn(),
    endTrace: vi.fn(),
    logLlmCall: vi.fn(),
    logRetrieval: vi.fn(),
  },
}));

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
    withLogger: vi.fn((context: any, fn: () => any) => fn()),
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

describe('RAG Chat V2 Integration Tests', () => {
  // Mock environment
  const mockEnv = {
    AI: {
      run: vi.fn(),
    },
    CHAT_DB: {},
    DOME_API_URL: 'https://api.dome.cloud',
    DOME_API_KEY: 'test-api-key',
    D1: {},
    VERSION: '0.2.0', 
    LOG_LEVEL: 'debug',
    ENVIRONMENT: 'test',
    ENABLE_DYNAMIC_WIDENING: 'true',
    ENABLE_TOOL_REGISTRY: 'true',
    ENABLE_ADVANCED_RETRIEVAL: 'true',
    ENABLE_CACHING: 'true',
    ENABLE_PARALLEL_PROCESSING: 'false',
  };

  // Mock user ID
  const mockUserId = 'user-123';

  // Mock documents
  const mockDocs = [
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

  // Mock tools
  const calculatorTool = {
    name: 'calculator',
    description: 'A tool that performs calculations',
    category: ToolCategory.UTILITY,
    requiresAuth: false,
    parameters: [
      {
        name: 'expression',
        type: 'string',
        description: 'The expression to calculate',
        required: true,
      },
    ],
    examples: ['Calculate 2 + 2'],
    execute: async ({ expression }) => {
      try {
        const result = eval(expression.replace(/[^0-9+\-*/(). ]/g, ''));
        return {
          result,
          explanation: `The result of ${expression} is ${result}`,
        };
      } catch (error) {
        throw new Error(`Error calculating ${expression}: ${error}`);
      }
    },
  };

  const weatherTool = {
    name: 'weather',
    description: 'A tool that provides weather information',
    category: ToolCategory.UTILITY,
    requiresAuth: false,
    parameters: [
      {
        name: 'location',
        type: 'string',
        description: 'The location to get weather for',
        required: true,
      },
    ],
    examples: ['Get weather in New York'],
    execute: async ({ location }) => {
      return {
        temperature: 72,
        condition: 'Sunny',
        location: location,
        forecast: 'Clear skies for the next 24 hours',
      };
    },
  };

  // Create reusable mock factories
  const createMockTaskEntity = (id = 'task-1', definition = 'test query') => ({
    id,
    definition,
    completable: true,
    docs: [],
  });

  const createMockToolResult = (
    toolName,
    input,
    output,
    error
  ) => ({
    toolName,
    input,
    output,
    executionTimeMs: 100,
    error,
  });

  const createQueryAnalysis = (
    isComplex,
    shouldSplit,
    reason,
    suggestedQueries
  ) => ({
    isComplex,
    shouldSplit,
    reason,
    suggestedQueries,
  });

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

    // Add reset method mock
    ToolRegistry.reset = vi.fn().mockImplementation(() => {
      vi.mocked(ToolRegistry.hasTool).mockReturnValue(false);
    });
    
    // Mock tool registry
    const calculatorToolWithCorrectType = {
      ...calculatorTool,
      parameters: [
        {
          name: 'expression',
          type: 'string',
          description: 'The expression to calculate',
          required: true,
        },
      ]
    };
    
    const weatherToolWithCorrectType = {
      ...weatherTool,
      parameters: [
        {
          name: 'location',
          type: 'string',
          description: 'The location to get weather for',
          required: true,
        },
      ]
    };
    
    ToolRegistry.reset();
    ToolRegistry.registerTool(calculatorToolWithCorrectType);
    ToolRegistry.registerTool(weatherToolWithCorrectType);

    // Initialize caches
    getCache('llm-responses', { ttl: 15 * 60 * 1000, maxSize: 1000 });
    getCache('search-results', { ttl: 5 * 60 * 1000, maxSize: 500 });

    // Mock LlmService methods
    vi.mocked(LlmService.rewriteQuery).mockResolvedValue('rewritten query');
    vi.mocked(LlmService.analyzeQuery).mockResolvedValue({
      isComplex: false,
      shouldSplit: false,
      reason: 'Query is simple',
    });
    
    vi.mocked(LlmService.call).mockImplementation(async (env, messages, options) => {
      // Mock different responses based on the content of the messages
      const lastMessage = messages[messages.length - 1].content;

      if (lastMessage.includes('task splitting')) {
        return JSON.stringify({
          tasks: [
            { id: 'task-1', definition: 'What is the capital of France?' },
            { id: 'task-2', definition: 'What is the population of Paris?' },
          ],
          instructions: '',
        });
      } else if (lastMessage.includes('tool selection')) {
        if (lastMessage.includes('calculator')) {
          return JSON.stringify({
            toolName: 'calculator',
            confidence: 0.9,
            reason: 'The query is asking for a calculation',
          });
        } else if (lastMessage.includes('weather')) {
          return JSON.stringify({
            toolName: 'weather',
            confidence: 0.85,
            reason: 'The query is asking for weather information',
          });
        } else {
          return JSON.stringify({
            toolName: null,
            confidence: 0.7,
            reason: 'No specific tool is needed for this query',
          });
        }
      } else if (lastMessage.includes('parameter extraction')) {
        if (lastMessage.includes('calculator')) {
          return JSON.stringify({
            expression: '2 + 2',
          });
        } else if (lastMessage.includes('weather')) {
          return JSON.stringify({
            location: 'New York',
          });
        }
      }

      return 'This is a test response';
    });

    // Create a static search method
    SearchService.search = vi.fn().mockResolvedValue(mockDocs);
    
    vi.mocked(SearchService.extractSourceMetadata).mockReturnValue(
      mockDocs.map(doc => ({
        id: doc.id,
        title: doc.title,
        source: doc.metadata.source,
        url: doc.metadata.url || null,
        relevanceScore: doc.metadata.relevanceScore,
      }))
    );
    
    vi.mocked(SearchService.rankAndFilterDocuments).mockReturnValue(mockDocs);
    
    // Create a static widenSearchParameters method
    SearchService.widenSearchParameters = vi.fn().mockReturnValue({
      strategy: 'relaxThreshold',
      newThreshold: 0.5,
      originalThreshold: 0.7
    });

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

  it('processes a simple query through the basic path', async () => {
    // Create the graph
    const graph = await buildChatGraph(mockEnv);

    // Create initial state
    const initialState = {
      userId: mockUserId,
      messages: [{ role: 'user', content: 'What is the capital of France?' }],
      options: {
        enhanceWithContext: true,
        maxContextItems: 5,
        includeSourceInfo: true,
        maxTokens: 1000,
        temperature: 0.7,
      },
      metadata: {
        startTime: Date.now(),
        nodeTimings: {},
        tokenCounts: {},
      },
      tasks: {},
    };

    // Execute the graph
    const result = await graph.invoke({
      configurable: {
        state: initialState,
        config: {
          runId: 'test-rag-v2-1',
        },
      },
    });

    // Type cast the result
    const typedResult = result;
    expect(typedResult.generatedText).toBeDefined();
    expect(typedResult.docs).toHaveLength(2);

    // Verify that the flow went through the right nodes
    expect(typedResult.metadata?.nodeTimings).toHaveProperty('routing_split');
    expect(typedResult.metadata?.nodeTimings).toHaveProperty('filter_history');
    expect(typedResult.metadata?.nodeTimings).toHaveProperty('rewrite');
    expect(typedResult.metadata?.nodeTimings).toHaveProperty('retrieve');
    expect(typedResult.metadata?.nodeTimings).toHaveProperty('tool_routing');
    expect(typedResult.metadata?.nodeTimings).toHaveProperty('generate_rag');

    // Verify that search was called
    expect(SearchService.search).toHaveBeenCalledWith(
      mockEnv,
      expect.objectContaining({
        userId: mockUserId,
        query: 'rewritten query',
      }),
    );

    // Verify that no tool was executed
    expect(typedResult.tasks?.toolToRun).toBeUndefined();
  });

  it('handles multi-task queries with proper splitting', async () => {
    // Mock complex query analysis
    vi.mocked(LlmService.analyzeQuery).mockResolvedValue({
      isComplex: true,
      shouldSplit: true,
      reason: 'Query contains multiple questions',
      suggestedQueries: [
        'What is the capital of France?', 
        'What is the population of Paris?'
      ],
    });

    // Mock the task splitting call
    vi.mocked(LlmService.call).mockImplementation(async (env, messages) => {
      const lastMessage = messages[messages.length - 1].content;
      
      if (lastMessage.includes('split') || lastMessage.includes('task')) {
        return JSON.stringify({
          tasks: [
            { id: 'task-1', definition: 'What is the capital of France?' },
            { id: 'task-2', definition: 'What is the population of Paris?' },
          ],
          instructions: '',
        });
      }
      
      return 'Default response';
    });

    // Create the graph
    const graph = await buildChatGraph(mockEnv);

    // Create initial state with a complex query
    const initialState = {
      userId: mockUserId,
      messages: [
        { role: 'user', content: 'What is the capital of France and what is its population?' },
      ],
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
      tasks: {},
    };

    // Execute the graph
    const result = await graph.invoke({
      configurable: {
        state: initialState,
        config: {
          runId: 'test-rag-v2-2',
        },
      },
    });

    const typedResult = result;
    expect(typedResult.generatedText).toBeDefined();

    // Verify that task splitting occurred
    expect(typedResult.taskEntities).toBeDefined();
    expect(Object.keys(typedResult.taskEntities || {})).toHaveLength(2);
    
    // Verify that search was called multiple times (once per task)
    expect(SearchService.search).toHaveBeenCalledTimes(2);
    
    // Verify that the tasks were processed
    const taskIds = Object.keys(typedResult.taskEntities || {});
    expect(taskIds).toHaveLength(2);
    
    // Verify that the routing split node was used
    expect(typedResult.metadata?.nodeTimings?.routing_split).toBeDefined();
    
    // Verify that the graph properly combined results from both tasks
    expect(typedResult.generatedText).toContain('This is a test response');
  });

  it('selects and executes appropriate tools', async () => {
    // Mock the tool selection call
    vi.mocked(LlmService.call).mockImplementation(async (env, messages) => {
      const lastMessage = messages[messages.length - 1].content;
      
      if (lastMessage.includes('calculator') || lastMessage.includes('calculation')) {
        if (lastMessage.includes('parameter')) {
          return JSON.stringify({
            expression: '2 + 2',
          });
        }
        
        return JSON.stringify({
          toolName: 'calculator',
          confidence: 0.9,
          reason: 'The query is asking for a calculation',
        });
      }
      
      return 'Default response';
    });

    // Create the graph
    const graph = await buildChatGraph(mockEnv);

    // Create initial state with a calculation query
    const initialState = {
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
      },
      tasks: {},
    };

    // Execute the graph
    const result = await graph.invoke({
      configurable: {
        state: initialState,
        config: {
          runId: 'test-rag-v2-3',
        },
      },
    });

    const typedResult = result;
    expect(typedResult.generatedText).toBeDefined();

    // Verify that tool selection occurred
    expect(typedResult.tasks?.toolToRun).toBe('calculator');
    
    // Verify that tool execution was logged
    expect(ObservabilityService.logEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.any(String),
      'tool_execution_complete',
      expect.objectContaining({
        toolName: 'calculator',
      }),
    );
    
    // Verify that the tool routing node was used
    expect(typedResult.metadata?.nodeTimings?.tool_routing).toBeDefined();
    
    // Verify that the run_tool node was used
    expect(typedResult.metadata?.nodeTimings?.run_tool).toBeDefined();
  });

  it('handles dynamic retrieval widening when few results are found', async () => {
    // First return empty results, then return results after widening
    SearchService.search
      .mockResolvedValueOnce([]) // First call returns no results
      .mockResolvedValueOnce(mockDocs); // Second call after widening returns results

    // Create the graph
    const graph = await buildChatGraph(mockEnv);

    // Create initial state
    const initialState = {
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
      },
      tasks: {},
    };

    // Execute the graph
    const result = await graph.invoke({
      configurable: {
        state: initialState,
        config: {
          runId: 'test-rag-v2-4',
        },
      },
    });

    const typedResult = result;
    expect(typedResult.generatedText).toBeDefined();

    // Verify that search was called twice (initial + widening)
    expect(SearchService.search).toHaveBeenCalledTimes(2);

    // Verify that widening attempts were tracked
    expect(typedResult.tasks?.wideningAttempts).toBe(1);
    
    // Verify that a widening strategy was selected
    expect(typedResult.tasks?.wideningStrategy).toBe('relaxThreshold');
    
    // Verify that the dynamic_retrieve node was used
    expect(typedResult.metadata?.nodeTimings?.dynamic_retrieve).toBeDefined();
    
    // Verify that the widenSearchParameters function was called
    expect(SearchService.widenSearchParameters).toHaveBeenCalled();
  });

  it('handles context window trimming with long conversations', async () => {
    // Create the graph
    const graph = await buildChatGraph(mockEnv);

    // Create initial state with a long conversation history
    const initialState = {
      userId: mockUserId,
      messages: [
        { role: 'user', content: 'What is the capital of France?' },
        { role: 'assistant', content: 'The capital of France is Paris.' },
        { role: 'user', content: 'What is the population of Paris?' },
        { role: 'assistant', content: 'The population of Paris is approximately 2.2 million people in the city proper.' },
        { role: 'user', content: 'Tell me more about the history of Paris.' },
        { role: 'assistant', content: 'Paris has a rich history dating back to ancient times...' },
        { role: 'user', content: 'What are the major landmarks in Paris?' },
        { role: 'assistant', content: 'Paris is home to many famous landmarks, including the Eiffel Tower, the Louvre Museum...' },
        { role: 'user', content: 'Tell me about the Eiffel Tower.' },
      ],
      options: {
        enhanceWithContext: true,
        maxContextItems: 3, // Limit to 3 most recent message pairs
        includeSourceInfo: true,
        maxTokens: 1000,
      },
      metadata: {
        startTime: Date.now(),
        nodeTimings: {},
        tokenCounts: {},
      },
      tasks: {},
    };

    // Execute the graph
    const result = await graph.invoke({
      configurable: {
        state: initialState,
        config: {
          runId: 'test-rag-v2-5',
        },
      },
    });

    const typedResult = result;
    expect(typedResult.generatedText).toBeDefined();

    // Verify that the conversation was trimmed
    expect(typedResult.chatHistory).toBeDefined();
    expect(typedResult.chatHistory?.length).toBeLessThanOrEqual(3);
    
    // Verify that the filter_history node was used
    expect(typedResult.metadata?.nodeTimings?.filter_history).toBeDefined();
    
    // Verify that the most recent messages were preserved
    expect(typedResult.chatHistory?.[typedResult.chatHistory.length - 1].user.content).toBe('Tell me about the Eiffel Tower.');
  });

  it('handles error recovery during tool execution', async () => {
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

    // Mock the tool selection call
    vi.mocked(LlmService.call).mockImplementation(async (env, messages) => {
      const lastMessage = messages[messages.length - 1].content;
      
      if (lastMessage.includes('error_tool') || lastMessage.includes('error tool')) {
        return JSON.stringify({
          toolName: 'error_tool',
          confidence: 0.9,
          reason: 'The query is asking to test the error tool',
        });
      }
      
      return 'Default response';
    });

    // Create the graph
    const graph = await buildChatGraph(mockEnv);

    // Create initial state with the error tool
    const initialState = {
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
          runId: 'test-rag-v2-6',
        },
      },
    });

    const typedResult = result;
    expect(typedResult.generatedText).toBeDefined();

    // Verify that the tool error was captured
    expect(typedResult.tasks?.toolError).toBeDefined();
    
    // Verify that the error was logged
    expect(ObservabilityService.logEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.any(String),
      'tool_execution_error',
      expect.objectContaining({
        error: expect.stringContaining('Test error'),
      }),
    );
    
    // Verify that the graph continued to generate an answer despite the error
    expect(typedResult.generatedText).toBeDefined();
    
    // Verify that error metadata was captured
    expect(typedResult.metadata?.errors).toBeDefined();
    expect(typedResult.metadata?.errors?.length).toBeGreaterThan(0);
  });

  it('verifies streaming functionality with SSE events', async () => {
    // Mock streaming response
    LlmService.streamAnswer = vi.fn().mockImplementation(async function* () {
      yield 'This is a streaming response that would be sent as SSE events';
    });

    // Create the graph
    const graph = await buildChatGraph(mockEnv);

    // Create initial state
    const initialState = {
      userId: mockUserId,
      messages: [{ role: 'user', content: 'Tell me about Paris' }],
      options: {
        enhanceWithContext: true,
        maxContextItems: 5,
        includeSourceInfo: true,
        maxTokens: 1000,
        temperature: 0.7,
      },
      metadata: {
        startTime: Date.now(),
        nodeTimings: {},
        tokenCounts: {},
      },
      tasks: {},
    };

    // Execute the graph
    const result = await graph.invoke({
      configurable: {
        state: initialState,
        config: {
          runId: 'test-rag-v2-7',
        },
      },
    });

    const typedResult = result;
    expect(typedResult.generatedText).toBeDefined();
    
    // Verify that the response was generated
    expect(typedResult.generatedText).toBe('This is a streaming response that would be sent as SSE events');
    
    // Verify that node timings were recorded for each step
    expect(Object.keys(typedResult.metadata?.nodeTimings || {})).toHaveLength(5);
    
    // Verify that the workflow steps were logged (would be converted to SSE events)
    expect(ObservabilityService.logEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.any(String),
      'workflow_step_complete',
      expect.any(Object),
    );
  });

  it('handles source attributions correctly', async () => {
    // Mock more detailed documents with attributions
    const attributedDocs = [
      {
        id: 'doc-attr-1',
        title: 'Paris: The City of Light',
        body: 'Paris is the capital of France and is known as the City of Light.',
        metadata: {
          source: 'travel-guide',
          createdAt: new Date().toISOString(),
          relevanceScore: 0.98,
          url: 'https://example.com/travel/paris',
          mimeType: 'text/html',
        },
      },
      {
        id: 'doc-attr-2',
        title: 'Paris Demographics',
        body: 'Paris has a population of approximately 2.2 million people within the city limits.',
        metadata: {
          source: 'encyclopedia',
          createdAt: new Date().toISOString(),
          relevanceScore: 0.92,
          url: 'https://example.com/encyclopedia/paris',
          mimeType: 'text/html',
        },
      },
    ];

    // Mock search to return our attributed documents
    SearchService.search.mockResolvedValue(attributedDocs);
    vi.mocked(SearchService.extractSourceMetadata).mockReturnValue(
      attributedDocs.map(doc => ({
        id: doc.id,
        title: doc.title,
        source: doc.metadata.source,
        url: doc.metadata.url || null,
        relevanceScore: doc.metadata.relevanceScore,
      })),
    );
    vi.mocked(SearchService.rankAndFilterDocuments).mockReturnValue(attributedDocs);

    // Create the graph
    const graph = await buildChatGraph(mockEnv);

    // Create initial state
    const initialState = {
      userId: mockUserId,
      messages: [{ role: 'user', content: 'Tell me about Paris' }],
      options: {
        enhanceWithContext: true,
        maxContextItems: 5,
        includeSourceInfo: true, // Important for source attribution
        maxTokens: 1000,
      },
      metadata: {
        startTime: Date.now(),
        nodeTimings: {},
        tokenCounts: {},
      },
      tasks: {},
    };

    // Execute the graph
    const result = await graph.invoke({
      configurable: {
        state: initialState,
        config: {
          runId: 'test-rag-v2-8',
        },
      },
    });

    const typedResult = result;
    expect(typedResult.generatedText).toBeDefined();
    
    // Verify that the documents were retrieved
    expect(typedResult.docs).toHaveLength(2);
    
    // Verify that the documents were propagated to the final state
    expect(typedResult.docs?.[0].id).toBe('doc-attr-1');
    expect(typedResult.docs?.[1].id).toBe('doc-attr-2');
    
    // Verify that source extraction was called
    expect(SearchService.extractSourceMetadata).toHaveBeenCalled();
  });
});