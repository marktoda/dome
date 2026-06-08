# Autonomous background agents (framework) + the ingest agent — design

- **Status:** Draft for review (brainstorm output; not yet normative)
- **Date:** 2026-06-08
- **Author:** Mark Toda (with Claude)
- **Replaces:** the `dome.intake` bundle (retired — see §11)
- **Normative home (later):** a `docs/wiki/specs/autonomous-agents.md` spec + any new/edited invariants land *with* the implementation; this file is the pre-implementation design.

---

## 1. Motivation

Dome needs a **first-class autonomous-background-agent capability**. The vault is fed by clients of widely varying intelligence — a smart foreground coding agent at one end, a dumb voice-to-text or `curl`-into-the-inbox dump at the other. The dumb end needs the runtime itself to do the heavy lifting: take a raw input and act on it with judgment, end to end, no human curating each step.

**Agents are a general kind, not a one-off.** Ingest is the first one, but the same framework should host a synthesizer agent (find related ideas across the vault, propose new connections), a research agent, an action-items agent, and others not yet imagined. So this design builds a **generic agent framework** and **one agent on it** (ingest). Adding the next agent should be "write a charter, grant capabilities, register a trigger" — no new machinery.

### The first agent: ingest

The ingest agent performs the **Ingest workflow already documented in the work vault's `CLAUDE.md`** (and the recovered v0.5 `.dome/prompts/ingest.md`):

> read the raw source → identify atoms (entities, concepts, sources, decisions, action-items) → create a `wiki/sources/<slug>` summary → create/update `entity` and `concept` pages → wire bidirectional `[[wikilinks]]` → update `index.md` → append `log.md` → route action-items to task surfaces (today's daily note / an entity's `## Open threads`) → consume the inbox file.

This is fundamentally **agentic** (read-with-judgment, find/read related pages, decide create-vs-update, write prose, 5–15 edits across the graph). The v0.5 workflow engine that did it was hard-deleted in the v1 cutover (`f35fa28`); today's `dome.intake` only *stages* extracted atoms into `wiki/generated/intake/` and never integrates them. This design brings the integration back as the first agent on the new framework.

Knowledge integration is the spine; task-routing is opportunistic (only when a source carries action-items). The agent may **create, merge, and rewrite** curated pages — the most-integrated posture — because **git is the rollback net** and the **integrity warden is the quality net**, and because the owner already trusts a foreground agent to do exactly this and does not want to hand-curate.

---

## 2. Goals / Non-goals

**Goals**
- A reusable **agent framework**: a garden-phase processor runs a true tool-use loop against the vault and lands its edits through Dome's normal Proposal/commit path. An *agent* is defined by data — `{ id, charter, trigger, tools, capabilities }` — not new code.
- **Provider-neutral, broker-accounted** model access: every model call rides the `ctx.modelInvoke` seam (cost caps, allowlist, `capability_uses`, abort, SourceRef enforcement).
- The first agent: **ingest**, triggered by `inbox/raw/*`, doing the full `CLAUDE.md` Ingest workflow automatically.
- **Grant-as-boundary**: an agent writes exactly the paths its capability grant covers — no hardcoded write-prohibitions beyond two structural floors (§6).
- Vendor LLM SDK stays **out of `@dome/sdk` core** (no-LLM-in-core invariant holds).
- **Dump-and-forget**: dropping a file in the inbox needs no further human action in the common case.

**Non-goals (this design)**
- The *foreground* ingest flow (telling a coding agent your thoughts) — already works, out of scope.
- Building the synthesizer / research / action-items agents now. The framework is designed for them; only ingest is built (YAGNI).
- Multi-agent orchestration, streaming/interactive agents, mid-run human approval gates, sub-agent spawning.
- Triggers other than `inbox/raw/*` (this design ships one trigger; the framework allows others).
- Non-Anthropic providers (the seam is provider-neutral; only the Anthropic command provider is implemented).

---

## 3. Architecture overview

An **autonomous agent is a garden-phase `Processor` (`kind: llm`) whose `run(ctx)` drives a tool-use loop** and emits the result as a `PatchEffect` (+ optional `QuestionEffect`s). **No new core primitive** — still Vault / Proposal / Processor / Effect. As with wardens ("a warden is a processor, not a new concept"), *an agent is a processor too — one that loops with judgment.*

