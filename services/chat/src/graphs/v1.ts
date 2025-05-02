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
import { getLogger } from "@dome/logging";

import { SecureD1Checkpointer } from "../checkpointer/secureD1Checkpointer";
import { ToolRegistry } from "../tools";
import * as nodes from "../nodes";
import { AgentState, GraphStateAnnotation } from "../types";
import { createStateSummary } from "../utils/loggingHelpers";
import { ChatBuilder, IChatGraph } from '.';

export const V1Chat: ChatBuilder = {
  /* ------------------------------------------------------------------ */
  /*  Graph Builder                                                     */
  /* ------------------------------------------------------------------ */
  async build(
    env: Env,
    cp?: BaseCheckpointSaver,
  ): Promise<IChatGraph> {
    const log = getLogger().child({ component: "graphBuilder" });
    log.info("⧉ building RAG Chat V2 graph");

    // Initialize the checkpointer and tools
    const checkpointer = cp ?? await new SecureD1Checkpointer(env.CHAT_DB, env).initialize().then(r => r ?? cp!);
    const tools = ToolRegistry.fromDefault();

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
      .addNode("doc_to_sources", fn.docToSources)       // Map docs to sources for streaming
      .addNode("generate_rag", fn.generateAnswer)       // RAG-enabled streaming answer

      /* Graph connections */
      .addEdge(START, "routing_split")

      // Conditional routing after initial split
      .addConditionalEdges(
        "routing_split",
        fn.routeAfterSplit,
        {
          edit_system_prompt: "edit_system_prompt",
          filter_history: "filter_history",
        }
      )

      .addEdge("edit_system_prompt", "filter_history")
      .addEdge("filter_history", "rewrite")
      .addEdge("rewrite", "retrieve")

      // Conditional routing after retrieval (widen vs proceed to tools)
      .addConditionalEdges(
        "retrieve",
        fn.routeAfterRetrieve,
        {
          widen: "dynamic_retrieve",
          tool: "tool_routing",
          answer: "generate_rag",
        }
      )

      .addEdge("dynamic_retrieve", "tool_routing")

      // Conditional routing after tool selection (run tool vs generate answer)
      .addConditionalEdges(
        "tool_routing",
        fn.routeAfterTool,
        {
          run_tool: "run_tool",
          answer: "doc_to_sources",
        }
      )

      .addEdge("run_tool", "doc_to_sources")
      .addEdge("doc_to_sources", "generate_rag")
      .addEdge("generate_rag", END);

    // Compile the graph with checkpointing
    return graph.compile({
      checkpointer,
      // The superstepKey property is not supported in the current version
      // Use the appropriate tracking mechanism for the LangGraph version
    });
  }
}


/* ------------------------------------------------------------------ */
/*  Node Wrappers                                                     */
/* ------------------------------------------------------------------ */
function createNodeWrappers(env: Env, tools: ToolRegistry) {
  const log = getLogger().child({ component: "nodeWrappers" });

  return {
    /* Routing nodes */
    routingSplit: async (state: AgentState) => {
      log.info({ preState: createStateSummary(state) }, "→ [START] routingSplit");
      const res = await nodes.routingSplit(state, env);
      log.info({ postState: createStateSummary(res) }, "→ [END] routingSplit");
      return res;
    },

    /* Query processing nodes */
    editSystemPrompt: async (state: AgentState) => {
      log.info({ preState: createStateSummary(state) }, "→ [START] editSystemPrompt");
      const res = await nodes.editSystemPrompt(state, env);
      log.info({ postState: createStateSummary(res) }, "→ [END] editSystemPrompt");
      return res;
    },
    filterHistory: async (state: AgentState) => {
      log.info({ preState: createStateSummary(state) }, "→ [START] filterHistory");
      const res = await nodes.filterHistory(state, env);
      log.info({ postState: createStateSummary(res) }, "→ [END] filterHistory");
      return res;
    },
    rewrite: async (state: AgentState) => {
      log.info({ preState: createStateSummary(state) }, "→ [START] rewrite");
      const res = await nodes.rewrite(state, env);
      log.info({ postState: createStateSummary(res) }, "→ [END] rewrite");
      return res;
    },

    /* Retrieval and context enhancement nodes */
    retrieve: async (state: AgentState, cfg: LangGraphRunnableConfig) => {
      log.info({ preState: createStateSummary(state) }, "→ [START] retrieve");
      const res = await nodes.retrieve(state, cfg, env);
      log.info({ postState: createStateSummary(res) }, "→ [END] retrieve");
      return res;
    },
    dynamicWiden: async (state: AgentState) => {
      log.info({ preState: createStateSummary(state) }, "→ [START] dynamicWiden");
      const res = await nodes.dynamicWiden(state, env);
      log.info({ postState: createStateSummary(res) }, "→ [END] dynamicWiden");
      return res;
    },

    /* Tool handling nodes */
    toolRouter: async (state: AgentState) => {
      log.info({ preState: createStateSummary(state) }, "→ [START] toolRouter");
      const res = await nodes.toolRouter(state, env, tools);
      log.info({ postState: createStateSummary(res) }, "→ [END] toolRouter");
      return res;
    },
    runTool: async (state: AgentState) => {
      log.info({ preState: createStateSummary(state) }, "→ [START] runTool");
      const res = await nodes.runTool(state, env, tools);
      log.info({ postState: createStateSummary(res) }, "→ [END] runTool");
      return res;
    },

    /* Document to Sources mapping node */
    docToSources: async (state: AgentState) => {
      log.info({ preState: createStateSummary(state) }, "→ [START] docToSources");
      const res = await nodes.docToSources(state);
      log.info({ postState: createStateSummary(res) }, "→ [END] docToSources");
      return res;
    },

    /* Generation nodes */
    generateAnswer: async (state: AgentState, cfg: LangGraphRunnableConfig) => {
      log.info({ preState: createStateSummary(state) }, '→ [START] generateRag');
      const res = await nodes.generateAnswer(state, cfg, env);
      log.info({ postState: createStateSummary(res) }, '→ [END] generateRag');
      return res;
    },
    generateChatLLM: async (state: AgentState, cfg: LangGraphRunnableConfig) => {
      log.info({ preState: createStateSummary(state) }, '→ [START] generateChatLLM');
      const res = await nodes.generateChatLLM(state, cfg, env);
      log.info({ postState: createStateSummary(res) }, '→ [END] generateChatLLM');
      return res;
    },

    /* Routing helper functions */
    routeAfterRetrieve: async (state: AgentState) => {
      log.info({ preState: createStateSummary(state) }, "→ [START] routeAfterRetrieve");
      const res = await nodes.routeAfterRetrieve(state);
      log.info({ result: res }, "→ [END] routeAfterRetrieve");
      return res;
    },
    routeAfterTool: async (state: AgentState) => {
      log.info({ preState: createStateSummary(state) }, "→ [START] routeAfterTool");
      const res = await nodes.routeAfterTool(state);
      log.info({ result: res }, "→ [END] routeAfterTool");
      return res;
    },
    routeAfterSplit: (state: AgentState) => {
      log.info({ preState: createStateSummary(state) }, "→ [START] routeAfterSplit");
      const res = state.metadata?.route ?? "filter_history";
      log.info({ result: res }, "→ [END] routeAfterSplit");
      return res;
    },
  };
}
