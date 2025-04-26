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
import { AgentState, GraphStateAnnotation } from './types';
import { FeatureFlag, FeatureFlagService } from './utils/featureFlags';

// Define all possible node keys for the chat graph
type ChatNodeKey =
  | typeof START // "__start__"
  | typeof END // "__end__"
  | 'split_rewrite'
  | 'retrieve'
  | 'dynamic_widen'
  | 'tool_router'
  | 'run_tool'
  | 'generate_answer';

// Ensure all node keys are valid for graph operations
type GraphNodeKey = ChatNodeKey;

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
  // Initialize the state graph
  const graph = new StateGraph(GraphStateAnnotation)
    .addNode('split_rewrite', nodeWrappers.splitRewrite)
    .addNode('retrieve', nodeWrappers.retrieve)
    .addNode('generate_answer', nodeWrappers.generateAnswer)
    .addEdge(START, 'split_rewrite')
    .addEdge('split_rewrite', 'retrieve');

  // Add dynamic widening if enabled
  if (FeatureFlagService.isEnabled(FeatureFlag.ENABLE_DYNAMIC_WIDENING)) {
    logger.info('Dynamic widening feature is enabled');
    graph.addNode('dynamic_widen', nodeWrappers.dynamicWiden);
  }

  // Add tool router if enabled
  if (FeatureFlagService.isEnabled(FeatureFlag.ENABLE_TOOL_ROUTER)) {
    logger.info('Tool router feature is enabled');
    graph.addNode('tool_router', nodeWrappers.toolRouter);
  }

  // Add tool execution if enabled
  if (FeatureFlagService.isEnabled(FeatureFlag.ENABLE_TOOL_EXECUTION)) {
    logger.info('Tool execution feature is enabled');
    graph.addNode('run_tool', nodeWrappers.runTool);
  }

  // Configure routing based on enabled features
  if (
    FeatureFlagService.isEnabled(FeatureFlag.ENABLE_DYNAMIC_WIDENING) ||
    FeatureFlagService.isEnabled(FeatureFlag.ENABLE_TOOL_ROUTER)
  ) {
    // Create routing options
    const routingOptions: Record<string, ChatNodeKey> = {
      answer: 'generate_answer',
    };

    if (FeatureFlagService.isEnabled(FeatureFlag.ENABLE_DYNAMIC_WIDENING)) {
      routingOptions.widen = 'dynamic_widen';
    }

    if (FeatureFlagService.isEnabled(FeatureFlag.ENABLE_TOOL_ROUTER)) {
      routingOptions.tool = 'tool_router';
    }

    // Add conditional edges from retrieve
    graph.addConditionalEdges(
      'retrieve',
      nodeWrappers.routeAfterRetrieve as any, // Type assertion to bypass type checking
      routingOptions as any, // Type assertion to bypass type checking
    );

    // Add edge from dynamic widen back to retrieve if enabled
    if (FeatureFlagService.isEnabled(FeatureFlag.ENABLE_DYNAMIC_WIDENING)) {
      graph.addEdge('dynamic_widen' as any, 'retrieve');
    }

    // Add conditional edges from tool router if both tool router and execution are enabled
    if (
      FeatureFlagService.isEnabled(FeatureFlag.ENABLE_TOOL_ROUTER) &&
      FeatureFlagService.isEnabled(FeatureFlag.ENABLE_TOOL_EXECUTION)
    ) {
      graph.addConditionalEdges(
        'tool_router' as any,
        nodeWrappers.routeAfterTool as any,
        {
          run_tool: 'run_tool' as ChatNodeKey,
          answer: 'generate_answer',
        } as any, // Type assertion to bypass type checking
      );

      // Add edge from run tool to generate answer
      graph.addEdge('run_tool' as any, 'generate_answer');
    } else if (FeatureFlagService.isEnabled(FeatureFlag.ENABLE_TOOL_ROUTER)) {
      // If tool router is enabled but execution is not, always go to generate answer
      graph.addEdge('tool_router' as any, 'generate_answer');
    }
  } else {
    // Default simple flow if no advanced features are enabled
    graph.addEdge('retrieve', 'generate_answer');
  }

  // Final edge to end
  graph.addEdge('generate_answer', END);

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
