**Design Doc – Migrating Dome Chat Orchestrator to the Full Quivr-style RAG Pipeline**
_v 0.3 • 2025-04-24_

---

## 0 Executive Summary

We will extend the current three-node graph

```
START → split_rewrite → retrieve → generate_answer → END
```

into the richer, tool-aware, multi-task flow used by Quivr:

```
START
  └─► routing_split ─► filter_history ─► rewrite
        ├─► retrieve (or dynamic_retrieve)
        │     └─► tool_routing
        │           ├─► run_tool ─► generate_rag
        │           └─► generate_rag
        └─► generate_chat_llm      (fallback path)
                               ─► END
```

Key additions:

- **Nested `UserTasks`** for multi-query handling.
- **Tool gating** (`tool_routing`, `run_tool`).
- **Context window trimming** (`filter_history`, `reduce_rag_context`).
- **Dynamic widening** of vector search when recall is saturated.
- **Step-level SSE events + Langfuse tracing**.

---

## 1 State Transition

### 1.1 New TypeScript state definition

```ts
export interface UserTaskEntity {
  id: string;                 // uuid
  definition: string;         // (mutable) task/query
  docs: Document[];
  completable: boolean;
  tool?: string;
}

export interface AgentState {
  /* ---------- client input ---------------- */
  userId: string;
  messages: Message[];          // 0 == current user turn
  options: /* unchanged */;

  /* ---------- quivr additions -------------- */
  chatHistory: MessagePair[];   // trimmed view
  tasks?: Record<string, UserTaskEntity>;
  instructions?: string;
  files?: string;               // csv
  _filter?: Record<string, any>;

  /* ---------- transient -------------------- */
  docs?: Document[];            // union of all task docs
  reasoning?: string[];         // internal CoT
  tool?: string;                // currently executing
  generatedText?: string;       // answer delta (for SSE)

  /* ---------- telemetry -------------------- */
  metadata?: { nodeTimings?: Record<string, number>; traceId?: string };
}
```

### 1.2 Reducers annotation

```ts
export const GraphStateAnnotation = Annotation.Root({
  userId: Annotation<string>(),
  messages: concat<Message>(),
  chatHistory: Annotation<MessagePair[]>(),
  tasks: merge<Record<string, UserTaskEntity>>(),
  docs: concat<Document>(),
  reasoning: concat<string>(),
  instructions: Annotation<string>(),
  files: Annotation<string>(),
  generatedText: Annotation<string>(),
  metadata: merge<AgentState['metadata']>(),
  options: Annotation<AgentState['options']>(),
});
```

---

## 2 Node Catalogue & Responsibilities

| Node                            | Implementation hints                                                                                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `routing_split`                 | Implement Quivr’s `SPLIT_PROMPT` via `llm.invokeStructured<SplittedInput>()`. Decide edge: → `edit_system_prompt` (if `instructions`) else `filter_history`. |
| `edit_system_prompt`            | Use `UPDATE_PROMPT` to mutate `state.instructions` and `workflow.activatedTools`.<br>Return `{ messages: [], reasoning }`.                                   |
| `filter_history`                | Copy Quivr logic: walk `chatHistory` from newest until token + pair caps; output new trimmed array.                                                          |
| `rewrite`                       | Async gather over tasks → `CONDENSE_TASK_PROMPT`.                                                                                                            |
| `retrieve` / `dynamic_retrieve` | Wrap Constellation search with `ContextualCompressionRetriever`. Loop logic identical to Quivr’s `dynamic_retrieve`.                                         |
| `tool_routing`                  | Feed each task into `TOOL_ROUTING_PROMPT`; flag `completable` + `tool`. Conditional edge: `needs_tool` vs `answer`.                                          |
| `run_tool`                      | Instantiate tool via `SecureToolExecutor`; convert output into `Document[]`; embed relevance score.                                                          |
| `generate_rag`                  | Construct `RAG_ANSWER_PROMPT`, call `reduce_rag_context`, invoke LLM (tools bound). Stream chunks for SSE.                                                   |
| `generate_chat_llm`             | Fallback simple prompt when no retrieval occurred.                                                                                                           |

---

## 3 Graph Builder Changes

