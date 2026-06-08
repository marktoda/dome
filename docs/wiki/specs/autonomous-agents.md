---
type: spec
created: 2026-06-08
updated: 2026-06-08
sources:
  - "[[superpowers/specs/2026-06-08-autonomous-agents-ingest-design]]"
  - "[[wiki/specs/processors]]"
  - "[[wiki/specs/capabilities]]"
---

# Autonomous agents

This spec is normative for Dome's autonomous-agent capability — the framework, the `ctx.modelInvoke.step` seam, and the first agent (`dome.agent.ingest`). It introduces no new core primitive: an **agent is a processor too** — the same observation that "a warden is a processor" (see [[wiki/specs/task-lifecycle]] §"Wardens") now applies to processors that drive a full tool-use loop.

## The agent-as-processor model

An **autonomous agent** is a garden-phase `kind: llm` [[wiki/specs/processors|Processor]] whose `run(ctx)` executes a tool-use loop against the vault snapshot and emits the result as a `PatchEffect` (plus optional `QuestionEffect`s). No new primitive — still Vault / Proposal / Processor / Effect. The four-concept core stays sealed.

Like wardens, agents are defined by the shape of their capabilities and execution, not by a special runtime object. The difference from a warden is scope and behavior: a warden emits only `QuestionEffect`s (read + ask); an agent emits a `PatchEffect` backed by multi-step tool calls (read + write + ask). The Processor interface is the same.

## The `ctx.modelInvoke.step` seam (D3)

The existing model boundary is single-shot text (`prompt → text`). D3 adds one capability to it: a **tool-calling step** — `messages + tool-schemas → tool-calls | text`. The provider executes no tools; it only reports the calls, and the processor's loop executes them.

```ts
// names indicative
type ModelStepRequest = {
  schema: "dome.model-provider.step/v1";
  messages: ModelMessage[];           // system/user/assistant/tool roles
  tools: ToolSchema[];
  model?: string;
  signal: AbortSignal;
};
type ModelStepResponse = {
  toolCalls?: { id: string; name: string; input: unknown }[];
  text?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  costUsd?: number;
  model?: string;
};
```

`ctx.modelInvoke.step(req)` enforces the same `model.invoke` machinery as a single-shot call: `maxDailyCostUsd` cap, model allowlist, `capability_uses` logging, shared abort, and response validation.

**Provider-neutral core.** `ctx.modelInvoke.step` is provider-neutral: it serializes the request over the same JSON-over-stdio boundary as today's single-shot call. The vendor SDK (AI SDK's `generateText` with `stopWhen: stepCountIs(1)` and tools declared without `execute`) lives in the vault's `.dome/model-provider.ts` command adapter — never in `src/index.ts`'s static import graph. `ENGINE_HAS_NO_LLM_OR_MCP_DEPENDENCY` is preserved by construction.

The loop itself — the `while` over step results — lives in the bundle harness, not behind the seam. The seam abstracts the hard part (tool-call wire protocol); the trivial `while` stays in bundle code where it can be tested with a scripted fake model.

## The loop harness and `AgentDefinition`

The bundle library at `assets/extensions/dome.agent/lib/agent-loop.ts` provides the shared harness. Each agent is declared as an `AgentDefinition`:

```ts
type AgentDefinition = {
  id: string;                       // e.g. "dome.agent.ingest"
  charter: string;                  // system-prompt file content — the agent's instructions
  trigger: ProcessorTrigger;
  tools: AgentTool[];               // { schema, execute(input, ctx) }
  budget: { maxSteps: number };
};
```

The harness loop contract:

1. Build `messages = [system: charter, user: task]`.
2. Call `step({ messages, tools: schemas, signal })`.
3. On tool calls: execute in order (reads via `ctx.snapshot`; writes accumulate into an `EditAccumulator`; `askOwner` pushes a pending `QuestionEffect`); append assistant + tool-result messages; continue.
4. On final text (no tool calls): stop with `stopReason:"final"`.
5. On `steps >= maxSteps`: stop with `stopReason:"budget"`; keep accumulated edits.

Translation to effects: the `EditAccumulator` (`path → finalContent | delete`) becomes **one `PatchEffect`** (`mode:"auto"`) with a `SourceRef` per touched path pointing at the trigger source. Pending questions become `QuestionEffect`s.

**No-op without a model.** If `ctx.modelInvoke` reports no provider, the harness returns empty — no edits, no error, no failed run. Mirrors the warden no-op.

**Adding a new agent** = writing a new `AgentDefinition` (a charter file + tool bindings), registering it as a garden-phase `kind: llm` processor in the bundle manifest, and granting the capability scope in `.dome/config.yaml`. No framework code changes.

## `dome.agent.ingest` — the first agent

- **Phase / kind:** garden, `kind: llm`.
- **Trigger:** a change touching `inbox/raw/*.md`. Idempotent by consumption — the agent archives the raw file in its patch, so a converged source does not re-fire.
- **Charter:** the Ingest workflow: read the raw source → create a `wiki/sources/<slug>` summary page → create or update entity/concept pages with bidirectional `[[wikilinks]]` → update `index.md` → append `log.md` → route action-items to the daily note or an entity's `## Open threads` → archive the raw file. The charter is data (a bundled `.md` prompt file), not code.

