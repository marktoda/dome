**Dome Chat Orchestrator — Design Refresh (LangGraph.js Edition)**
_v 0.2 • 2025-04-24_

---

## 1 Overview

We will build the new Chat Orchestrator Worker **directly on top of `@langchain/langgraph`** – the officially-supported JS/TS port of the Python framework citeturn0search0.
LangGraph.js already gives us:

- **`StateGraph<T>`** builder, conditional edges, reducers, streaming.
- **Checkpoint & resume** interfaces (`@langchain/langgraph-checkpoint`) citeturn0search6.
- Tight integration with LangChain-JS components (retrievers, runnables, chat models) citeturn0search2.

We therefore _drop_ the plan to author a bespoke SDK and instead write a **thin “Dome glue” layer** that:

1. Adds Cloudflare-Workers ergonomics (bindings, durable objects, metrics).
2. Exposes a stable `chatStream()` RPC used by Dome API.

---

## 2 Goals & Scope

| Goal                                                              | Rationale                                          |
| ----------------------------------------------------------------- | -------------------------------------------------- |
| Adopt `@langchain/langgraph` with minimal wrapping.               | Reduce maintenance, inherit upstream features.     |
| Keep the **RAG state-machine** identical to our Python prototype. | Portability & confidence.                          |
| Integrate CF-native observability (Workers Metrics, Langfuse).    | SLI/SLO compliance.                                |
| Provide SSE/WebSocket streaming with step metadata.               | Rich UX.                                           |
| Non-goal → visual editor or custom DSL.                           | Deferred; upstream CLI exists citeturn0search4. |

---

## 3 Runtime Architecture

```mermaid
flowchart LR
    subgraph Worker:chat-orchestrator
        A[HTTP /chat] -->|JSON POST| B[GraphRunner.astream()]
        B --> C[LangGraph.js Engine]
        C -. checkpoints .-> DO[(Durable Object)]
        C -->|events| SSE{{SSE Stream}}
    end
    SSE --> Client
```

- **Graph Engine** = LangGraph.js.
- **Checkpointer** = new `D1Checkpointer` (implements `LangGraphCheckpointer`).
- **Cloudflare Durable Object** optional for long-running multi-turn sessions.

---

## 4 Implementation Plan

### 4.1 Dependencies

```bash
pnpm add @langchain/langgraph @langchain/core \
         @langchain/langgraph-checkpoint \
         @dome/logging @dome/metrics
```

### 4.2 Graph Definition (`src/graph.ts`)

```ts
import { StateGraph, START, END } from '@langchain/langgraph';
import * as nodes from './nodes'; // splitRewrite, retrieve, ...

export type AgentState = {
  messages: Msg[];
  chatHistory: ChatHistory;
  tasks?: Tasks;
  docs?: Doc[];
  // …other keys…
};

// ---- Build graph ----
export const buildChatGraph = () =>
  new StateGraph<AgentState>()
    .addNode('split_rewrite', nodes.splitRewrite)
    .addEdge(START, 'split_rewrite')
    .addEdge('split_rewrite', 'retrieve')
    .addNode('retrieve', nodes.retrieve)
    .addConditionalEdges('retrieve', nodes.routeAfterRetrieve, {
      widen: 'dynamic_widen',
      tool: 'tool_router',
      answer: 'generate_answer',
    })
    .addNode('dynamic_widen', nodes.dynamicWiden)
    .addNode('tool_router', nodes.toolRouter)
    .addNode('run_tool', nodes.runTool)
    .addNode('generate_answer', nodes.generateAnswer)
    .addEdge('dynamic_widen', 'tool_router')
    .addConditionalEdges('tool_router', nodes.routeAfterTool, {
      run_tool: 'run_tool',
      answer: 'generate_answer',
    })
    .addEdge('run_tool', 'generate_answer')
    .addEdge('generate_answer', END)
    .compile({
      checkpointer: new D1Checkpointer(env.D1), // custom impl
      reducers: { docs: 'append', tasks: 'merge' },
    });
```

### 4.3 Worker Entrypoint (`src/index.ts`)

```ts
import { buildChatGraph } from './graph';

export default {
  async fetch(req: Request, env: Bindings, ctx: ExecutionContext) {
    const { initialState } = await req.json();
    const graph = buildChatGraph();

    const stream = graph.astream(initialState, {
      // Pass Workers env + helper for log/metrics
      callbacks: [langfuseHandler(env)],
      env,
    });

    return new Response(ReadableStream.from(stream), {
      headers: { 'Content-Type': 'text/event-stream' },
    });
  },
};
```

### 4.4 D1 Checkpointer (edge-optimised)

```ts
import { Checkpointer, SuperStep } from '@langchain/langgraph-checkpoint';

export class D1Checkpointer implements Checkpointer {
  constructor(private db: D1Database) {}
  async read(runId: string) {
    /* SELECT state_json FROM checkpoints */
  }
  async write(runId: string, step: SuperStep, state: unknown) {
    await this.db
      .prepare('INSERT INTO cp VALUES (?, ?, ?)')
      .bind(runId, step, JSON.stringify(state))
      .run();
  }
}
```

### 4.5 Metrics & Logging

- Wrap every node with `withMetrics(nodeFn, nodeName)` decorator.
- Automatically record `execution_ms`, `input_tokens`, `output_tokens`.
- Use LangGraph’s per-step event hooks to emit `state_size_bytes` metric.

---

## 5 API Contract

### 5.1 Dome API ↔ Chat Orchestrator

```ts
// Dome API
const resp = await env.CHAT_ORCHESTRATOR.fetch('/chat', {
  method: 'POST',
  body: JSON.stringify({ initialState }),
  headers: { 'Content-Type': 'application/json' },
});
return resp; // SSE stream
```

**Stream events**

```
event: workflow_step
data: {"step":"retrieve"}

event: answer
data: {"delta":"• Delaware recognises ...", "sources":[...]}

event: done
```

---

## 6 Migration Steps

| Week | Tasks                                                                                  |
| ---- | -------------------------------------------------------------------------------------- |
| 1    | **Spike**: Port Python RAG graph to LangGraph.js; run inside Miniflare with mock data. |
| 2    | Implement D1 Checkpointer & Langfuse callbacks; add metrics decorators.                |
| 3    | Integrate Worker into Dome API behind `?rag2=1` flag; shadow traffic 10 %.             |
| 4    | Remove legacy `ChatService.buildPrompt`; make Orchestrator the default.                |

---

## 7 Risks & Mitigations

| Risk                                            | Mitigation                                                 |
| ----------------------------------------------- | ---------------------------------------------------------- |
| Large npm bundle size.                          | Use `esbuild --external` to tree-shake; cloudflare-minify. |
| Memory in long streams.                         | Checkpoint after each super-step; GC old history tokens.   |
| Multiple package versions of `@langchain/core`. | Pin via `resolutions` in `package.json`.                   |

---

## 8 Reference Links

- **LangGraph.js npm package** – install, quick-start guide citeturn0search0turn0search2
- **Checkpoint interface docs** – `@langchain/langgraph-checkpoint` citeturn0search6
- **LangGraph CLI (optional)** – scaffolding & local tests citeturn0search4

---

### Summary

By leaning on **LangGraph.js** we eliminate a full SDK build, gain parity with the Python ecosystem, and can deliver the new RAG-first chat backend in **≤ 4 weeks** with minimal custom code.
