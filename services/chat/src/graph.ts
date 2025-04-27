/**
 * Chat orchestration graph
 */
import {
  START,
  END,
  StateGraph,
  BaseCheckpointSaver,
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
/*  builder                                                           */
/* ------------------------------------------------------------------ */
export async function buildChatGraph(
  env: Env,
  cp?: BaseCheckpointSaver,
  te?: SecureToolExecutor,
): Promise<IChatGraph> {
  const log = getLogger().child({ component: "graphBuilder" });
  log.info("⧉ building chat graph");

  const checkpointer = cp ?? await new SecureD1Checkpointer(env.CHAT_DB, env).initialize().then(r => r ?? cp!);
  const tools = te ?? new SecureToolExecutor();

  const fn = createNodeWrappers(env, tools);

  const graph = new StateGraph(GraphStateAnnotation)
    .addNode("split_rewrite", fn.splitRewrite)
    .addNode("retrieve", fn.retrieve)
    .addNode("generate_answer", fn.generateAnswer)      // <- streaming
    .addEdge(START, "split_rewrite")
    .addEdge("split_rewrite", "retrieve")
    .addEdge("retrieve", "generate_answer")
    .addEdge("generate_answer", END);


  const compiled = graph.compile({ checkpointer });
  getLogger().info((await compiled.getGraphAsync()).drawMermaid());
  return compiled;
}

/* ------------------------------------------------------------------ */
/*  wrappers                                                          */
/* ------------------------------------------------------------------ */
function createNodeWrappers(env: Env, tools: SecureToolExecutor) {
  const log = getLogger().child({ component: "nodeWrappers" });

  return {
    /* sync/async nodes */
    splitRewrite: (s: AgentState) => {
      log.info("→ splitRewrite");
      return nodes.splitRewrite(s, env);
    },
    retrieve: (s: AgentState) => {
      log.info("→ retrieve");
      return nodes.retrieve(s, env);
    },

    generateAnswer: (state: AgentState) => {
      log.info('→ generateAnswer');
      return nodes.generateAnswer(state, env);
    },

    /* optional extras */
    dynamicWiden: (s: AgentState) => nodes.dynamicWiden(s, env),
    toolRouter: (s: AgentState) => nodes.toolRouter(s, env),
    runTool: (s: AgentState) => nodes.runTool(s, env, tools),

    routeAfterRetrieve: (s: AgentState) => nodes.routeAfterRetrieve(s),
    routeAfterTool: (s: AgentState) => nodes.routeAfterTool(s),
  };
}
