# Chat RAG – Graph v3 Design Doc

## 1 · Goals
1. Produce **higher-quality answers** by iteratively improving the retrieval set until it is "good enough" or we hit a budget.
2. Keep the **graph logic simple & explicit** – every decision is a node with a single responsibility.
3. Make **quality ↔︎ latency / cost** a **tunable trade-off** (max-loops, model choice, thresholds).
4. Re-use the solid pieces from v2 (retrieval selector, reranker, tool routing, answer generation) while cleaning up dead code / unused nodes.

## 1A · Implementation Progress

- [x] v3 graph file created (`src/graphs/v3.ts`)
- [x] new decision helper `decide_after_eval` implemented
- [x] new node `improve_retrieval` implemented
- [x] new optional node `answer_guard` placeholder
- [x] graph index exports `V3Chat`
- [x] controller switched to `V3Chat`
- [x] basic manual smoke test passes

## 2 · Pain-points in v2 (today)
* `retrievalEvaluatorLLM` is implemented but **never wired** into the graph, so the pipeline cannot judge retrieval quality.
* No feedback-loop: if the first retrieval is weak we still proceed to answer generation.
* Two very similar routing nodes (`routeAfterRetrieve`, `toolRouter`) – responsibilities blurred.
* Orchestration comments mention widening, evaluator, guardrails, but the edges are missing → code & design drift.

## 3 · High-level flow (v3)
```
┌──────────┐       ┌───────────────┐        ┌─────────────┐
│  START   │──────▶│ Question Prep │──┐     │ Max loops N │
└──────────┘       │  (rewrite)    │  │     └─────────────┘
                   └─────┬─────────┘  │            ▲   │
                         │            │            │   │  loop if
                         ▼            │            │   │  bad
                ┌────────────────┐    │            │   │
                │ Retrieval      │    │            │   │
                │  Selector      │    │            │   │
                └─────┬──────────┘    │            │   │
                      ▼               │            │   │
                ┌────────────────┐    │            │   │
                │ Retrieve (+RR) │────┤            │   │
                └─────┬──────────┘    │            │   │
                      ▼               │            │   │
                ┌─────────────────────┴────────────┼───┘
                │ Retrieval  Evaluator (LLM)       │
                └─────┬──────────────┬─────────────┘
                      │good enough?  │needs tools?
            yes ──────┘              │
                      │              │ yes
                      ▼              │
              ┌──────────────┐       │
              │ Combine Ctx  │       │
              └──────┬───────┘       │
                     ▼               │
              ┌──────────────┐       │
              │ Generate Ans │       │
              └──────┬───────┘       │
                     ▼               │
              ┌──────────────┐       │
              │  END (emit)  │       │
              └──────────────┘       │
                                     │
                    ┌────────────────┘
                    ▼
              ┌──────────────┐
              │ Tool Router  │
              └──────┬───────┘
                     ▼
              ┌──────────────┐
              │  Run Tool(s) │
              └──────┬───────┘
                     └────────────────────────────────────┐
                                                          │
                      (tool results added to retrievals) ─┘
```
If `Retrieval Evaluator` judges the context **inadequate**, but the loop counter `< N`, control returns to `Retrieval Selector` with a richer prompt (we can inject hints such as "focus on X", or widen query). After `N` iterations we fall back to best-effort answer.