```
<trigger fires>  e.g. inbox/raw/<src>.md committed
  └─ <agent processor>  (garden, kind: llm)   run(ctx):
       │  framework harness (shared, ~bundle lib):
       │     messages = [system: charter, user: task]
       │     loop:
       │       step = ctx.modelInvoke.step({ messages, tools })   ← provider-neutral seam (§4)
       │       if step.toolCalls:
       │          execute each (reads → ctx.snapshot ; writes → EditAccumulator ; ask → QuestionEffect)
       │          append tool results ; continue
       │       else final text / budget reached → stop
       │
       └─ emit  PatchEffect(mode:"auto", paths ⊆ <agent's patch.auto grant>, SourceRefs=[trigger src])
                + QuestionEffect[]                                  ← garden Proposal → adoption → commit
```

**Layers (specified together, cleanly separable):**
- **Layer 1 — the agent framework** (§5): the model-seam extension (§4), the loop harness, the `AgentDefinition` shape, the Dome tool bindings, edit accumulation → one `PatchEffect`, budget + observability.
- **Layer 2 — the ingest agent** (§7): `AgentDefinition` #1 — charter = the `CLAUDE.md` Ingest workflow, trigger = `inbox/raw/*`, concrete tool set + grant.

Bundle: **`dome.agent`** holds the framework (`lib/`) and the agent definitions. `dome.intake` is retired (§11).

---

## 4. The model-seam extension (D3) — text-completion → tool-calling step

Today the model boundary is single-shot text (`prompt → text`). D3 generalizes it by **one** capability: a **tool-calling step** — `messages + tool-schemas → tool-calls | text`. The provider never executes tools (it has no vault access); it only reports the calls, and the processor executes them.

```ts
// names indicative; finalized in the plan
type ToolSchema = { name: string; description: string; inputSchema: JSONSchema };

type ModelStepRequest = {
  schema: "dome.model-provider.step/v1";
  messages: ModelMessage[];                 // system/user/assistant/tool roles
  tools: ToolSchema[];
  model?: string; signal: AbortSignal;
};
type ModelStepResponse = {
  toolCalls?: { id: string; name: string; input: unknown }[];   // exactly one of
  text?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  costUsd?: number; model?: string;
};
```

- **`ctx.modelInvoke` gains a step entry** (`ctx.modelInvoke.step(req)`), enforcing the *same* `model.invoke` machinery per call: `maxDailyCostUsd` (before/after), allowlist, `capability_uses` logging, shared abort, response validation.
- **The command provider gains a v2 mode.** `.dome/model-provider.ts` answers `dome.model-provider.step/v1` and implements it with the **AI SDK vault-side** — `generateText({ model: anthropic(<id>), messages, tools, stopWhen: stepCountIs(1) })` with tools declared **without `execute`** (the SDK returns `toolCalls` for manual handling). The hard part (the Anthropic tool-call wire protocol, message/tool formatting and parsing) is reused, not reinvented.
- **Core stays clean.** `ctx.modelInvoke.step` is provider-neutral; it serializes messages/tools and shells to the provider over the same JSON-over-stdio boundary as today. `ai`/`@ai-sdk/anthropic` live only in `.dome/model-provider.ts` and the `dome.agent` bundle — never in `src/index.ts`'s static graph. `ENGINE_HAS_NO_LLM_OR_MCP_DEPENDENCY` holds.

> The loop can't live in the provider (separate process, no vault access). D3 puts the one hard *model call* behind the seam and keeps the trivial `while` loop in the bundle. The wheel we don't reinvent is the tool-calling protocol, not the loop.

---

## 5. Layer 1 — the agent framework

### `AgentDefinition` (the unit)

```ts
type AgentDefinition = {
  id: string;                       // e.g. "dome.agent.ingest"
  charter: string;                  // system prompt — the agent's instructions (a bundled prompt file)
  trigger: ProcessorTrigger;        // e.g. change touching inbox/raw/*.md
  tools: AgentTool[];               // the tools this agent may call
  budget: { maxSteps: number };     // per-day cost cap comes from the model.invoke grant
  // capabilities are declared in the bundle manifest + granted in .dome/config.yaml
};
```

Each definition is registered as a garden-phase `kind: llm` processor whose `run` calls the shared harness. Adding an agent = adding a definition.