**Tool surface:**

| Tool | Kind |
|---|---|
| `listPages(globOrType?)` | read |
| `readPage(path)` | read |
| `searchVault(query)` | read |
| `writePage(path, content)` | write (accumulate create/replace) |
| `patchPage(path, edit)` | write (accumulate targeted edit) |
| `routeTask({surface, line, link?})` | write (accumulate edit to daily or entity) |
| `archiveSource(rawPath)` | write (accumulate move `inbox/raw/x` → `inbox/processed/x`) |
| `askOwner(question)` | question (`QuestionEffect`) |

**Default capability grant (`.dome/config.yaml`):**

- `read`: `wiki/**/*.md`, `notes/**/*.md`, `inbox/**/*.md`, `index.md`, `log.md`
- `model.invoke`: `{ maxDailyCostUsd: 5 }` · harness `budget.maxSteps: 25`
- `patch.auto`: `wiki/**/*.md`, `notes/**/*.md`, `index.md`, `log.md`, `inbox/processed/*.md`, `inbox/raw/*.md`  (`raw/**` is deliberately absent — see §"Grant-as-boundary")
- `question.ask: true`
- **NOT `graph.write`** — required by `MODEL_PROCESSORS_EMIT_NO_DURABLE_FACTS`

The agent's durable output is markdown written via `PatchEffect` — source-of-truth and rebuild-safe.

**Output shape:** one `PatchEffect(mode:"auto")` carrying all edits, plus `QuestionEffect`s for `askOwner` calls. On budget exhaustion the harness emits accumulated edits and a truncation `DiagnosticEffect` so the run is never silently half-finished.

## Grant-as-boundary + two hard floors

Dome separates two things:

- **Structural invariants — unchanged.** Rebuildability, markdown-is-source-of-truth, model-processors-emit-no-durable-facts, every-effect-is-capability-checked, `Dome-Run` trailer split. None of these say "don't write `notes/`."
- **Path conventions — policy, expressed as grants.** What an agent can write is exactly what its `patch.auto` grant covers. No hardcoded write-prohibitions beyond two structural floors.

**The capability grant is the single write boundary.** Grant-as-boundary leans *into* `EVERY_EFFECT_IS_CAPABILITY_CHECKED`, not against it. The safety in exchange: **git** (with the `Dome-Run` trailer, human/engine history is always queryable) + the **integrity warden** as the quality net. If the agent writes something wrong, `git revert <closure-commit>` is the rollback.

**Two hard floors that are not pure policy:**

1. **`raw/` immutability.** `wiki/sources/` pages cite `[[raw/...]]` as provenance; rewriting raw destroys "what was actually ingested." `raw/**` is not grantable write territory — the broker hard-denies it independent of any grant (per [[wiki/invariants/RAW_IS_IMMUTABLE]]).
2. **`isObsidianTasksDashboard` skip.** Files with a fenced ` ```tasks ` query block are Obsidian Tasks plugin dashboards; injecting `^anchor` breaks the plugin. The exclusion lives in processor logic because positive-glob grants cannot subtract one path.

Everything else is grant-defined: `templates/`, `notes/`, historical files — writable if and only if granted.

## Re-homed: `dome.agent.inbox-stale-check`

The stale-inbox diagnostic processor (`inbox.stale` warning after 168 h) was previously `dome.intake.inbox-stale-check`. It is re-homed in `dome.agent` as `dome.agent.inbox-stale-check`. Behavior and trigger are unchanged. See [[wiki/invariants/INBOX_IS_EPHEMERAL]].

## Related

- [[wiki/invariants/ENGINE_HAS_NO_LLM_OR_MCP_DEPENDENCY]] — vendor SDK in `.dome/model-provider.ts`; `ctx.modelInvoke.step` is provider-neutral
- [[wiki/invariants/MODEL_PROCESSORS_EMIT_NO_DURABLE_FACTS]] — agents declare `model.invoke`, never `graph.write`; durable output is markdown
- [[wiki/invariants/EVERY_EFFECT_IS_CAPABILITY_CHECKED]] — grant-as-boundary is enforced here
- [[wiki/invariants/ENGINE_COMMITS_CARRY_DOME_TRAILERS]] — `Dome-Run` keeps human/agent commit history queryable
- [[wiki/invariants/MARKDOWN_IS_SOURCE_OF_TRUTH]] — agent writes committed markdown; not re-run on rebuild
- [[wiki/invariants/RAW_IS_IMMUTABLE]] — `raw/` never granted writable to agents
- [[wiki/invariants/INBOX_IS_EPHEMERAL]] — stale-check re-homed in `dome.agent`
- [[wiki/specs/processors]] — the Processor type; phases; `kind: llm`
- [[wiki/specs/capabilities]] — `model.invoke`, `patch.auto`, `question.ask`, `graph.write`
- [[wiki/specs/effects]] — `PatchEffect`, `QuestionEffect`, `DiagnosticEffect`
- [[wiki/specs/task-lifecycle]] — the warden pattern; wardens and agents are both processors
