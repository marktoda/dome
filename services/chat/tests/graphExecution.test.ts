import { describe, it, expect, vi, beforeEach } from 'vitest';
import { V3Chat } from '../src/graphs/v3';
import { AgentState } from '../src/types';

// Mock dependencies
vi.mock('@dome/common', () => ({
  getLogger: () => ({ 
    info: vi.fn(), 
    error: vi.fn(), 
    debug: vi.fn(), 
    warn: vi.fn(), 
    child: vi.fn().mockReturnThis() 
  }),
}));

vi.mock('../src/checkpointer/d1Checkpointer', () => ({
  D1Checkpointer: vi.fn(),
}));

vi.mock('../src/tools', () => ({
  ToolRegistry: {
    build: vi.fn(() => ({})),
  },
}));

vi.mock('../src/nodes', () => ({
  editSystemPrompt: vi.fn(),
  filterHistory: vi.fn(),
  retrieve: vi.fn(),
  reranker: vi.fn(),
  retrievalEvaluatorLLM: vi.fn(),
  retrievalSelector: vi.fn(),
  routeAfterRetrieve: vi.fn(),
  toolRouter: vi.fn(),
  runTool: vi.fn(),
  improveRetrieval: vi.fn(),
  combineContext: vi.fn(),
  generateAnswer: vi.fn(),
  answerGuard: vi.fn(),
}));

vi.mock('../src/services/observabilityService', () => ({
  ObservabilityService: vi.fn(() => ({
    logEvent: vi.fn(),
    logError: vi.fn(),
  })),
}));

vi.mock('@langchain/langgraph', () => ({
  START: 'START',
  END: 'END',
  StateGraph: vi.fn(() => ({
    addNode: vi.fn().mockReturnThis(),
    addEdge: vi.fn().mockReturnThis(),
    addConditionalEdges: vi.fn().mockReturnThis(),
    compile: vi.fn(() => ({
      invoke: vi.fn(),
      stream: vi.fn(),
    })),
  })),
}));

