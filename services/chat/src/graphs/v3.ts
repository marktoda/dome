/**
 * Chat RAG – Graph v3
 * -------------------
 * Implements the iterative retrieval loop described in docs/CHAT_GRAPH_V3_DESIGN.md.
 */
import {
  START,
  END,
  StateGraph,
  BaseCheckpointSaver,
  LangGraphRunnableConfig,
} from '@langchain/langgraph';
import { getLogger } from '@dome/common';

import { D1Checkpointer } from '../checkpointer/d1Checkpointer';
import { ToolRegistry } from '../tools';
import * as nodes from '../nodes';
import { AgentState } from '../types';
import { GraphStateAnnotationV3 as GraphStateAnnotation } from '../types/graphStateV3';
import { createStateSummary } from '../utils/loggingHelpers';
import { ChatBuilder, IChatGraph } from '.';
import { ObservabilityService } from '../services/observabilityService';

// Helper factory: returns a decision function closed over maxLoops from env
function makeDecideAfterEval(maxLoops: number) {
  return function decideAfterEval(
    state: AgentState,
  ): 'combine_context' | 'tool_router' | 'improve_retrieval' {
    const evalRes = (state as any).retrievalEvaluation;
    const toolNec = (state as any).toolNecessityClassification;

    const adequate = !!evalRes?.isAdequate;
    const needsTool = !!toolNec?.isToolNeeded;

    const iteration = state.metadata?.iteration ?? 0;

    if (adequate && !needsTool) return 'combine_context';
    if (needsTool) return 'tool_router';

    // If retrieval inadequate
    if (iteration >= maxLoops) {
      // stop looping – proceed with what we have
      return 'combine_context';
    }
    return 'improve_retrieval';
  };
}

export const V3Chat: ChatBuilder = {
  async build(env: Env, cp?: BaseCheckpointSaver): Promise<IChatGraph> {
    const log = getLogger().child({ component: 'ragGraphBuilderV3' });
    log.info('⧉ building RAG Chat Graph v3');

    const checkpointer =
      cp ?? (await new D1Checkpointer(env.CHAT_DB).initialize().then(r => r ?? cp!));
    const tools = ToolRegistry.fromDefault();

    const fn = createNodeWrappers(env, tools);

    const maxLoops = Number((env as any).MAX_RAG_LOOPS ?? 3);

    const graph = new StateGraph(GraphStateAnnotation)
      // Core preprocessing
      .addNode('routing_split', fn.routingSplit)
      .addNode('rewrite_query', fn.rewrite)

      // Main loop entry
      .addNode('retrieval_selector', fn.retrievalSelector)
      .addNode('retrieve', fn.retrieve)
      .addNode('unified_reranker', fn.unifiedReranker)
      .addNode('retrieval_evaluator', fn.retrievalEvaluatorLLM)
      .addNode('improve_retrieval', fn.improveRetrieval)

      // Tools
      .addNode('tool_router', fn.toolRouter)
      .addNode('run_tool', fn.runTool)

      // Generation
      .addNode('combine_context', fn.combineContext)
      .addNode('doc_to_sources', fn.docToSources)
      .addNode('generate_answer', fn.generateAnswer)
      .addNode('answer_guard', fn.answerGuard)

      /* Edges */
      .addEdge(START, 'routing_split')
      .addEdge('routing_split', 'rewrite_query')
      .addEdge('rewrite_query', 'retrieval_selector')
      .addEdge('retrieval_selector', 'retrieve')
      .addEdge('retrieve', 'unified_reranker')
      .addEdge('unified_reranker', 'retrieval_evaluator')

      // Branching after evaluation
      .addConditionalEdges('retrieval_evaluator', makeDecideAfterEval(maxLoops), {
        combine_context: 'combine_context',
        tool_router: 'tool_router',
        improve_retrieval: 'improve_retrieval',
      })

      // Loop edge back to selector
      .addEdge('improve_retrieval', 'retrieval_selector')

      // Tool path
      .addEdge('tool_router', 'run_tool')
      .addEdge('run_tool', 'combine_context')

      // Generation path
      .addEdge('combine_context', 'doc_to_sources')
      .addEdge('doc_to_sources', 'generate_answer')
      .addEdge('generate_answer', 'answer_guard')
      .addEdge('answer_guard', END);

    const compiled = graph.compile({ checkpointer });

    return compiled;
  },
};

function createNodeWrappers(env: Env, tools: ToolRegistry) {
  const log = getLogger().child({ component: 'ragNodeWrappersV3' });

  // Helper that decorates a node with pre/post logging
  function wrap<T extends unknown[], R>(
    name: string,
    fn: (state: AgentState, ...args: T) => Promise<R>,
  ) {
    return async (state: AgentState, ...args: T): Promise<R> => {
      log.info({ preState: createStateSummary(state) }, `→ [START] ${name}`);
      const res = await fn(state, ...(args as any));
      log.info({ postState: createStateSummary(res as any) }, `→ [END] ${name}`);
      return res;
    };
  }

  return {
    routingSplit: wrap('routingSplit', (s: AgentState) => nodes.routingSplit(s, env)),
    rewrite: wrap('rewrite', (s: AgentState) => nodes.rewrite(s, env)),
    retrievalSelector: wrap('retrievalSelector', (s: AgentState, cfg: LangGraphRunnableConfig) =>
      nodes.retrievalSelector(s, cfg, env),
    ),
    retrieve: wrap('retrieve', (s: AgentState, cfg: LangGraphRunnableConfig) =>
      nodes.retrieve(s, cfg, env),
    ),
    unifiedReranker: wrap('unifiedReranker', (s: AgentState, cfg: LangGraphRunnableConfig) =>
      nodes.reranker(s, cfg, env),
    ),
    retrievalEvaluatorLLM: wrap(
      'retrievalEvaluatorLLM',
      (s: AgentState, cfg: LangGraphRunnableConfig) => nodes.retrievalEvaluatorLLM(s, cfg, env),
    ),
    improveRetrieval: wrap('improveRetrieval', (s: AgentState) => nodes.improveRetrieval(s, env)),
    toolRouter: wrap('toolRouter', (s: AgentState, cfg: LangGraphRunnableConfig) =>
      nodes.toolRouter(s, env, tools),
    ),
    runTool: wrap('runTool', (s: AgentState, cfg: LangGraphRunnableConfig) =>
      nodes.runTool(s, env, tools),
    ),
    combineContext: wrap('combineContext', (s: AgentState) => nodes.combineContext(s, env)),
    docToSources: wrap('docToSources', (s: AgentState) => nodes.docToSources(s)),
    generateAnswer: wrap('generateAnswer', (s: AgentState, cfg: LangGraphRunnableConfig) =>
      nodes.generateAnswer(s, cfg, env),
    ),
    answerGuard: wrap('answerGuard', (s: AgentState) => nodes.answerGuard(s)),
  };
} 