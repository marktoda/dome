/**
 * Chat Graph Implementation
 *
 * This file contains the implementation of the chat orchestration graph,
 * which processes user queries through a series of nodes to generate responses.
 * The graph uses LangGraph's StateGraph for native graph execution.
 */

import {
  Annotation,
  StateGraph,
  CompiledStateGraph,
  END,
  START,
  BaseCheckpointSaver,
} from '@langchain/langgraph';
import { PregelInterface } from '@langchain/langgraph/dist/pregel/types';
import { BaseMessage } from '@langchain/core/messages';
import { getLogger } from '@dome/logging';
import { IterableReadableStream } from '@langchain/core/utils/stream';
import { SecureD1Checkpointer } from './checkpointer/secureD1Checkpointer';
import { SecureToolExecutor } from './tools/secureToolExecutor';
import * as nodes from './nodes';
import { AgentState } from './types';

type ChatNodeKey =
  | typeof START // "__start__"
  | typeof END // "__end__"
  | 'split_rewrite'
  | 'retrieve'
  | 'dynamic_widen'
  | 'tool_router'
  | 'run_tool'
  | 'generate_answer';

interface IChatGraph {
  stream(input: unknown, options?: Partial<unknown>): Promise<IterableReadableStream<unknown>>;

  invoke(input: unknown, options?: Partial<unknown>): Promise<unknown>;
}

/**
 * Builds a secure chat processing graph with checkpointing and tool execution capabilities
 *
 * @param env - Environment bindings containing configuration and services
 * @param checkpointer - Optional custom checkpoint saver implementation
 * @param toolExecutor - Optional custom tool executor implementation
 * @returns A compiled graph object with stream and invoke methods
 */
export async function buildChatGraph(
  env: Env,
  checkpointer?: BaseCheckpointSaver,
  toolExecutor?: SecureToolExecutor,
): Promise<IChatGraph> {
  const logger = getLogger().child({ component: 'graphBuilder' });
  logger.info('Building secure chat graph');

  // Initialize dependencies
  checkpointer = await initializeCheckpointer(env, checkpointer);
  toolExecutor = initializeToolExecutor(toolExecutor);

  // Create node wrappers that include environment
  const nodeWrappers = createNodeWrappers(env, toolExecutor);
  const GraphState = Annotation.Root({
    messages: Annotation<BaseMessage[]>({
      reducer: (x, y) => x.concat(y),
      default: () => [],
    }),
  });
  // Initialize the state graph
  const graph = new StateGraph(GraphState)
    .addNode('split_rewrite', nodeWrappers.splitRewrite)
    .addNode('retrieve', nodeWrappers.retrieve)
    .addNode('dynamic_widen', nodeWrappers.dynamicWiden)
    .addNode('tool_router', nodeWrappers.toolRouter)
    .addNode('run_tool', nodeWrappers.runTool)
    .addNode('generate_answer', nodeWrappers.generateAnswer)
    .addEdge(START, 'split_rewrite')
    .addEdge('split_rewrite', 'retrieve')
    .addEdge('retrieve', 'generate_answer')
    // .addConditionalEdges(
    //   'retrieve',
    //   nodeWrappers.routeAfterRetrieve,
    //   {
    //     widen: 'dynamic_widen',
    //     tool: 'tool_router',
    //     answer: 'generate_answer',
    //   }
    // );

    // .addEdge('dynamic_widen', 'retrieve')

    // .addConditionalEdges(
    //   'tool_router',
    //   nodeWrappers.routeAfterTool,
    //   {
    //     run_tool: 'run_tool',
    //     answer: 'generate_answer',
    //   }
    // );

    // .addEdge('run_tool', 'generate_answer')
    .addEdge('generate_answer', END);

  // Compile the graph with checkpointer and state reducers
  return graph.compile({
    checkpointer,
  });
}

/**
 * Creates node wrappers that include environment
 */
function createNodeWrappers(env: Env, toolExecutor: SecureToolExecutor) {
  return {
    // Node functions
    splitRewrite: async (state: AgentState) => {
      return await nodes.splitRewrite(state, env);
    },

    retrieve: async (state: AgentState) => {
      return await nodes.retrieve(state, env);
    },

    dynamicWiden: async (state: AgentState) => {
      return await nodes.dynamicWiden(state, env);
    },

    toolRouter: async (state: AgentState) => {
      return await nodes.toolRouter(state, env);
    },

    runTool: async (state: AgentState) => {
      // Pass the tool executor to the run tool node
      const runToolWithExecutor = (state: AgentState) => nodes.runTool(state, env, toolExecutor);
      return await runToolWithExecutor(state);
    },

    generateAnswer: async (state: AgentState) => {
      return await nodes.generateAnswer(state, env);
    },

    // Router functions
    routeAfterRetrieve: (state: AgentState) => {
      return nodes.routeAfterRetrieve(state);
    },

    routeAfterTool: (state: AgentState) => {
      return nodes.routeAfterTool(state);
    },
  };
}

/**
 * Initializes a checkpointer instance for persisting graph state
 *
 * @param env - Environment bindings
 * @param existingCheckpointer - Optional existing checkpointer to use
 * @returns Initialized checkpointer instance
 */
async function initializeCheckpointer(
  env: Env,
  existingCheckpointer?: BaseCheckpointSaver,
): Promise<BaseCheckpointSaver> {
  if (existingCheckpointer) {
    return existingCheckpointer;
  }

  const logger = getLogger().child({ component: 'checkpointerInitializer' });

  try {
    // Create and initialize the D1 checkpointer
    const d1Checkpointer = new SecureD1Checkpointer(env.CHAT_DB, env);
    await d1Checkpointer.initialize();
    return d1Checkpointer;
  } catch (error) {
    logger.warn({ err: error }, 'Failed to initialize D1 checkpointer, using mock instead');
    throw error;
  }
}

/**
 * Initializes a tool executor for running external tools
 *
 * @param existingToolExecutor - Optional existing tool executor to use
 * @returns Initialized tool executor
 */
function initializeToolExecutor(existingToolExecutor?: SecureToolExecutor): SecureToolExecutor {
  if (existingToolExecutor) {
    return existingToolExecutor;
  }

  return new SecureToolExecutor();
}