### The harness (`assets/extensions/dome.agent/lib/agent-loop.ts`)

Inputs: `charter`, `task` (the user-turn content), `tools` (`{ schema, execute(input, ctx) }`), `step` (the model-step fn — **injected**, defaults to `ctx.modelInvoke.step`), `budget`.
Output: `{ edits: EditAccumulator, questions: PendingQuestion[], stopReason, steps }`.

Loop contract:
1. `messages = [system: charter, user: task]`.
2. `resp = await step({ messages, tools: schemas, signal })`.
3. `resp.toolCalls` → execute in order (reads via `ctx.snapshot`; writes mutate `EditAccumulator`; `askOwner` pushes a pending question), append assistant tool-call + tool-result messages, `continue`.
4. `resp.text` with no tool calls → done (`stopReason:"final"`).
5. `steps >= maxSteps` → stop (`stopReason:"budget"`), keep accumulated edits.
6. Each step surfaced to `onStep` for serve logs (step #, tool names, tokens) — reuses the enriched-serve-logging accumulator in `serve.ts`.

**Translation to effects** (by the processor): the `EditAccumulator` (`path → finalContent | delete`) becomes **one `PatchEffect`** (`mode:"auto"`) with a `SourceRef` per touched path pointing at the trigger source (required for model-capable patches). Pending questions → `QuestionEffect`s.

**No-op without a model.** If `ctx.modelInvoke`/the step seam reports no provider, the harness returns empty — no edits, no error, never a failed run (mirrors the warden no-op).

`step` is injected → the framework is testable with a scripted fake model, no network (§10).

---

## 6. The capability boundary — grant-as-boundary

Dome currently tangles two different things. This design separates them:

- **Invariants — structural, unchanged.** Rebuildability, markdown-is-source-of-truth, model-processors-emit-no-durable-facts, every-effect-is-capability-checked, the `Dome-Run` human/engine commit split. None of these say "don't write `notes/`" — they don't change to let agents write broadly.
- **Conventions — policy, loosened.** "`notes/` is user-owned except today's daily," "don't touch `templates/`," etc. — global prohibitions baked into convention/docs. These go away.

**The capability grant in `.dome/config.yaml` is the single write boundary.** An agent (or any processor) writes exactly the paths its `patch.auto`/`patch.propose` grant covers — nothing hardcoded. Want ingest to update `notes/`? Grant `patch.auto: notes/**`. The safety in exchange is what the owner named: **git** (with the `Dome-Run` trailer split, so human-written vs Dome-changed is always queryable) **+ the integrity warden** reviewing the result.

**Two hard floors remain (not pure policy):**
1. **`isObsidianTasksDashboard` skip** — interop correctness (the Obsidian Tasks plugin breaks on an injected `^anchor`), not a trust boundary. Kept in processor logic; the grant model is positive-glob-only and can't express it.
2. **`raw/` immutability** — `wiki/sources/` pages cite `[[raw/...]]` as provenance; rewriting `raw/` would destroy "what was actually ingested." Treated as provenance integrity: `raw/` is not granted writable to agents.

Everything else is grant-defined: `templates/`, historical notes, anything — writable iff granted, not because a rule says so. No invariant breaks: notes stay markdown, rebuildable, source-of-truth, with the human/engine split intact.

---

## 7. Layer 2 — the ingest agent (`dome.agent.ingest`, definition #1)

- **Phase / kind:** garden, `kind: llm`. **Model:** Anthropic **Sonnet** (configurable; exact id pinned at implementation).
- **Trigger:** a change touching `inbox/raw/*.md`. Idempotent by consumption — the agent archives/deletes the raw file in its patch, so a converged source doesn't re-fire.
- **Charter:** the `CLAUDE.md` Ingest workflow, made explicit and self-contained (source-page + entity/concept create-merge-rewrite + bidirectional links + `index.md` + `log.md` + task routing + substrate-vs-task rule + "no one-shot pages: recurrence/structural justification" + consume the inbox file). The charter is data (a bundled prompt file), not code.
- **Task turn:** the raw source's path + content.

**Tool surface** (bound to `ctx`):

| Tool | Kind | Effect path |
|---|---|---|
| `listPages(globOrType?)` | read | `ctx.snapshot` listing |
| `readPage(path)` | read | `ctx.snapshot.readFile` |
| `searchVault(query)` | read | projection/search read (or snapshot scan) |
| `writePage(path, content)` | write | accumulate create/replace |
| `patchPage(path, edit)` | write | accumulate targeted edit |
| `routeTask({surface, line, link?})` | write | accumulate edit to today's daily or an entity `## Open threads` |
| `archiveSource(rawPath)` | write | accumulate move `inbox/raw/x` → `inbox/processed/x` (or delete) |
| `askOwner(question)` | question | `QuestionEffect` |

**Task line format** (from the recovered spec): `- [ ] #task <desc> <priority? 🔺⏫🔼🔽> <due? 📅 YYYY-MM-DD> <[[wiki/entities/<slug>]]?>`. The `#task` tag is what makes a line **surface-eligible** in the daily Open Loops (`isSurfaceEligibleNonDailyAction`); the old pipeline emitted plain `- [ ]` and silently failed that gate. The charter must tag routed tasks.

**Default grant** (in `.dome/config.yaml`):
- `read`: `wiki/**/*.md`, `notes/**/*.md`, `inbox/**/*.md`, `index.md`, `log.md`
- `model.invoke`: `{ maxDailyCostUsd: 5 }` (default; adjust later) · harness `budget.maxSteps: 25`
- `patch.auto`: `wiki/**/*.md`, `notes/**/*.md`, `index.md`, `log.md`, `inbox/processed/*.md`, `inbox/raw/*.md`  *(note `notes/**` — broadened per §6; `raw/**` deliberately absent)*
- `question.ask: true`
- **NOT `graph.write`** — forbidden for garden `model.invoke` processors (`MODEL_PROCESSORS_EMIT_NO_DURABLE_FACTS`). The agent's durable output is markdown (PatchEffect), which is source-of-truth and rebuild-safe.

---

## 8. Data flow (one ingest)

1. A client drops `inbox/raw/unirpc-notes.md`; the working branch commits it.
2. Adoption reaches the garden phase; `dome.agent.ingest` triggers.
3. `run(ctx)` runs the harness: the model reads `index.md`, searches related entities/concepts, reads the few relevant pages, then issues `writePage`/`patchPage`/`routeTask`/`archiveSource` calls; the harness accumulates edits.
4. On final text (or budget), `run` emits one `PatchEffect(mode:auto, …, SourceRefs=[inbox/raw/unirpc-notes.md])` + any `QuestionEffect`s.
5. The broker checks `patch.auto` coverage + SourceRefs; the patch becomes a **garden Proposal**; adoption re-runs and converges; the result **commits** with `Dome-*` trailers.
6. The **integrity warden** reviews changed `wiki/**` pages on its pass and raises questions for anything unsourced/contradictory — the quality net.
7. If anything is wrong, `git revert` the agent's commit — the rollback net.

---

## 9. Error handling

- **Capability overreach:** a write outside the grant is downgraded to `propose` with a `capability-downgrade-surprise` diagnostic (garden-phase, non-blocking) — never wedges the human's adoption.
- **Budget exhaustion:** hitting `maxSteps`/`maxDailyCostUsd` stops the loop, emits accumulated edits + a truncation diagnostic. No silent half-finish.
- **Model/parse errors:** a malformed step response → `model.output.*` runtime error (existing taxonomy), not `processor.threw`; retryable.
- **No provider / no key:** clean no-op (§5).
- **Source-less patch:** executor rejects model patches lacking a SourceRef (`processor.invalid-output`); the harness always attaches the trigger source, so this is a guardrail.
- **Loop/cascade safety:** consuming the raw file prevents re-trigger; the adoption loop's `max_iterations` bounds any cascade.

---

## 10. Testing strategy (TDD)

The loop is LLM-driven, so we test the framework deterministically by **injecting `step`** with a scripted fake model — no network.

- **Harness loop:** scripted tool-calls then final text → tools execute in order, results feed back, stops on final/budget.
- **Tool bindings:** `readPage` returns snapshot content; write tools mutate the accumulator; the accumulator → exactly one `PatchEffect`, right paths, `mode:auto`, a `SourceRef` per path.
- **Question path:** `askOwner` → `QuestionEffect`.
- **Budget:** `maxSteps` reached → `stopReason:"budget"` + accumulated edits + diagnostic.
- **No-op:** no provider → empty result, no failed run.
- **Capabilities:** manifest declares `read`+`model.invoke`+`patch.auto`+`question.ask` and **not** `graph.write` (pins `MODEL_PROCESSORS_EMIT_NO_DURABLE_FACTS`).
- **Seam (D3):** `ctx.modelInvoke.step` enforces `maxDailyCostUsd` and logs `capability_uses`; step request/response validate against `dome.model-provider.step/v1`.
- **Grant-as-boundary:** a write to a granted `notes/**` path lands; a write outside the grant downgrades.
- **Charter output quality is not unit-tested** (non-deterministic) — validated by manual smoke ingest + the integrity warden.

Red→green→refactor throughout; the injected `step` is the DI seam that keeps the agent testable.

---

## 11. Retiring `dome.intake` + cleanup

**Retire `dome.intake` entirely.** The agent supersedes it; no reason to keep two things doing one job.
- Remove `extract-capture`, `capture-page`, `capture-index`, `synthesize-capture`, `synthesize-rollup`, `low-confidence-answer` (staging pipeline; orphaned output; `askOwner`→`QuestionEffect` replaces low-confidence tracking).
- **`inbox-stale-check`** (warns when the inbox backs up) is still useful → re-home it in `dome.agent`.
- **Migration (work vault):** swap `dome.intake` → `dome.agent` in `.dome/config.yaml` with the §7 grant. Existing `wiki/generated/intake/*` and `wiki/syntheses/intake-*` staging pages are left in place; the owner can prune.

**Cleanup enabled by grant-as-boundary** (scan-grounded — the boundary is *already* mostly grant-based, so this is small):
- Update convention docs to state grant-as-boundary: the work vault's `CLAUDE.md` "Operating Rules" ("`notes/` is user-owned … today's daily is the exception") and `AGENTS.md` — replace the hardcoded relaxation language with "agents write what their grant allows; `raw/` is read-only; Obsidian-Tasks dashboards are left alone."
- Audit processors to confirm **no path-prohibition logic remains beyond the two floors** (§6). The scan found none in `src/`/processors except `isObsidianTasksDashboard` (kept).
- Review `dome.markdown/lint-frontmatter.ts`'s special-casing of "user-owned capture/note roots" — decide whether that leniency still earns its keep once agents write notes; likely simplify. (Confirm during planning; lint policy, not a write boundary.)
- Drop the stale `notes/`-write caveat wording wherever it survives in bundled charters/prompts.

---

## 12. Invariants honored

- `ENGINE_HAS_NO_LLM_OR_MCP_DEPENDENCY` — `ai`/`@ai-sdk/anthropic` live in `.dome/model-provider.ts` + the `dome.agent` bundle; core's `ctx.modelInvoke.step` is provider-neutral; `src/index.ts` static graph unchanged.
- `MODEL_PROCESSORS_EMIT_NO_DURABLE_FACTS` — agents declare `model.invoke`, never `graph.write`; durable output is markdown via `PatchEffect`.
- `MARKDOWN_IS_SOURCE_OF_TRUTH` / `PROJECTIONS_ARE_REBUILDABLE` — agents write committed markdown; not re-run on rebuild (they hold `model.invoke`, excluded from `REBUILD_SAFE_GARDEN_CAPABILITIES`); fine because output is already durable in markdown.
- `EVERY_EFFECT_IS_CAPABILITY_CHECKED` — every model step rides the broker; every patch is capability- and SourceRef-checked. **Grant-as-boundary leans *into* this invariant, not against it.**
- `ENGINE_COMMITS_CARRY_DOME_TRAILERS` — agent commits carry `Dome-Run`, so `lastHumanChangedAt` is unaffected and the human/engine split (the safety story for broad writes) stays queryable.

---

## 13. Open decisions for review

1. **`maxDailyCostUsd` / `maxSteps` defaults** — resolved: `maxDailyCostUsd: 5`, `maxSteps: 25` (adjustable in config later).
2. **`searchVault` implementation** — projection/search read vs snapshot scan (plan-level).
3. **`lint-frontmatter` leniency** (§11) — simplify now or leave.

---

## 14. Out of scope (YAGNI)

Foreground ingest flow; the synthesizer/research/action-items agents (framework supports them; not built now); multi-agent orchestration; streaming/interactive agents; mid-run approval gates; sub-agent spawning; triggers other than `inbox/raw/*`; non-Anthropic providers.
