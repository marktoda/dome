/**
 * RAG Chat V2 Orchestration Graph
 *
 * This is the main orchestration graph for the RAG Chat V2 system.
 * It connects all nodes in the proper sequence with conditional routing
 * based on the state.
 */
import {
  START,
  END,
  StateGraph,
  BaseCheckpointSaver,
  LangGraphRunnableConfig,
} from "@langchain/langgraph";
import { IterableReadableStream } from "@langchain/core/utils/stream";
import { getLogger } from "@dome/logging";

import { SecureD1Checkpointer } from "./checkpointer/secureD1Checkpointer";
import { SecureToolExecutor } from "./tools/secureToolExecutor";
import * as nodes from "./nodes";
import { AgentState, GraphStateAnnotation } from "./types";

export interface IChatGraph {
  stream(i: unknown, o?: Partial<unknown>): Promise<IterableReadableStream<unknown>>;
  invoke(i: unknown, o?: Partial<unknown>): Promise<unknown>;
}

/* ------------------------------------------------------------------ */
/*  Graph Builder                                                     */
/* ------------------------------------------------------------------ */
export async function buildChatGraph(
  env: Env,
  cp?: BaseCheckpointSaver,
  te?: SecureToolExecutor,
): Promise<IChatGraph> {
  const log = getLogger().child({ component: "graphBuilder" });
  log.info("⧉ building RAG Chat V2 graph");

  // Initialize the checkpointer and tools
  const checkpointer = cp ?? await new SecureD1Checkpointer(env.CHAT_DB, env).initialize().then(r => r ?? cp!);
  const tools = te ?? new SecureToolExecutor();

  // Get the wrapped node functions with proper environment
  const fn = createNodeWrappers(env, tools);

  // Build the full graph with all nodes and connections
  const graph = new StateGraph(GraphStateAnnotation)
    /* Core nodes */
    .addNode("routing_split", fn.routingSplit)
    .addNode("edit_system_prompt", fn.editSystemPrompt)
    .addNode("filter_history", fn.filterHistory)
    .addNode("rewrite", fn.rewrite)
    .addNode("retrieve", fn.retrieve)
    .addNode("dynamic_retrieve", fn.dynamicWiden)
    .addNode("tool_routing", fn.toolRouter)
    .addNode("run_tool", fn.runTool)
    .addNode("generate_rag", fn.generateAnswer)       // RAG-enabled streaming answer

    /* Graph connections */
    .addEdge(START, "routing_split")
    .addEdge("edit_system_prompt", "filter_history")

    // Conditional routing after initial split
    .addConditionalEdges(
      "routing_split",
      fn.routeAfterSplit,
      {
        edit_system_prompt: "edit_system_prompt",
        filter_history: "filter_history",
      }
    )

    .addEdge("filter_history", "rewrite")
    .addEdge("rewrite", "retrieve")

    // Conditional routing after retrieval (widen vs proceed to tools)
    .addConditionalEdges(
      "retrieve",
      fn.routeAfterRetrieve,
      {
        widen: "dynamic_retrieve",
        answer: "tool_routing",
      }
    )

    .addEdge("dynamic_retrieve", "tool_routing")

    // Conditional routing after tool selection (run tool vs generate answer)
    .addConditionalEdges(
      "tool_routing",
      fn.routeAfterTool,
      {
        run_tool: "run_tool",
        answer: "generate_rag",
      }
    )

    .addEdge("run_tool", "generate_rag")
    .addEdge("generate_rag", END);

  // Compile the graph with checkpointing
  return graph.compile({
    checkpointer,
    // The superstepKey property is not supported in the current version
    // Use the appropriate tracking mechanism for the LangGraph version
  });
}

/* ------------------------------------------------------------------ */
/*  Node Wrappers                                                     */
/* ------------------------------------------------------------------ */
function createNodeWrappers(env: Env, tools: SecureToolExecutor) {
  const log = getLogger().child({ component: "nodeWrappers" });

  return {
    /* Routing nodes */
    routingSplit: async (state: AgentState) => {
      log.info({ preState: state }, "→ [START] routingSplit");
      const res = await nodes.routingSplit(state, env);
      log.info({ postState: res }, "→ [END] routingSplit");
      return res;
    },

    /* Query processing nodes */
    editSystemPrompt: async (state: AgentState) => {
      log.info({ preState: state }, "→ [START] editSystemPrompt");
      const res = await nodes.editSystemPrompt(state, env);
      log.info({ postState: res }, "→ [END] editSystemPrompt");
      return res;
    },
    filterHistory: async (state: AgentState) => {
      log.info({ preState: state }, "→ [START] filterHistory");
      const res = await nodes.filterHistory(state, env);
      log.info({ postState: res }, "→ [END] filterHistory");
      return res;
    },
    rewrite: async (state: AgentState) => {
      log.info({ preState: state }, "→ [START] rewrite");
      const res = await nodes.rewrite(state, env);
      log.info({ postState: res }, "→ [END] rewrite");
      return res;
    },

    /* Retrieval and context enhancement nodes */
    retrieve: async (state: AgentState) => {
      log.info({ preState: state }, "→ [START] retrieve");
      const res = await nodes.retrieve(state, env);
      log.info({ postState: res }, "→ [END] retrieve");
      return res;
    },
    dynamicWiden: async (state: AgentState) => {
      log.info({ preState: state }, "→ [START] dynamicWiden");
      const res = await nodes.dynamicWiden(state, env);
      log.info({ postState: res }, "→ [END] dynamicWiden");
      return res;
    },

    /* Tool handling nodes */
    toolRouter: async (state: AgentState) => {
      log.info({ preState: state }, "→ [START] toolRouter");
      const res = await nodes.toolRouter(state, env);
      log.info({ postState: res }, "→ [END] toolRouter");
      return res;
    },
    runTool: async (state: AgentState) => {
      log.info({ preState: state }, "→ [START] runTool");
      const res = await nodes.runTool(state, env, tools);
      log.info({ postState: res }, "→ [END] runTool");
      return res;
    },

    /* Generation nodes */
    generateAnswer: async (state: AgentState, cfg: LangGraphRunnableConfig) => {
      log.info({ preState: state }, '→ [START] generateRag');
      const res = await nodes.generateAnswer(state, cfg, env);
      log.info({ postState: res }, '→ [END] generateRag');
      return res;
    },
    generateChatLLM: async (state: AgentState, cfg: LangGraphRunnableConfig) => {
      log.info({ preState: state }, '→ [START] generateChatLLM');
      const res = await nodes.generateChatLLM(state, cfg, env);
      log.info({ postState: res }, '→ [END] generateChatLLM');
      return res;
    },

    /* Routing helper functions */
    routeAfterRetrieve: async (state: AgentState) => {
      log.info({ preState: state }, "→ [START] routeAfterRetrieve");
      const res = nodes.routeAfterRetrieve(state);
      log.info({ result: res }, "→ [END] routeAfterRetrieve");
      return res;
    },
    routeAfterTool: (state: AgentState) => {
      log.info({ preState: state }, "→ [START] routeAfterTool");
      const res = nodes.routeAfterTool(state);
      log.info({ result: res }, "→ [END] routeAfterTool");
      return res;
    },
    routeAfterSplit: (state: AgentState) => {
      log.info({ preState: state }, "→ [START] routeAfterSplit");
      const res = state.metadata?.route ?? "filter_history";
      log.info({ result: res }, "→ [END] routeAfterSplit");
      return res;
    },
  };
}