```ts
export async function buildChatGraph(env: Env, cp?: BaseCheckpointSaver) {
  const checkpointer = cp ?? (await new SecureD1Checkpointer(env.CHAT_DB, env).initialize());
  const tools = new SecureToolExecutor();
  const fn = createNodeWrappers(env, tools);

  return (
    new StateGraph(GraphStateAnnotation)
      /* core path */
      .addNode('routing_split', fn.routingSplit)
      .addNode('edit_system_prompt', fn.editSystemPrompt)
      .addNode('filter_history', fn.filterHistory)
      .addNode('rewrite', fn.rewrite)
      .addNode('retrieve', fn.retrieve)
      .addNode('dynamic_retrieve', fn.dynamicWiden)
      .addNode('tool_routing', fn.toolRouter)
      .addNode('run_tool', fn.runTool)
      .addNode('generate_rag', fn.generateAnswer) // streaming answer
      .addNode('generate_chat_llm', fn.generateChatLLM) // optional fallback

      /* edges */
      .addEdge(START, 'routing_split')
      .addEdge('edit_system_prompt', 'filter_history')
      .addEdge('routing_split', 'edit_system_prompt') // if instr
      .addEdge('routing_split', 'filter_history') // if tasks
      .addEdge('filter_history', 'rewrite')
      .addEdge('rewrite', 'retrieve')
      .addEdge('retrieve', 'tool_routing')
      .addEdge('dynamic_retrieve', 'tool_routing')
      .addConditionalEdges('tool_routing', fn.routeAfterTool, {
        run_tool: 'run_tool',
        answer: 'generate_rag',
      })
      .addEdge('run_tool', 'generate_rag')
      .addEdge('generate_rag', END)
      .addEdge('generate_chat_llm', END)
      .addConditionalEdges('retrieve', fn.routeAfterRetrieve, {
        widen: 'dynamic_retrieve',
        answer: 'tool_routing',
      })

      .compile({ checkpointer })
  );
}
```

---

## 4 Prompt Library

| Tag                    | File                        | Description                       |
| ---------------------- | --------------------------- | --------------------------------- |
| `SPLIT_PROMPT`         | `prompts/split.txt`         | Extract instructions + tasks.     |
| `UPDATE_PROMPT`        | `prompts/update_prompt.txt` | Negotiate persona & tool toggles. |
| `CONDENSE_TASK_PROMPT` | `prompts/condense.txt`      | Rewrite queries succinctly.       |
| `TOOL_ROUTING_PROMPT`  | `prompts/tool_route.txt`    | Judge completeness & pick tool.   |
| `RAG_ANSWER_PROMPT`    | `prompts/rag_answer.txt`    | Main synthesis template.          |
| `CHAT_LLM_PROMPT`      | `prompts/chat_llm.txt`      | Vanilla chat fallback.            |

---

## 5 Streaming & UI Contract

- `generate_rag` emits `on_chat_model_stream` → event type `"answer"` with fields:
  ```json
  { "delta": "...new text...", "sources": [{ "knowledgeId": "...", "chunkIndex": 7 }] }
  ```
- Every node end emits `"workflow_step"` with `{ "step":"retrieve" }`.
- Final event: `{ "type":"done", "metadata":{...} }`.

---

## 6 Tool Executor Extension

`SecureToolExecutor` must expose:

```ts
execute(name: string, input: unknown): Promise<{ text: string; docs: Document[] }>
```

Where `docs` are scored and carry `{ similarity, relevance_score }` keys so `filter_chunks_by_relevance` can apply thresholds.

---

## 7 Checkpoint & Resume

- Keep existing `SecureD1Checkpointer`; ensure it saves **entire `tasks` object**.
- Quivr resumes after each LangGraph **super-step**; configure saver:
  ```ts
  compile({ checkpointer, superstepKey: 'langgraph_node' });
  ```

---

## 8 Migration Steps

| Week | Milestone                                                                            |
| ---- | ------------------------------------------------------------------------------------ |
| 1    | Add new state fields & reducers; port prompt files.                                  |
| 2    | Implement nodes: `routing_split`, `edit_system_prompt`, `filter_history`, `rewrite`. |
| 3    | Implement `retrieve`, `dynamic_retrieve` using Constellation + Cohere rerank.        |
| 4    | Implement `tool_routing`, `run_tool`; extend `SecureToolExecutor`.                   |
| 5    | Implement `generate_rag` (+ streaming diff logic). Integrate Langfuse.               |
| 6    | Shadow 10 % traffic; compare answer quality + p95 latency.                           |
| 7    | Full cut-over; remove legacy simple path.                                            |

---

## 9 Risks & Mitigations

| Risk                                      | Mitigation                                                                    |
| ----------------------------------------- | ----------------------------------------------------------------------------- |
| Token explosion with multi-task requests. | `reduce_rag_context` trims aggressively; cap `MAX_ITERATIONS=20`.             |
| Tool misuse / prompt injection.           | `SecureToolExecutor` sanitises input + output JSON schema.                    |
| Vector search latency.                    | Dynamic widening limited to 2 extra passes and guarded by total token budget. |

---

### Appendix A – Utility Helpers

- `countTokens(str, modelId)` – wrap Workers AI tokenizer.
- `scoreFilter(docs[], threshold)` – reusable across retriever & tool output.
- `concatListFiles(list, max)` – port of `format_file_list`.

---

**Outcome:** After the migration Dome’s chat now supports multi-question turns, conditional tool usage, richer citations, and step-level streaming—matching Quivr’s feature set while preserving Cloudflare-native deployment.
