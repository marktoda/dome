import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildChatGraph } from '../../src/graph';
import { AgentState, Document } from '../../src/types';
import { LlmService } from '../../src/services/llmService';
import { SearchService } from '../../src/services/searchService';
import { ObservabilityService } from '../../src/services/observabilityService';

// Mock dependencies
vi.mock('../../src/services/llmService', () => ({
  LlmService: {
    rewriteQuery: vi.fn(),
    analyzeQuery: vi.fn(),
    call: vi.fn(),
    stream: vi.fn(),
    MODEL: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  },
}));

// Create a mock for SearchService
const mockSearchFn = vi.fn();
// Create mock class
class MockSearchService {
  search = mockSearchFn;
  constructor() {}
}

// Mock the SearchService module
vi.mock('../../src/services/searchService', () => ({
  SearchService: {
    fromEnv: vi.fn().mockImplementation(() => new MockSearchService()),
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
      getTuple = vi.fn().mockResolvedValue(undefined);
      put = vi.fn().mockResolvedValue(undefined);
      putWrites = vi.fn().mockResolvedValue(undefined);
      list = vi.fn().mockImplementation(async function*() {
        // Empty generator
        return;
      });
      readCheckpoint = vi.fn().mockResolvedValue(null);
      writeCheckpoint = vi.fn().mockResolvedValue(undefined);
    },
  };
});

describe('Chat RAG Graph Integration Tests', () => {
  // Mock environment
  const mockEnv = {
    AI: {
      run: vi.fn(),
    },
    CHAT_DB: {}, // Add required CHAT_DB property
    DOME_API_URL: 'https://api.dome.cloud',
    DOME_API_KEY: 'test-api-key',
    D1: {},
    VERSION: '0.1.0', // Add required VERSION property
    LOG_LEVEL: 'debug',
    ENVIRONMENT: 'test',
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

    // Mock LlmService methods
    vi.mocked(LlmService.rewriteQuery).mockResolvedValue('rewritten query');
    vi.mocked(LlmService.analyzeQuery).mockResolvedValue({
      isComplex: false,
      shouldSplit: false,
      reason: 'Query is simple',
    });
    vi.mocked(LlmService.call).mockResolvedValue('This is a test response');
    vi.mocked(LlmService.stream).mockImplementation(async function* () {
      yield 'This is a test response';
    });

    // Mock SearchService methods
    mockSearchFn.mockResolvedValue(mockDocs);
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

  it('should process a simple query through the entire graph', async () => {
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
        temperature: 0.7,
      },
      metadata: {
        startTime: Date.now(),
        nodeTimings: {},
        tokenCounts: {},
      },
    };

    // Execute the graph
    const result = await graph.invoke(initialState) as AgentState;

    // Verify the result
    expect(result).toBeDefined();
    expect(result.generatedText).toBeDefined();
    expect(result.docs).toHaveLength(2);

    // Verify that all nodes were executed
    expect(result.metadata?.nodeTimings).toHaveProperty('splitRewrite');
    expect(result.metadata?.nodeTimings).toHaveProperty('retrieve');
    expect(result.metadata?.nodeTimings).toHaveProperty('generateAnswer');

    // Verify that the LLM service was called
    expect(LlmService.analyzeQuery).toHaveBeenCalledWith(
      mockEnv,
      'What is the capital of France?',
      expect.any(Object),
    );

    expect(LlmService.call).toHaveBeenCalled();

    // Verify that the search service was called
    expect(mockSearchFn).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: mockUserId,
        query: 'rewritten query',
      }),
    );

    // Verify that observability was used
    expect(ObservabilityService.initTrace).toHaveBeenCalled();
    expect(ObservabilityService.startSpan).toHaveBeenCalled();
    expect(ObservabilityService.logEvent).toHaveBeenCalled();
    expect(ObservabilityService.endTrace).toHaveBeenCalled();
  });

  it('should handle complex queries that need rewriting', async () => {
    // Mock a complex query analysis
    vi.mocked(LlmService.analyzeQuery).mockResolvedValue({
      isComplex: true,
      shouldSplit: true,
      reason: 'Query contains multiple questions',
      suggested: ['What is the capital of France?', 'What is the population of Paris?'],
    });

    // Create the graph
    const graph = await buildChatGraph(mockEnv);

    // Create initial state with a complex query
    const initialState: AgentState = {
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
    };

    // Execute the graph
    const result = await graph.invoke(initialState) as AgentState;

    // Verify the result
    expect(result).toBeDefined();
    expect(result.generatedText).toBeDefined();

    // Verify that query analysis was performed
    expect(LlmService.analyzeQuery).toHaveBeenCalledWith(
      mockEnv,
      'What is the capital of France and what is its population?',
      expect.any(Object),
    );

    // Verify that query rewriting was performed
    expect(LlmService.rewriteQuery).toHaveBeenCalled();

    // Verify that the query analysis was stored in the state
    expect(result.taskEntities && Object.values(result.taskEntities)[0]?.queryAnalysis).toBeDefined();
    expect(result.taskEntities && Object.values(result.taskEntities)[0]?.queryAnalysis?.isComplex).toBe(true);
  });

  it('should handle retrieval widening when few results are found', async () => {
    // Reset the search mock function and configure it for this test
    mockSearchFn.mockReset();
    mockSearchFn
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
      },
    };

    // Execute the graph
    const result = await graph.invoke(initialState) as AgentState;

    // Verify the result
    expect(result).toBeDefined();
    expect(result.generatedText).toBeDefined();

    // Verify that search was called twice (initial + widening)
    expect(mockSearchFn).toHaveBeenCalledTimes(2);

    // Verify that widening attempts were tracked in the task entity
    expect(result.taskEntities && Object.values(result.taskEntities)[0]?.wideningAttempts).toBe(1);
  });

  it('should handle errors gracefully', async () => {
    // Mock an error in the LLM service
    vi.mocked(LlmService.call).mockRejectedValue(new Error('LLM service error'));

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
      },
    };

    // Execute the graph
    const result = await graph.invoke(initialState) as AgentState;

    // Verify the result contains an error
    expect(result).toBeDefined();
    expect(result.metadata?.errors).toBeDefined();
    expect(result.metadata?.errors?.length).toBeGreaterThan(0);

    // Verify that a fallback response was provided
    expect(result.generatedText).toContain("I'm sorry");

    // Verify that the error was logged
    expect(ObservabilityService.logEvent).toHaveBeenCalledWith(
      mockEnv,
      expect.any(String),
      expect.any(String),
      'answer_generation_error',
      expect.objectContaining({
        error: 'LLM service error',
      }),
    );
  });
});
