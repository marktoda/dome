---
type: spec
created: 2026-06-08
updated: 2026-06-09
sources:
  - "[[superpowers/specs/2026-06-08-autonomous-agents-ingest-design]]"
  - "[[wedge]]"
  - "[[wiki/specs/processors]]"
  - "[[wiki/specs/capabilities]]"
---

# Autonomous agents

This spec is normative for Dome's autonomous-agent capability — the framework, the `ctx.modelInvoke.step` seam, and the shipped agents (`dome.agent.ingest`, `dome.agent.consolidate`, `dome.agent.brief`). It introduces no new core primitive: an **agent is a processor too** — the same observation that "a warden is a processor" (see [[wiki/specs/task-lifecycle]] §"Wardens") now applies to processors that drive a full tool-use loop.

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
| `listPages()` | read (all readable markdown paths) |
| `readPage(path)` | read |
| `searchVault(query)` | read (content substring match) |
| `writePage(path, content)` | write (accumulate create/replace) |
| `appendToPage(path, content)` | write (accumulate append; used for `log.md` and task lines on the daily / an entity's `## Open threads`) |
| `archiveSource(rawPath)` | write (accumulate move `inbox/raw/x` → `inbox/processed/x` + delete the raw) |
| `askOwner(question)` | question (`QuestionEffect`) |

Task-routing has no dedicated tool: the agent reads the target (daily note or entity page) and `appendToPage`s a `#task` line, guided by the charter. Targeted in-place edits likewise go through read-then-`writePage`. (`patchPage` / `routeTask` were considered and dropped — `writePage` + `appendToPage` cover the cases without a diff-apply tool.)

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

1. **Top-level `raw/` immutability.** `wiki/sources/` pages cite `[[raw/...]]` as provenance; rewriting raw destroys "what was actually ingested." The **top-level `raw/`** tree is not grantable write territory — the broker hard-denies it independent of any grant (per [[wiki/invariants/RAW_IS_IMMUTABLE]]). This is a distinct namespace from the **`inbox/raw/`** drop-zone, which the agent *does* consume under its grant (read, then archive-to-`inbox/processed/` + delete). `inbox/raw/*.md` in the `patch.auto` grant is therefore consistent with this floor.
2. **`isObsidianTasksDashboard` skip.** Files with a fenced ` ```tasks ` query block are Obsidian Tasks plugin dashboards; injecting `^anchor` breaks the plugin. The exclusion lives in processor logic because positive-glob grants cannot subtract one path.

Everything else is grant-defined: `templates/`, `notes/`, historical files — writable if and only if granted.

## Re-homed: `dome.agent.inbox-stale-check`

The stale-inbox diagnostic processor (`inbox.stale` warning after 168 h) was previously `dome.intake.inbox-stale-check`. It is re-homed in `dome.agent` as `dome.agent.inbox-stale-check`. Behavior and trigger are unchanged. See [[wiki/invariants/INBOX_IS_EPHEMERAL]].

## `dome.agent.consolidate` — the second agent

The consolidator is the **contractive counterweight** to ingest: a nightly vault-janitor that keeps the knowledge graph from sprawling. It is a second `AgentDefinition` on the same framework — no new primitive.

- **Trigger:** `schedule` only (`0 2 * * *`, nightly — promoted from the original weekly `0 4 * * 1` cadence by the [[wedge]] phase-4 sleep-time-compute loop). It runs **one agent loop per tick** (no per-source iteration). There is intentionally **no `command` trigger** — command triggers are view-phase/read-only, and the consolidator is a writing garden processor; on-demand garden invocation is future work.
- **Charter scope: recent drift, not whole-vault sweeps.** Nightly cadence multiplies the janitor's blast radius, so the charter bounds each run to what drifted since the ledger's last recorded run: recently-touched pages (via `log.md` and the ledger's last-run date) plus newly ingested captures. The original weekly coverage-cursor crawl over the whole vault is retired; a run that finds no recent drift converges as a no-op.
- **Scope (contractive):** (1) merge duplicate / near-duplicate pages into one canonical page (hard-delete the absorbed page + rewrite every inbound `[[wikilink]]`), and (2) tidy within-page append-drift into one coherent page. It does **not** reorganize, split, or re-home content.
- **Posture:** auto-merge + commit, with one guardrail — merges are **lossless for source-grounded facts** (fuse, never drop), and a **genuinely ambiguous** merge raises a `QuestionEffect` (`askOwner`) instead of guessing. Confident cases are automatic; only the rare ambiguous one asks.
- **Navigation, not whole-vault reads:** the agent's "map" is the vault's own `index.md` (catalog) + `log.md` (history); it `searchVault`s for suspects and `readPage`s only the finalist cluster. There is no bespoke candidate-finder — judgment is the agent's, the tools are general primitives (`readPage`, `listPages`, `searchVault`, `writePage`, the new `deletePage`, `askOwner`).
- **Cross-run memory:** a ledger file (default top-level `consolidation-ledger.md`, sibling of `log.md`, outside `wiki/`) records each run's date (the recency cutoff for the next run), merges done, and pairs judged *not* duplicates (so they're never re-litigated). The path is configurable via `extensions.dome.agent.config.consolidation_ledger_path` (a relative vault `.md` path; default `consolidation-ledger.md`). A custom path requires matching `read` + `patch.auto` grant entries in `.dome/config.yaml` — grants are static globs, so the processor cannot widen its own write boundary by config.
- **Per-run caps (hard):** `maxSteps: 50`, `maxDailyCostUsd: 10`, and a hard patch cap of **30 changed files per run** enforced in processor code — a run whose accumulated edits exceed the cap is rolled back entirely (questions survive; a `dome.agent.consolidate-overreach` warning diagnostic is emitted). A single cumulative `PatchEffect` per run.
- **Atomic per run:** a mid-run throw can leave a half-done merge (page deleted before its inbound links were rewritten), so the consolidator drops all partial edits on throw and emits only a `dome.agent.consolidate-failed` diagnostic. Budget truncation is not a throw — its partial work is intended and lands with a truncation diagnostic.
- **Grant:** `read` + `patch.auto` over `wiki/**/*.md`, `index.md`, `log.md`, `consolidation-ledger.md`; `model.invoke`; `question.ask`. **Not `graph.write`.**

## `dome.agent.brief` — the third agent (morning brief)

The brief composer is the [[wedge]] phase-4 push surface: sleep-time compute aimed at the one perfectly predictable query. It composes the morning brief **into today's daily note as small generated blocks** — never a separate document (extends [[v1]] decision 1 and wedge decision 3).

- **Phase / kind:** garden, `kind: llm`. **Trigger:** `schedule` only (`30 5 * * *`).
- **Ordering with `dome.daily`:** the brief fires at 05:30; `dome.daily.create-daily` fires at 06:00. The brief does not depend on the daily existing — when today's note is absent it creates the same skeleton through `dome.daily`'s shared `renderDailySkeleton` + start-context helpers, so `create-daily` later finds the file and no-ops. The brief's adopted patch emits `file.created`/`document.changed` signals, which trigger `dome.daily.carry-forward` to raise the **ranked open-loops surface** — the brief deliberately does not re-derive open-loop ranking; that block stays owned by carry-forward.
- **Block ownership is disjoint:** `dome.daily` owns its marker blocks (`dome.daily:start-context`, `dome.daily:open-loops`, `dome.daily:carried-forward`); the brief owns three `dome.agent.brief:*` marker blocks. No two processors write the same region.

**The three brief blocks** (plain `-` bullets only — never `- [ ]` checkboxes, which the task extractors would re-ingest as new tasks):

| Block | Placement | Content | Writer |
|---|---|---|---|
| `dome.agent.brief:yesterday` | under `## Start Here` | outcomes, decisions, unfinished threads from yesterday's daily + recently adopted pages; every bullet cites `(from [[path]])` | model (spliced) |
| `dome.agent.brief:meetings` | under `## Meetings` | one bullet per meeting from `sources/calendar/<today>.md` (time — title) with a one-line context digest from vault recall (people, projects, prior decisions), citing the calendar file and the recalled pages | model (spliced) |
| `dome.agent.brief:questions` | under `## Start Here`, after the yesterday block | the open Dome questions batch from `ctx.projection.questions({ resolved: false })`, rendered with durable row ids and `dome resolve <id> <value>` hints | processor (deterministic — the model never writes question ids) |

- **Grounding rule (hard, enforced in code):** after the loop, the processor splices **only the model-filled brief blocks** back into the deterministic pre-run content — model writes outside the markers (or to any file other than the daily note) never land (out-of-scope edits are dropped with a `dome.agent.brief-out-of-scope` warning). Inside the spliced blocks, any bullet carrying no `[[wikilink]]` source ref is stripped and re-emitted as a `QuestionEffect` (backtick code spans are stripped before the check — a backticked `` `[[x]]` `` does not ground a bullet). **Anything the model cannot ground becomes a question, not brief text.**
- **Marker-injection guard (hard, enforced in code):** Dome's HTML comments are exclusively generated block markers, so the splice drops every model-body line matching `<!-- dome.* -->`. Without this, a body could smuggle a second copy of another block's marker pair (the deterministic pass replaces only the first occurrence, so the smuggled copy — e.g. a fabricated `dome.agent.brief:questions` block with fake `dome resolve` hints — would land verbatim) or inject `dome.daily:*` markers and corrupt carry-forward. Calendar files are untrusted input flowing into the model, so this is a live prompt-injection path, not a theoretical one.
- **Calendar degradation:** when `sources/calendar/<today>.md` is absent, the meetings block is omitted entirely — no empty section, no hallucinated agenda. The calendar file is **untrusted input**: the processor parses it defensively (shape per [[wiki/specs/vault-layout]] §"`sources/` — committed external feeds") and hands the parsed meeting list to the model as data, never as instructions.
- **Output shape:** ONE `PatchEffect(mode:"auto")` writing the daily note, plus `QuestionEffect`s (from `askOwner` and from ungrounded-bullet strips), plus a truncation diagnostic on budget exhaustion. **Atomic per run:** a mid-run throw drops all edits — including the skeleton, which `create-daily` recreates at 06:00 — and emits only a `dome.agent.brief-failed` diagnostic.
- **Tool surface:** the ingest read tools plus the daily-note write — `readPage`, `listPages`, `searchVault`, `writePage`, `appendToPage`, `askOwner`. No `deletePage`, no `archiveSource`.
- **Garden projection read:** the brief reads open questions through `ctx.projection`. The processor runtime threads the scoped read-only projection query view into **garden** contexts as well as view contexts (adoption stays snapshot-only for fixed-point determinism); see [[wiki/specs/processors]].
- **Daily path:** resolved from `extensions.dome.agent.config.daily_path` with the same template rules as `dome.daily` (default `wiki/dailies/{date}.md`). A vault overriding `dome.daily`'s `daily_path` must mirror the key in `dome.agent`'s config.
- **Grant:** `read` over `wiki/**/*.md`, `notes/**/*.md`, `index.md`, `log.md`, `sources/calendar/*.md`; `patch.auto` over `wiki/dailies/*.md` + `notes/*.md` only (the daily-path targets — the brief's write blast radius is deliberately narrower than ingest's); `model.invoke` `{ maxDailyCostUsd: 5 }` · harness `budget.maxSteps: 25`; `question.ask`. **Not `graph.write`.**

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
- [[wiki/specs/vault-layout]] §"`sources/` — committed external feeds" — the calendar source-file shape the brief parses
- [[wedge]] — phase 4: nightly consolidation + morning brief as the flagship push surface
