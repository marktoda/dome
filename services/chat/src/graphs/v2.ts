/**
 * RAG Chat Graph Implementation
 *
 * This file implements the graph structure that connects all RAG pipeline nodes.
 * It orchestrates the entire pipeline flow from splitting and routing the initial query,
 * through retrieval, reranking, tool utilization, answer generation, and output validation.
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
import { IChatGraph, ChatBuilder } from '.';


export const V2Chat: ChatBuilder = {
  /**
   * Builds the comprehensive RAG graph that orchestrates all nodes in the pipeline.
   *
   * The graph follows this high-level flow:
   * 1. Split and route the initial query
   * 2. Retrieve relevant documents from multiple sources in parallel
   * 3. Rerank retrieved documents based on source type
   * 4. Evaluate retrieved content
   * 5. Classify if tools are needed
   * 6. Execute tools if necessary
   * 7. Combine context from retrieval and tools
   * 8. Generate the answer
   * 9. Apply output guardrails for final validation
   *
   * @param env Environment variables for node execution
   * @param cp Optional custom checkpoint saver
   * @returns The compiled RAG graph ready for execution
   */
  async build(
    env: Cloudflare.Env,
    cp?: BaseCheckpointSaver,
  ): Promise<IChatGraph> {
    const log = getLogger().child({ component: "ragGraphBuilder" });
    log.info("⧉ building comprehensive RAG graph");

    // Initialize the checkpointer and tools
    const checkpointer = cp ?? await new SecureD1Checkpointer(env.CHAT_DB, env).initialize().then(r => r ?? cp!);
    const tools = ToolRegistry.fromDefault();

    // Get the wrapped node functions with proper environment
    const fn = createNodeWrappers(env, tools);

    // Build the graph with all nodes and connections
    const graph = new StateGraph(GraphStateAnnotation)
      /* Core routing nodes */
      .addNode("routing_split", fn.routingSplit)
      .addNode("retrieval_selector", fn.retrievalSelector)

      /* Retrieval nodes */
      .addNode("retrieve", fn.retrieve)

      /* Reranking nodes */
      .addNode("unified_reranker", fn.unifiedReranker)
      .addNode("retrieval_evaluator", fn.retrievalEvaluatorLLM)

      /* Tool handling nodes */
      .addNode("tool_necessity_classifier", fn.toolNecessityClassifier)
      .addNode("tool_router_llm", fn.toolRouterLLM)
      .addNode("run_tool", fn.runTool)

      /* Content processing nodes */
      .addNode("combine_context_llm", fn.combineContextLLM)
      .addNode("generate_answer", fn.generateAnswer)
      .addNode("output_guardrail", fn.outputGuardrail)

      /* Graph connections - Main flow */
      .addEdge(START, "routing_split")
      .addEdge("routing_split", "retrieval_selector")
      .addEdge("retrieval_selector", "retrieve")

      /* Reranking connections */
      .addEdge("retrieve", "unified_reranker")
      
      /* Connect unified reranker to the evaluator */
      .addEdge("unified_reranker", "retrieval_evaluator")

      /* Connect evaluator to tool necessity classifier */
      .addEdge("retrieval_evaluator", "tool_necessity_classifier")

      /* Conditional routing for tool usage */
      .addConditionalEdges(
        "tool_necessity_classifier",
        fn.routeBasedOnToolNecessity,
        {
          needs_tools: "tool_router_llm",
          no_tools: "combine_context_llm",
        }
      )

      /* Tool execution path */
      .addEdge("tool_router_llm", "run_tool")
      .addEdge("run_tool", "combine_context_llm")

      /* Final generation and validation */
      .addEdge("combine_context_llm", "generate_answer")
      .addEdge("generate_answer", "output_guardrail")
      .addEdge("output_guardrail", END);

    // Compile the graph with checkpointing
    // Note: StateGraph API changed - we don't use onStateChange or reducers in this version
    return graph.compile({
      checkpointer,
      // The superstepKey property is not supported in the current version
      // Use the appropriate tracking mechanism for the LangGraph version
    });
  }

}


/**
 * Creates wrapped node functions with proper logging and instrumentation.
 * Each node is wrapped with pre/post execution logging and timing metrics.
 *
 * @param env Environment variables to pass to nodes
 * @param tools Tool registry for tool operations
 * @returns Object containing all wrapped node functions
 */