## 4 · Node catalogue
| Node | Purpose | New / Re-use | Key outputs |
|------|---------|--------------|-------------|
| `routing_split` | Same as v2 – decide if input is chat or search style | Re-use | `mode` |
| `rewrite_query` | Polishes user query (remove pleasantries, include context) | *NEW* (simple LLM) | `rewrittenQuery` |
| `retrieval_selector` | Choose which retrievers to run | Re-use | `retrievalTasks[]` |
| `retrieve` | Run retrievers in parallel | Re-use | `retrievals` (chunks) |
| `unified_reranker` | Global chunk scoring | Re-use | scores in `retrievals` |
| `retrieval_evaluator` | Judge adequacy & tool-need | **Wire-up existing** (`retrievalEvaluatorLLM`) | `retrievalEvaluation`, `toolNecessity` |
| `improve_retrieval` | Decide next-step when evaluation says *bad* | *NEW* (wrapper) | maybe updates `iteration++`, query hints |
| `tool_router` | Decide & plan which tool(s) | Re-use | `toolPlan` |
| `run_tool` | Execute plan & attach results as synthetic chunks | Re-use | updated `retrievals` |
| `combine_context` | Prepare final context window | Re-use | `context` |
| `generate_answer` | LLM answer with citations | Re-use | `answer` |
| `answer_guard` | Optional moderation / policy filter | *NEW* (reuse infra) | validated `answer` |

## 5 · Control-flow / edges
```ts
START → routing_split → rewrite_query → loop_entry

loop_entry:
  retrieval_selector → retrieve → unified_reranker
    → retrieval_evaluator
        ├─ if adequate & !needsTool → combine_context
        │                               → generate_answer → answer_guard → END
        ├─ if needsTool              → tool_router → run_tool → combine_context … (same path)
        └─ if inadequate & iteration < MAX → improve_retrieval → retrieval_selector (repeat)
        └─ else (maxed)              → combine_context → generate_answer …
```
Control decisions implemented with `graph.addConditionalEdges()` or small decision nodes returning the next node key.

## 6 · Loop control & tunables
```ts
const MAX_ITERATIONS = env.MAX_RAG_LOOPS ?? 3; // per-request
const ADEQUACY_THRESHOLD = 0.75;               // from evaluator score
```
`iteration` lives in `state.metadata.iter` – incremented in `improve_retrieval`.

Front-end / API can pass a `quality` flag:
* `quick` → `MAX_ITERATIONS = 1`, cheaper model tier
* `balanced` (default) → 2
* `thorough` → 4 + gpt-4 evaluation

## 7 · Implementation notes & refactors
1. **Wire `retrievalEvaluatorLLM`** into the graph, remove obsolete `routeAfterRetrieve` & `dynamicWiden` (logic now lives in loop).
2. Collapse `routingSplit` & `toolRouter` branching helpers into small decision nodes that simply return the next edge key – simplifies the graph and logging.
3. Convert nodes to **pure functions** `state → update` where possible; avoid side-effects.
4. Introduce a `GraphContext` helper (env, tools, logger) to avoid passing the same deps to every wrapper.
5. Clean up `GraphStateAnnotation` to include `iteration`, `retrievalEvaluation`, `toolPlan`, `answer`.
6. Delete unused v1 code after v3 stabilises.

## 8 · Observability
* Keep existing span instrumentation (`ObservabilityService`).
* Add a **`rag_iteration` event** with: `iteration`, `evalScore`, `tookMs`, `retrieverStats`.
* Emit a **`graph_outcome`** event at END (`success`, `maxLoops`, `toolError`, …).

## 9 · Low-hanging fruit for answer quality
1. **Chunk-level de-duplication** before rerank (remove near-identical text).
2. **Query-strategy ensemble**: keyword, embedding, metadata filter; select via LLM hint.
3. **Tool results as retrieval chunks** – this is already planned, but ensure they are re-scored so that irrelevant tool output is ignored.
4. **Answer-self-consistency check** (two different temperatures, compare, if disagree run one more loop).
5. **Partial streaming** – stream citations as soon as generation starts, not after full answer.
6. **Caching**: retrieval + rerank results in KV for identical queries to cut latency for follow-ups.

## 10 · Migration plan
- Replace the existing `v2` graph with **v3 as the default** implementation straight away (it's an alpha product).
- Smoke-test locally and on staging; fix regressions quickly.
- Delete **v1** graph and any now-obsolete widen/routing nodes once v3 is merged.
- Iterate on thresholds / loop counts based on live metrics, not behind a flag.

---
✦ *Authored 2025-05-14* – proposed by AI pair programmer. 