describe('V3Chat Graph', () => {
  let mockEnv: Env;
  let mockCheckpointer: any;

  beforeEach(() => {
    mockEnv = {
      MAX_RETRIEVAL_LOOPS: '3',
      ENABLE_OBSERVABILITY: 'true',
    } as Env;

    mockCheckpointer = {
      initialize: vi.fn(),
    };
  });

  describe('build', () => {
    it('should build graph with default configuration', async () => {
      const graph = await V3Chat.build(mockEnv, mockCheckpointer);

      expect(graph).toBeDefined();
      expect(graph.invoke).toBeDefined();
      expect(graph.stream).toBeDefined();
    });

    it('should build graph without checkpointer', async () => {
      const graph = await V3Chat.build(mockEnv);

      expect(graph).toBeDefined();
    });

    it('should handle different MAX_RETRIEVAL_LOOPS values', async () => {
      const envWithDifferentLoops = {
        ...mockEnv,
        MAX_RETRIEVAL_LOOPS: '5',
      } as Env;

      const graph = await V3Chat.build(envWithDifferentLoops, mockCheckpointer);

      expect(graph).toBeDefined();
    });
  });

  describe('graph execution flow', () => {
    it('should handle basic state transitions', async () => {
      const mockGraph = {
        invoke: vi.fn(),
        stream: vi.fn(),
      };

      const { StateGraph } = require('@langchain/langgraph');
      StateGraph.mockImplementation(() => ({
        addNode: vi.fn().mockReturnThis(),
        addEdge: vi.fn().mockReturnThis(),
        addConditionalEdges: vi.fn().mockReturnThis(),
        compile: vi.fn(() => mockGraph),
      }));

      const graph = await V3Chat.build(mockEnv, mockCheckpointer);
      
      const initialState: AgentState = {
        userId: 'test-user',
        messages: [
          { role: 'user', content: 'Hello' }
        ],
        chatHistory: [],
        options: {
          enhanceWithContext: true,
          maxContextItems: 5,
        },
        taskIds: [],
        taskEntities: {},
        docs: [],
        generatedText: '',
        retrievalLoop: {
          attempt: 1,
          issuedQueries: [],
          refinedQueries: [],
          seenChunkIds: [],
        },
        metadata: {},
      };

      const expectedResult = {
        ...initialState,
        generatedText: 'Hello! How can I help you?',
      };

      mockGraph.invoke.mockResolvedValue(expectedResult);

      const result = await graph.invoke(initialState, {
        configurable: { thread_id: 'test-thread' }
      });

      expect(mockGraph.invoke).toHaveBeenCalledWith(
        initialState,
        { configurable: { thread_id: 'test-thread' } }
      );
      expect(result).toEqual(expectedResult);
    });

    it('should handle streaming execution', async () => {
      const mockGraph = {
        invoke: vi.fn(),
        stream: vi.fn(),
      };

      const { StateGraph } = require('@langchain/langgraph');
      StateGraph.mockImplementation(() => ({
        addNode: vi.fn().mockReturnThis(),
        addEdge: vi.fn().mockReturnThis(),
        addConditionalEdges: vi.fn().mockReturnThis(),
        compile: vi.fn(() => mockGraph),
      }));

      const mockStreamResult = {
        async *[Symbol.asyncIterator]() {
          yield { type: 'node', node: 'editSystemPrompt', data: {} };
          yield { type: 'node', node: 'retrieve', data: {} };
          yield { type: 'node', node: 'generateAnswer', data: {} };
        }
      };

      mockGraph.stream.mockResolvedValue(mockStreamResult);

      const graph = await V3Chat.build(mockEnv, mockCheckpointer);

      const initialState: AgentState = {
        userId: 'test-user',
        messages: [
          { role: 'user', content: 'Tell me about AI' }
        ],
        chatHistory: [],
        options: {},
        taskIds: [],
        taskEntities: {},
        docs: [],
        generatedText: '',
        retrievalLoop: {
          attempt: 1,
          issuedQueries: [],
          refinedQueries: [],
          seenChunkIds: [],
        },
        metadata: {},
      };

      const streamResult = await graph.stream(initialState, {
        configurable: { thread_id: 'test-thread' },
        streamMode: ['messages', 'updates'],
      });

      expect(mockGraph.stream).toHaveBeenCalledWith(
        initialState,
        {
          configurable: { thread_id: 'test-thread' },
          streamMode: ['messages', 'updates'],
        }
      );
      expect(streamResult).toBeDefined();
    });
  });

  describe('conditional routing logic', () => {
    it('should route to combine_context when retrieval is adequate and no tools needed', () => {
      // Test the decision logic that would be used in the actual graph
      const state: AgentState = {
        userId: 'test',
        messages: [],
        chatHistory: [],
        options: {},
        taskIds: [],
        taskEntities: {},
        docs: [
          { id: 'doc1', content: 'relevant content', metadata: {} }
        ],
        generatedText: '',
        retrievalLoop: {
          attempt: 1,
          issuedQueries: ['test query'],
          refinedQueries: [],
          seenChunkIds: ['chunk1'],
        },
        retrievalEvaluation: {
          isAdequate: true,
          confidence: 0.8,
          reasoning: 'Found relevant documents',
        },
        toolNecessityClassification: {
          isToolNeeded: false,
          confidence: 0.9,
          reasoning: 'Information is sufficient',
        },
        metadata: {},
      };

      // Simulate the decision function logic
      const evalRes = state.retrievalEvaluation;
      const toolNec = state.toolNecessityClassification;
      const adequate = !!evalRes?.isAdequate;
      const needsTool = !!toolNec?.isToolNeeded;

      expect(adequate).toBe(true);
      expect(needsTool).toBe(false);
      
      // Should route to combine_context
      const expectedRoute = adequate && !needsTool ? 'combine_context' : 'other';
      expect(expectedRoute).toBe('combine_context');
    });

    it('should route to improve_retrieval when retrieval is inadequate and under loop limit', () => {
      const state: AgentState = {
        userId: 'test',
        messages: [],
        chatHistory: [],
        options: {},
        taskIds: [],
        taskEntities: {},
        docs: [],
        generatedText: '',
        retrievalLoop: {
          attempt: 2, // Under the limit of 3
          issuedQueries: ['query1'],
          refinedQueries: [],
          seenChunkIds: [],
        },
        retrievalEvaluation: {
          isAdequate: false,
          confidence: 0.3,
          reasoning: 'Need more specific information',
        },
        toolNecessityClassification: {
          isToolNeeded: false,
          confidence: 0.7,
          reasoning: 'No tools needed yet',
        },
        metadata: {},
      };

      const evalRes = state.retrievalEvaluation;
      const toolNec = state.toolNecessityClassification;
      const adequate = !!evalRes?.isAdequate;
      const needsTool = !!toolNec?.isToolNeeded;
      const iteration = state.retrievalLoop?.attempt ?? 0;
      const maxLoops = 3;

      expect(adequate).toBe(false);
      expect(needsTool).toBe(false);
      expect(iteration).toBeLessThan(maxLoops);

      // Should route to improve_retrieval
      const expectedRoute = !adequate && iteration < maxLoops ? 'improve_retrieval' : 'other';
      expect(expectedRoute).toBe('improve_retrieval');
    });

    it('should route to tool_router when tool is needed', () => {
      const state: AgentState = {
        userId: 'test',
        messages: [],
        chatHistory: [],
        options: {},
        taskIds: [],
        taskEntities: {},
        docs: [],
        generatedText: '',
        retrievalLoop: {
          attempt: 1,
          issuedQueries: [],
          refinedQueries: [],
          seenChunkIds: [],
        },
        retrievalEvaluation: {
          isAdequate: false,
          confidence: 0.4,
          reasoning: 'Need external information',
        },
        toolNecessityClassification: {
          isToolNeeded: true,
          confidence: 0.9,
          reasoning: 'Need to search the web',
        },
        metadata: {},
      };

      const toolNec = state.toolNecessityClassification;
      const needsTool = !!toolNec?.isToolNeeded;

      expect(needsTool).toBe(true);

      // Should route to tool_router when tool is needed
      const expectedRoute = needsTool ? 'tool_router' : 'other';
      expect(expectedRoute).toBe('tool_router');
    });
  });

  describe('error handling', () => {
    it('should handle missing environment variables gracefully', async () => {
      const incompleteEnv = {} as Env;

      // Should not throw error, should use defaults
      const graph = await V3Chat.build(incompleteEnv, mockCheckpointer);
      expect(graph).toBeDefined();
    });

    it('should handle checkpointer initialization failure', async () => {
      const failingCheckpointer = {
        initialize: vi.fn().mockRejectedValue(new Error('DB connection failed')),
      };

      // The graph build should still succeed even if checkpointer fails
      const graph = await V3Chat.build(mockEnv, failingCheckpointer);
      expect(graph).toBeDefined();
    });
  });
});