function createNodeWrappers(env: Cloudflare.Env, tools: ToolRegistry) {
  const log = getLogger().child({ component: "ragNodeWrappers" });

  return {
    /* Core routing nodes */
    routingSplit: async (state: AgentState) => {
      log.info({ preState: createStateSummary(state) }, "→ [START] routingSplit");
      // Use routingSplit which is available in the nodes directory
      const res = await nodes.routingSplit(state, env);
      log.info({ postState: createStateSummary(res) }, "→ [END] routingSplit");
      return res;
    },

    retrievalSelector: async (state: AgentState, cfg: LangGraphRunnableConfig) => {
      log.info({ preState: createStateSummary(state) }, "→ [START] retrievalSelector");
      const res = await nodes.retrievalSelector(state, cfg, env);
      log.info({ postState: createStateSummary(res) }, "→ [END] retrievalSelector");
      return res;
    },

    retrieve: async (state: AgentState) => {
      log.info({ preState: createStateSummary(state) }, "→ [START] retrieve");
      // Fix the argument types to match the API
      const config = {} as LangGraphRunnableConfig;
      const res = await nodes.retrieve(state, config, env);
      log.info({ postState: createStateSummary(res) }, "→ [END] retrieve");
      return res;
    },

    unifiedReranker: async (state: AgentState, cfg: LangGraphRunnableConfig) => {
      // Determine which category to use for reranking
      const category = determineContentCategory(state);
      log.info({ preState: createStateSummary(state), category }, "→ [START] unifiedReranker");
      
      // Use the unified reranker with the appropriate category
      const res = await nodes.reranker(state, category, cfg, env);
      log.info({ postState: createStateSummary(res), category }, "→ [END] unifiedReranker");
      return res;
    },

    retrievalEvaluatorLLM: async (state: AgentState, cfg: LangGraphRunnableConfig) => {
      log.info({ preState: createStateSummary(state) }, "→ [START] retrievalEvaluatorLLM");
      // Using the actual retrievalEvaluatorLLM implementation
      const res = await nodes.retrievalEvaluatorLLM(state, cfg, env);
      log.info({ postState: createStateSummary(res) }, "→ [END] retrievalEvaluatorLLM");
      return res;
    },

    toolNecessityClassifier: async (state: AgentState, cfg: LangGraphRunnableConfig) => {
      log.info({ preState: createStateSummary(state) }, "→ [START] toolNecessityClassifier");
      // Using the actual toolNecessityClassifier implementation
      const res = await nodes.toolNecessityClassifier(state, cfg, env);
      log.info({ postState: createStateSummary(res) }, "→ [END] toolNecessityClassifier");
      return res;
    },

    toolRouterLLM: async (state: AgentState, cfg: LangGraphRunnableConfig) => {
      log.info({ preState: createStateSummary(state) }, "→ [START] toolRouterLLM");
      // Using actual toolRouterLLM implementation
      const res = await nodes.toolRouterLLM(state, cfg, env, tools);
      log.info({ postState: createStateSummary(res) }, "→ [END] toolRouterLLM");
      return res;
    },

    runTool: async (state: AgentState, cfg: LangGraphRunnableConfig) => {
      log.info({ preState: createStateSummary(state) }, "→ [START] runTool");
      const res = await nodes.runTool(state, env, tools);
      log.info({ postState: createStateSummary(res) }, "→ [END] runTool");
      return res;
    },

    combineContextLLM: async (state: AgentState) => {
      log.info({ preState: createStateSummary(state) }, "→ [START] combineContextLLM");
      // Using the actual combineContextLLM implementation
      const res = await nodes.combineContextLLM(state, env);
      log.info({ postState: createStateSummary(res) }, "→ [END] combineContextLLM");
      return res;
    },

    generateAnswer: async (state: AgentState, cfg: LangGraphRunnableConfig) => {
      log.info({ preState: createStateSummary(state) }, "→ [START] generateAnswer");
      const res = await nodes.generateAnswer(state, cfg, env);
      log.info({ postState: createStateSummary(res) }, "→ [END] generateAnswer");
      return res;
    },

    outputGuardrail: async (state: AgentState, cfg: LangGraphRunnableConfig) => {
      log.info({ preState: createStateSummary(state) }, "→ [START] outputGuardrail");
      // Using the actual outputGuardrail implementation
      const res = await nodes.outputGuardrail(state, cfg, env);
      log.info({ postState: createStateSummary(res) }, "→ [END] outputGuardrail");
      return res;
    },

    /* Helper functions */

    routeBasedOnToolNecessity: async (state: any, config: LangGraphRunnableConfig) => {
      // We need to use 'any' type here to accommodate the LangGraph type system
      // The actual classification results would be in state based on tool_necessity_classifier node
      
      // Check if tools are needed by examining various possible state structures
      let needsTools = false;
      
      // Check various possible locations where tool necessity might be stored
      if (state.toolNecessityResult && typeof state.toolNecessityResult === 'object') {
        needsTools = !!state.toolNecessityResult.needsTools;
      } else if (state.classificationResult && typeof state.classificationResult === 'object') {
        needsTools = !!state.classificationResult.needsTools;
      } else if (state.classifierOutput && typeof state.classifierOutput === 'string') {
        // In case the classifier outputs a string decision
        needsTools = state.classifierOutput.includes('tools');
      }
      
      log.info({ needsTools }, "Routing based on tool necessity");

      return needsTools ? "needs_tools" : "no_tools";
    }
  };
}

