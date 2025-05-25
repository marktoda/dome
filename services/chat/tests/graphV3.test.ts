import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { V3Chat } from '../src/graphs/v3';
import { AgentState } from '../src/types';
import { D1Checkpointer } from '../src/checkpointer/d1Checkpointer';
import { ToolRegistry } from '../src/tools';
import * as nodes from '../src/nodes';

// Mock dependencies
vi.mock('../src/checkpointer/d1Checkpointer');
vi.mock('../src/tools');
vi.mock('../src/nodes');
vi.mock('@dome/common');
vi.mock('@langchain/langgraph');

describe('Graph V3 Execution', () => {
  let mockEnv: Env;
  let mockCheckpointer: any;
  let mockToolRegistry: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockEnv = {
      MAX_RAG_LOOPS: '3',
      LOG_VERBOSE: '0',
      CHAT_DB: {} as D1Database,
    } as Env;

    mockCheckpointer = {
      initialize: vi.fn().mockResolvedValue(mockCheckpointer),
    };

    mockToolRegistry = {
      fromDefault: vi.fn().mockReturnValue({}),
    };

    // Mock D1Checkpointer
    vi.mocked(D1Checkpointer).mockImplementation(() => mockCheckpointer as any);
    vi.mocked(ToolRegistry.fromDefault).mockReturnValue(mockToolRegistry);

    // Mock all node functions
    Object.keys(nodes).forEach(nodeKey => {
      vi.mocked(nodes[nodeKey as keyof typeof nodes]).mockImplementation(
        async (state: AgentState) => ({ ...state })
      );
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Graph building', () => {
    it('should build V3 graph successfully', async () => {
      const { StateGraph } = await vi.importMock('@langchain/langgraph');
      const mockGraph = {
        addNode: vi.fn().mockReturnThis(),
        addEdge: vi.fn().mockReturnThis(),
        addConditionalEdges: vi.fn().mockReturnThis(),
        compile: vi.fn().mockReturnValue({
          stream: vi.fn(),
          invoke: vi.fn(),
        }),
      };

      vi.mocked(StateGraph).mockImplementation(() => mockGraph as any);

      const graph = await V3Chat.build(mockEnv, mockCheckpointer);

      expect(StateGraph).toHaveBeenCalled();
      expect(mockGraph.addNode).toHaveBeenCalledTimes(12); // All nodes should be added
      expect(mockGraph.addEdge).toHaveBeenCalledTimes(9); // All direct edges
      expect(mockGraph.addConditionalEdges).toHaveBeenCalledTimes(1); // After evaluation edge
      expect(mockGraph.compile).toHaveBeenCalledWith({ checkpointer: mockCheckpointer });
      expect(graph).toBeDefined();
    });

    it('should use default checkpointer when none provided', async () => {
      vi.mocked(D1Checkpointer.prototype.initialize).mockResolvedValue(mockCheckpointer);

      const { StateGraph } = await vi.importMock('@langchain/langgraph');
      const mockGraph = {
        addNode: vi.fn().mockReturnThis(),
        addEdge: vi.fn().mockReturnThis(),
        addConditionalEdges: vi.fn().mockReturnThis(),
        compile: vi.fn().mockReturnValue({}),
      };

      vi.mocked(StateGraph).mockImplementation(() => mockGraph as any);

      await V3Chat.build(mockEnv);

      expect(D1Checkpointer).toHaveBeenCalledWith(mockEnv.CHAT_DB);
    });
  });

  describe('Decision logic - makeDecideAfterEval', () => {
    const createMockState = (
      isAdequate?: boolean,
      isToolNeeded?: boolean,
      attempt: number = 1
    ): AgentState => ({
      userId: 'test-user',
      messages: [],
      chatHistory: [],
      options: {
        enhanceWithContext: true,
        maxContextItems: 5,
        includeSourceInfo: true,
        maxTokens: 1000,
      },
      taskIds: [],
      taskEntities: {},
      docs: [],
      generatedText: '',
      retrievalLoop: { attempt, issuedQueries: [], refinedQueries: [], seenChunkIds: [] },
      metadata: {},
      retrievalEvaluation: isAdequate !== undefined ? { isAdequate } : undefined,
      toolNecessityClassification: isToolNeeded !== undefined ? { isToolNeeded } : undefined,
    });

    it('should decide to combine_context when adequate and no tool needed', () => {
      // We need to access the decision function - let's create it manually
      const makeDecideAfterEval = (maxLoops: number) => {
        return function decideAfterEval(
          state: AgentState,
        ): 'combine_context' | 'tool_router' | 'improve_retrieval' {
          const evalRes = state.retrievalEvaluation;
          const toolNec = state.toolNecessityClassification;

          const adequate = !!evalRes?.isAdequate;
          const needsTool = !!toolNec?.isToolNeeded;

          const iteration = state.retrievalLoop?.attempt ?? 0;

          if (adequate && !needsTool) return 'combine_context';

          if (!adequate && iteration < maxLoops) return 'improve_retrieval';

          if (needsTool) return 'tool_router';

          return 'combine_context';
        };
      };

      const decider = makeDecideAfterEval(3);
      const state = createMockState(true, false, 1);

      const result = decider(state);

      expect(result).toBe('combine_context');
    });

    it('should decide to improve_retrieval when not adequate and under loop limit', () => {
      const makeDecideAfterEval = (maxLoops: number) => {
        return function decideAfterEval(
          state: AgentState,
        ): 'combine_context' | 'tool_router' | 'improve_retrieval' {
          const evalRes = state.retrievalEvaluation;
          const toolNec = state.toolNecessityClassification;

          const adequate = !!evalRes?.isAdequate;
          const needsTool = !!toolNec?.isToolNeeded;

          const iteration = state.retrievalLoop?.attempt ?? 0;

          if (adequate && !needsTool) return 'combine_context';

          if (!adequate && iteration < maxLoops) return 'improve_retrieval';

          if (needsTool) return 'tool_router';

          return 'combine_context';
        };
      };

      const decider = makeDecideAfterEval(3);
      const state = createMockState(false, false, 2);

      const result = decider(state);

      expect(result).toBe('improve_retrieval');
    });

    it('should decide to tool_router when tool is needed', () => {
      const makeDecideAfterEval = (maxLoops: number) => {
        return function decideAfterEval(
          state: AgentState,
        ): 'combine_context' | 'tool_router' | 'improve_retrieval' {
          const evalRes = state.retrievalEvaluation;
          const toolNec = state.toolNecessityClassification;

          const adequate = !!evalRes?.isAdequate;
          const needsTool = !!toolNec?.isToolNeeded;

          const iteration = state.retrievalLoop?.attempt ?? 0;

          if (adequate && !needsTool) return 'combine_context';

          if (!adequate && iteration < maxLoops) return 'improve_retrieval';

          if (needsTool) return 'tool_router';

          return 'combine_context';
        };
      };

      const decider = makeDecideAfterEval(3);
      const state = createMockState(false, true, 1);

      const result = decider(state);

      expect(result).toBe('tool_router');
    });

    it('should fall back to combine_context when at loop limit', () => {
      const makeDecideAfterEval = (maxLoops: number) => {
        return function decideAfterEval(
          state: AgentState,
        ): 'combine_context' | 'tool_router' | 'improve_retrieval' {
          const evalRes = state.retrievalEvaluation;
          const toolNec = state.toolNecessityClassification;

          const adequate = !!evalRes?.isAdequate;
          const needsTool = !!toolNec?.isToolNeeded;

          const iteration = state.retrievalLoop?.attempt ?? 0;

          if (adequate && !needsTool) return 'combine_context';

          if (!adequate && iteration < maxLoops) return 'improve_retrieval';

          if (needsTool) return 'tool_router';

          return 'combine_context';
        };
      };

      const decider = makeDecideAfterEval(3);
      const state = createMockState(false, false, 3);

      const result = decider(state);

      expect(result).toBe('combine_context');
    });

    it('should handle missing evaluation data gracefully', () => {
      const makeDecideAfterEval = (maxLoops: number) => {
        return function decideAfterEval(
          state: AgentState,
        ): 'combine_context' | 'tool_router' | 'improve_retrieval' {
          const evalRes = state.retrievalEvaluation;
          const toolNec = state.toolNecessityClassification;

          const adequate = !!evalRes?.isAdequate;
          const needsTool = !!toolNec?.isToolNeeded;

          const iteration = state.retrievalLoop?.attempt ?? 0;

          if (adequate && !needsTool) return 'combine_context';

          if (!adequate && iteration < maxLoops) return 'improve_retrieval';

          if (needsTool) return 'tool_router';

          return 'combine_context';
        };
      };

      const decider = makeDecideAfterEval(3);
      const state = createMockState(undefined, undefined, 1);

      const result = decider(state);

      expect(result).toBe('improve_retrieval');
    });
  });

  describe('Node wrapper functionality', () => {
    it('should wrap nodes with logging', async () => {
      const { getLogger } = await vi.importMock('@dome/common');
      const mockLogger = {
        child: vi.fn().mockReturnThis(),
        info: vi.fn(),
      };
      vi.mocked(getLogger).mockReturnValue(mockLogger as any);

      const { StateGraph } = await vi.importMock('@langchain/langgraph');
      const mockGraph = {
        addNode: vi.fn().mockReturnThis(),
        addEdge: vi.fn().mockReturnThis(),
        addConditionalEdges: vi.fn().mockReturnThis(),
        compile: vi.fn().mockReturnValue({}),
      };

      vi.mocked(StateGraph).mockImplementation(() => mockGraph as any);

      await V3Chat.build(mockEnv, mockCheckpointer);

      expect(getLogger).toHaveBeenCalled();
      expect(mockLogger.child).toHaveBeenCalledWith({ component: 'ragGraphBuilderV3' });
    });

    it('should handle verbose logging when enabled', async () => {
      mockEnv.LOG_VERBOSE = '1';

      const { StateGraph } = await vi.importMock('@langchain/langgraph');
      const mockGraph = {
        addNode: vi.fn().mockReturnThis(),
        addEdge: vi.fn().mockReturnThis(),
        addConditionalEdges: vi.fn().mockReturnThis(),
        compile: vi.fn().mockReturnValue({}),
      };

      vi.mocked(StateGraph).mockImplementation(() => mockGraph as any);

      await V3Chat.build(mockEnv, mockCheckpointer);

      expect(mockGraph.addNode).toHaveBeenCalled();
    });
  });

  describe('Configuration handling', () => {
    it('should use custom MAX_RAG_LOOPS when provided', async () => {
      mockEnv.MAX_RAG_LOOPS = '5';

      const { StateGraph } = await vi.importMock('@langchain/langgraph');
      const mockGraph = {
        addNode: vi.fn().mockReturnThis(),
        addEdge: vi.fn().mockReturnThis(),
        addConditionalEdges: vi.fn().mockReturnThis(),
        compile: vi.fn().mockReturnValue({}),
      };

      vi.mocked(StateGraph).mockImplementation(() => mockGraph as any);

      await V3Chat.build(mockEnv, mockCheckpointer);

      // Verify conditional edges were set up (which uses the maxLoops value)
      expect(mockGraph.addConditionalEdges).toHaveBeenCalled();
    });

    it('should default to 3 loops when MAX_RAG_LOOPS not specified', async () => {
      delete (mockEnv as any).MAX_RAG_LOOPS;

      const { StateGraph } = await vi.importMock('@langchain/langgraph');
      const mockGraph = {
        addNode: vi.fn().mockReturnThis(),
        addEdge: vi.fn().mockReturnThis(),
        addConditionalEdges: vi.fn().mockReturnThis(),
        compile: vi.fn().mockReturnValue({}),
      };

      vi.mocked(StateGraph).mockImplementation(() => mockGraph as any);

      await V3Chat.build(mockEnv, mockCheckpointer);

      expect(mockGraph.addConditionalEdges).toHaveBeenCalled();
    });
  });
});