/**
 * Helper function to compare states for debugging purposes
 * This is used in the logs to show what changed between state transitions
 */
/**
 * Helper function to compare states for debugging purposes
 * This is used in the logs to show what changed between state transitions
 */
function getStateDiff(oldState: AgentState, newState: AgentState): Record<string, any> {
  return createStateSummary(newState);
}

/**
 * Determines the content category for reranking based on document content analysis.
 * This function analyzes the content in the retrieved documents to identify
 * whether they belong to code, docs, or notes categories.
 *
 * @param state Current agent state with retrieval results
 * @returns The determined content category ('code', 'docs', or 'notes')
 */
function determineContentCategory(state: AgentState): 'code' | 'docs' | 'notes' {
  // If there are no docs, default to docs category
  if (!state.docs || state.docs.length === 0) {
    return 'docs';
  }
  
  // Check if we can infer the content type from retrieval results
  const retrievalResults = (state as any).retrievalResults || {};
  
  // Check if we have specific category results already
  if (retrievalResults.code?.chunks?.length > 0) {
    return 'code';
  } else if (retrievalResults.notes?.chunks?.length > 0) {
    return 'notes';
  } else if (retrievalResults.docs?.chunks?.length > 0) {
    return 'docs';
  }
  
  // Analyze document content to determine category
  let codePatterns = 0;
  let docsPatterns = 0;
  let notesPatterns = 0;
  
  for (const doc of state.docs) {
    const content = doc.body || '';
    const metadata = doc.metadata || {};
    
    // Check metadata source field for hints
    const source = metadata.source?.toLowerCase() || '';
    if (source.includes('code') || source.includes('github') || source.includes('.js') ||
        source.includes('.ts') || source.includes('.py')) {
      codePatterns += 2;
    } else if (source.includes('notes') || source.includes('todo') || source.includes('ideas')) {
      notesPatterns += 2;
    } else if (source.includes('docs') || source.includes('documentation') || source.includes('article')) {
      docsPatterns += 2;
    }
    
    // Check content for code-like patterns
    if (content.includes('```') || content.includes('function ') ||
        content.includes('class ') || content.includes('import ') ||
        content.includes('export ') || /\{\s*[\w\d]+:/.test(content)) {
      codePatterns++;
    }
    
    // Check for documentation patterns
    if (content.includes('## ') || content.includes('# ') ||
        content.includes('**') || content.includes('> ') ||
        /\[.*\]\(.*\)/.test(content)) {
      docsPatterns++;
    }
    
    // Check for note-like patterns
    if (content.includes('- [ ]') || content.includes('TODO:') ||
        content.includes('NOTE:') || content.includes('IDEA:')) {
      notesPatterns++;
    }
  }
  
  // Return the category with the highest pattern match count
  if (codePatterns > docsPatterns && codePatterns > notesPatterns) {
    return 'code';
  } else if (notesPatterns > docsPatterns && notesPatterns > codePatterns) {
    return 'notes';
  } else {
    return 'docs'; // Default to docs if tied or if docs has highest count
  }
}
