---
type: spec
created: 2026-06-08
updated: 2026-06-12
sources:
  - "[[superpowers/specs/2026-06-08-autonomous-agents-ingest-design]]"
  - "[[wedge]]"
  - "[[wiki/specs/processors]]"
  - "[[wiki/specs/capabilities]]"
description: "Agent-as-processor framework: the ctx.modelInvoke.step tool-loop seam, shipped ingest/consolidate/brief/sweep agents, grant-as-boundary writes"
---

# Autonomous agents

This spec is normative for Dome's autonomous-agent capability — the framework, the `ctx.modelInvoke.step` seam, and the shipped agents (`dome.agent.ingest`, `dome.agent.consolidate`, `dome.agent.brief`, `dome.agent.sweep` with its answer handler `dome.agent.sweep-answer`). It introduces no new core primitive: an **agent is a processor too** — the same observation that "a warden is a processor" (see [[wiki/specs/task-lifecycle]] §"Wardens") now applies to processors that drive a full tool-use loop.

The `dome.agent` bundle also ships four **deterministic** (non-LLM) processors: three for the preference lifecycle — `preference-signals` (counter facts), `preference-promotion` (promotion questions for candidates AND demotion questions for promoted rules whose confidence has decayed below the floor), and `preference-promotion-answer` (the gated writer handling promote/reject and demote/keep) — normative at [[wiki/specs/preferences]], plus `dome.agent.active-projects`, the core-memory renderer specced at §"`dome.agent.active-projects`" below. They share the bundle because they configure or maintain agent context (the promoted block and the active-projects block ride every agent run via core-memory injection), but they are ordinary deterministic processors, not agents.

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

**The step prefix is cacheable — and caching lives provider-side.** Every loop step resends the full conversation with a constant charter (system) and tool set, so the step envelope's stable prefix is ideal prompt-cache material. The caching contract belongs entirely to the provider template ([[wiki/specs/sdk-surface]] §"Model provider scaffold and probe"): the shipped Anthropic provider marks the charter block and the last tool entry with `cache_control` breakpoints and folds the cache pricing tiers into the `costUsd` it reports. The step envelope schema is byte-unchanged and the engine has no caching knobs — a provider that doesn't cache keeps working, and cache-discounted costs flow through the same `costUsd` → budget-scope path as uncached ones.

## Per-processor model routing (`model_overrides`)

The step envelope has always carried an optional provider-neutral `model` field; routing gives vault config a way to set it per agent. `extensions.dome.agent.config.model_overrides` maps the four routable agent keys — `ingest`, `consolidate`, `brief`, `sweep` — to model strings, and the shared resolver (`lib/model-override.ts`, the `consolidate_targets` degrade-not-crash idiom) injects the resolved model into every `step()` call. Unset → no `model` field, i.e. the provider's default model. A malformed map or entry never crashes a nightly run: the processor falls back to the default and emits one `dome.agent.model-config-invalid` warning diagnostic.

Routing cannot bypass the model allowlist: the engine still intersects the declared and granted `modelAllowlist` before every provider call ([[wiki/specs/capabilities]] §"model.invoke"). The shipped `dome.agent` manifest declares no allowlist, so an override flows through; a vault grant that does declare one denies an out-of-list override at call time. Nothing engine-side changed for routing.

Routing ships **unset** — per-model output quality is the owner's call (the deployment runbook recommends haiku-class for the mechanical ingest/sweep loops and the provider default for consolidate/brief). One operational note: the provider's prompt cache is per-model, so switching a processor's model mid-day starts that loop's next run with a cold cache prefix.

## The loop harness and `AgentDefinition`

The bundle library at `assets/extensions/dome.agent/lib/agent-loop.ts` provides the shared harness. Each agent is declared as an `AgentDefinition`:

```ts
type AgentDefinition = {
  id: string;                       // e.g. "dome.agent.ingest"
  charter: string;                  // system-prompt text — the agent's instructions
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
- **Charter:** the Ingest workflow: read the raw source → create a `wiki/sources/<slug>` summary page → create or update entity/concept pages with bidirectional `[[wikilinks]]` → set a one-line `description:` in each new page's frontmatter (the index is generated from it — the charter says "never edit index files") → route action-items into today's daily `## Captured today` block or an entity's `## Open threads` → archive the raw file. The charter is prompt text, not code-with-privilege (concretely: a string exported from a bundle TS module, `lib/ingest-charter.ts` — data fed to the model, carrying no capability of its own). The agent's **final message is the run's activity record**: the charter instructs one tight closing line (what landed where), and the harness appends its flattened 200-char excerpt to the static patch reason, so it rides the engine commit body per [[wiki/specs/adoption]] §"Engine commit trailers" — there is no `log.md` append ([[wiki/invariants/NO_ACCRETING_REGISTRIES]]).

**Tool surface:**

| Tool | Kind |
|---|---|
| `listPages()` | read (all readable markdown paths) |
| `readPage(path)` | read |
| `searchVault(query)` | read (content substring match) |
| `writePage(path, content)` | write (accumulate create/replace) |
| `appendToPage(path, content)` | write (accumulate append; used for task lines on the daily / an entity's `## Open threads` — daily appends ride the captured-tasks seam) |
| `archiveSource(rawPath)` | write (accumulate move `inbox/raw/x` → `inbox/processed/x` + delete the raw) |
| `askOwner(question)` | question (`QuestionEffect`) |

Task-routing has no dedicated tool: the agent `appendToPage`s a `#task` line, guided by the charter. For **today's daily**, the append rides the captured-tasks seam ([[wiki/specs/daily-surface]] §"The ingest tool seam"): the tool validates the content is task-shaped lines and splices them inside the `dome.daily:captured` block itself — the model supplies lines, never placement — and rejects anything else as a self-correctable tool error (`writePage` on today's daily is admitted only when it amounts to the same in-block append). Entity-page appends remain plain. Targeted in-place edits elsewhere go through read-then-`writePage`. (`patchPage` / `routeTask` were considered and dropped — `writePage` + `appendToPage` cover the cases without a diff-apply tool.)

**Default capability grant (`.dome/config.yaml`):**

- `read`: `wiki/**/*.md`, `notes/**/*.md`, `inbox/**/*.md`, `index.md`, `log.md`, `core.md`, `preferences/signals.md`
- `model.invoke`: `{ maxDailyCostUsd: 5 }` · harness `budget.maxSteps: 25` — the declared cap bounds ingest's OWN daily spend; the extension-wide pool is the vault grant's job ([[wiki/specs/capabilities]] §"model.invoke"), so this no longer needs to clear sweep+consolidate's nightly burn
- `patch.auto`: `wiki/**/*.md`, `notes/**/*.md`, `inbox/processed/*.md`, `inbox/raw/*.md`, `preferences/signals.md`  (`raw/**` is deliberately absent — see §"Grant-as-boundary"; `index.md` and `log.md` are deliberately absent too, the same read-only grant shape as `core.md`: the index is a generated render of `description:` frontmatter and `log.md` is frozen history per [[wiki/invariants/NO_ACCRETING_REGISTRIES]])
- `question.ask: true`
- **NOT `graph.write`** — required by `MODEL_PROCESSORS_EMIT_NO_DURABLE_FACTS`

**Tool-time denial backs the grant.** The broker verdict is per-PatchEffect
and all-or-nothing, so a stray `writePage("index.md", …)` late in a run would
poison the whole batched patch. The grant-aware tools therefore mirror the
`patch.auto` grant in a bundle-local constant (`INGEST_WRITABLE_PATHS` /
`CONSOLIDATE_WRITABLE_PATHS`, pinned to the manifest by the manifest-sync
test) and reject `index.md` / `log.md` / out-of-grant paths at tool time —
a self-correctable tool error mid-loop instead of a dead run.

The agent's durable output is markdown written via `PatchEffect` — source-of-truth and rebuild-safe.

**Output shape:** one `PatchEffect(mode:"auto")` carrying all edits, plus `QuestionEffect`s for `askOwner` calls. On budget exhaustion the harness emits accumulated edits and a truncation `DiagnosticEffect` so the run is never silently half-finished.

**No silent no-ops.** A source loop that ends `final` without archiving its
`inbox/raw/` file emits a `dome.agent.source-unarchived` warning carrying the
model's final text (truncated to 300 chars) — the only evidence of what the
model decided. Without it, a model that answers its first step with plain text
and no tool calls produces a run that records "succeeded" while the capture
silently stays in `inbox/raw` (observed 2026-06-10). Per-source failures keep
the existing `dome.agent.source-failed` warning; both honor
[[wiki/invariants/INBOX_IS_EPHEMERAL]] ("captures either move out or surface a
recoverable diagnostic").

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
- **Charter scope: recent drift, not whole-vault sweeps.** Nightly cadence multiplies the janitor's blast radius, so the charter bounds each run to what drifted since the ledger's last recorded run: recently-touched pages (every wiki page stamps `created:`/`updated:` frontmatter dates, so `searchVault` for each `updated: YYYY-MM-DD` since the ledger's last-run cutoff lists them — `log.md` is frozen history and never a freshness signal) plus newly ingested captures. The original weekly coverage-cursor crawl over the whole vault is retired; a run that finds no recent drift converges as a no-op.
- **Scope (contractive):** (1) merge duplicate / near-duplicate pages into one canonical page (retire the absorbed page with the supersession status flip — `status: superseded` + `superseded_by: "[[<canonical>]]"` per [[wiki/specs/page-schema]] §"Supersession (ADR pattern)" — and rewrite every inbound `[[wikilink]]`), (2) tidy within-page append-drift into one coherent page, and (3) retire outdated pages with the same status flip (`## Superseded` section-move for mixed pages). It does **not** reorganize, split, or re-home content, and it does not delete or rewrite superseded prose — `deletePage` is reserved for pages that should never have existed (empty stubs, accidental files).
- **Posture:** auto-merge + commit, with one guardrail — merges are **lossless for source-grounded facts** (fuse, never drop), and a **genuinely ambiguous** merge raises a `QuestionEffect` (`askOwner`) instead of guessing. Confident cases are automatic; only the rare ambiguous one asks.
- **Navigation, not whole-vault reads:** the agent's "map" is the vault's own `index.md` (the generated catalog — one line per page from `description:` frontmatter) plus `updated:` frontmatter recency searches; it `searchVault`s for suspects and `readPage`s only the finalist cluster. There is no bespoke candidate-finder — judgment is the agent's, the tools are general primitives (`readPage`, `listPages`, `searchVault`, `writePage`, `deletePage`, `askOwner`, `flagIntegrity`).
- **Integrity review (folded in from the retired `dome.warden.integrity`):** while consolidating, the agent also judges pages for the four knowledge-integrity finding kinds (historical-as-ongoing / contradiction / self-corroborating / inference-as-fact) and emits each through the `flagIntegrity` tool, which deterministically produces an `info`/`warning` `DiagnosticEffect` (never a fact, never a patch) with code `dome.agent.integrity.<kind>` and a per-finding `stableId`. The two noisiest classes are suppressed unless a same-page contradiction backs them, and low-confidence findings are skipped. Findings self-clear via `resolveStaleDiagnostics` when the page is reconciled — the questions-as-decisions contract, riding consolidate's nightly cadence and budget rather than a per-change warden. The mechanical subset (same-page same-key claim collision) is caught deterministically in `dome.claims.index` (code `dome.claims.key-collision`), not here. See [[wiki/specs/task-lifecycle]] §"Wardens".
- **Cross-run memory:** a ledger file (default `meta/consolidation-ledger.md`, outside `wiki/` — generated bookkeeping per [[wiki/specs/vault-layout]] §"`meta/`") records each run's date (the recency cutoff for the next run), merges done, and pairs judged *not* duplicates (so they're never re-litigated). The path is configurable via `extensions.dome.agent.config.consolidation_ledger_path` (a relative vault `.md` path; default `meta/consolidation-ledger.md`). A malformed value (non-string, non-`.md`, absolute, or path-escaping) does not crash the nightly run: the processor falls back to the default path and emits a `dome.agent.consolidate-config-invalid` warning diagnostic. A custom path requires matching `read` + `patch.auto` grant entries in `.dome/config.yaml` — grants are static globs, so the processor cannot widen its own write boundary by config.
- **Scope targets (`consolidate_targets`):** `extensions.dome.agent.config.consolidate_targets` narrows which path prefixes the run treats as in-scope for hunting, merging, tidying, and superseding — an exact mirror of sweep's `sweep_targets` rule ([[wiki/specs/sweep]] §"Config keys"). Default `["wiki/"]` (the whole wiki). The value must be a non-empty array of relative path prefixes, and every prefix must sit **inside the consolidator's `patch.auto` write grant** — the processor probes each prefix against the grant-aware tools' `CONSOLIDATE_WRITABLE_PATHS` mirror, because a target outside the grant would have `writePage` rejecting every merge under it mid-run. A malformed or grant-escaping value degrades to the default with a `dome.agent.consolidate-config-invalid` warning (the shared config-fallback temperament; the diagnostic code is shared with the ledger-path check). The resolved targets land in the charter as a standing scope rule: everything outside the prefixes is read-only context for the night.
- **Per-run caps (hard):** `maxSteps: 50`, `maxDailyCostUsd: 10`, and a hard patch cap of **30 changed files per run** enforced in processor code — a run whose accumulated edits exceed the cap is rolled back entirely (questions survive; a `dome.agent.consolidate-overreach` warning diagnostic is emitted). A single cumulative `PatchEffect` per run.
- **Atomic per run:** a mid-run throw can leave a half-done merge (a page flipped to superseded before its inbound links were rewritten), so the consolidator drops all partial edits on throw and emits only a `dome.agent.consolidate-failed` diagnostic. Budget truncation is not a throw — its partial work is intended and lands with a truncation diagnostic.
- **No silent no-ops:** a run that ends `final` with zero edits and zero questions emits a `dome.agent.consolidate-no-op` **info** diagnostic carrying the model's final text (300-char excerpt) — a quiet night is legitimate (info never raises attention), but the model's "nothing to do" reasoning is preserved instead of discarded. Same blind-spot fix as ingest's `dome.agent.source-unarchived`.
- **Grant:** `read` over `wiki/**/*.md`, `index.md`, `log.md`, `meta/consolidation-ledger.md`, `preferences/signals.md`, `core.md`; `patch.auto` over `wiki/**/*.md`, `meta/consolidation-ledger.md`, `preferences/signals.md` only — `index.md` and `log.md` are read-only (the `core.md` grant shape, per [[wiki/invariants/NO_ACCRETING_REGISTRIES]]; the grant-aware tools also deny them at tool time, see §"`dome.agent.ingest`"); `model.invoke`; `question.ask`. **Not `graph.write`.**

## `dome.agent.brief` — the third agent (morning brief)

The brief composer is the [[wedge]] phase-4 push surface: sleep-time compute aimed at the one perfectly predictable query. It composes the morning brief **into today's daily note as small generated blocks** — never a separate document (extends [[v1]] decision 1 and wedge decision 3).

- **Phase / kind:** garden, `kind: llm`. **Triggers:** `schedule` (`30 5 * * *`) plus `file.created` signals on `sources/calendar/*.md` and `sources/slack/*.md` — the wake-tick late-source knock, gated deterministically (see "The compose-record gate" below). The 05:30 cron path is unchanged by the gate.
- **Ordering with `dome.daily`:** `dome.daily.compose-blocks` fires at 05:25, owning the four deterministic blocks (questions, agenda, integrated, sources — normative at [[wiki/specs/daily-surface]] §"Block ownership"); the brief fires at 05:30 and owns only the three narrative blocks below; `dome.daily.create-daily` fires at 06:00. The brief does not depend on the daily existing — when today's note is absent it creates the same skeleton through `dome.daily`'s shared `renderDailySkeleton` + yesterday-fallback helpers, so `create-daily` (and compose-blocks) later find the file and no-op. The brief's adopted patch emits `file.created`/`document.changed` signals, which trigger `dome.daily.carry-forward` to raise the **ranked open-loops surface** — the brief deliberately does not re-derive open-loop ranking; that block stays owned by carry-forward. The full overnight choreography (02:00 consolidate → 03:00 sweep → calendar → 05:20 active-projects → 05:25 compose-blocks → 05:30 brief → 06:00 create-daily/carry-forward) and the edition's degradation ladder are normative at [[wiki/specs/daily-surface]].
- **Block ownership is disjoint, with one named exception:** `dome.daily` owns its marker blocks, including the four deterministic blocks `dome.daily.compose-blocks` writes; the brief owns its `dome.agent.brief:*` marker blocks — now exactly three narrative blocks plus the compose-record. The exception is `dome.agent.brief:yesterday` — the ONE yesterday surface (D2): `create-daily`/`carry-forward` seed its mechanical fallback body when (and only when) the block is absent, and the brief replaces the body wholesale. The dual-writer safety argument, fallback body shape, and the `dome.daily:start-context` retirement/migration are normative at [[wiki/specs/daily-surface]] §"The one yesterday block"; the cross-bundle block-ownership and section-contract tables (every block, writer, reader, timing, status) at [[wiki/specs/daily-surface]] §"Block ownership".

**The brief's charter slims to three model blocks** — `today`, `yesterday`, `meetings` (prep prose) — plus the deterministic compose-record. The questions/integrated/sources blocks left the brief's charter for `dome.daily.compose-blocks` ([[wiki/specs/daily-surface]] §"Block ownership"); the brief no longer renders them and no longer reads any garden projection (§"No garden projection read" below).

**The brief blocks** (plain `-` bullets only — never `- [ ]` checkboxes, which the task extractors would re-ingest as new tasks):

| Block | Placement | Content | Writer |
|---|---|---|---|
| `dome.agent.brief:today` | under `## Start Here`, top | model-written forward narrative for today — a grounded paragraph oriented toward now (current focus, intent, today's constraints), distinct from the yesterday digest. Omitted entirely when the model is unavailable (no fallback prose) | model (spliced) |
| `dome.agent.brief:yesterday` | under `## Start Here`, below `today` | outcomes, decisions, unfinished threads from yesterday's daily + recently adopted pages; every bullet cites `(from [[path]])`. Replaces the deterministic fallback body seeded by the pre-pass / `dome.daily` | model (spliced), over a deterministic fallback (dual-writer — daily-surface §"The one yesterday block") |
| `dome.agent.brief:meetings` | under `## Meetings`, below the deterministic `dome.daily:agenda` block | prep-context prose only — people, prior decisions, open threads relevant to today's meetings, from vault recall, citing the calendar file and the recalled pages. Must NOT restate the agenda list itself — `dome.daily:agenda` already rendered time · title · attendees above it | model (spliced) |
| `dome.agent.brief:compose-record` | under `## Start Here`, rendered last | the fingerprint-gate record: one italic line recording short content-hashes of the material inputs at last successful compose — `_Composed <n>× HH:MM · calendar@<hash8\|—> · slack@<hash8\|—> · ledger@<hash8\|—> · yesterday@<hash8\|—>_` (`<n>` = today's model-compose count so far, capped at 3; each `<hash8>` an 8-char content hash of that input, `—` when the input is absent; the full grammar appears verbatim below the table). Written by every **successful** compose; the failure-stub path never writes it | processor (deterministic — never model-written) |

The compose-record line grammar, verbatim (`<hash8|—>` = an 8-char content hash of that input, or `—` when the input is absent):

```
_Composed <n>× HH:MM · calendar@<hash8|—> · slack@<hash8|—> · ledger@<hash8|—> · yesterday@<hash8|—>_
```

- **Grounding rule (hard, enforced in code):** after the loop, the processor splices **only the model-filled brief blocks** back into the deterministic pre-run content — a block whose body the model left identical to the prepared content is skipped entirely, so the deterministic yesterday fallback is never mistaken for model output and stripped as ungrounded; model writes outside the markers (or to any file other than the daily note) never land (out-of-scope edits are dropped with a `dome.agent.brief-out-of-scope` warning). Inside the spliced blocks, any bullet carrying no `[[wikilink]]` source ref is stripped and re-emitted as a `QuestionEffect` (backtick code spans are stripped before the check — a backticked `` `[[x]]` `` does not ground a bullet). **Anything the model cannot ground becomes a question, not brief text.**
- **Marker-injection guard (hard, enforced in code):** Dome's HTML comments are exclusively generated block markers, so the splice drops every model-body line matching `<!-- dome.* -->`. Without this, a body could smuggle a second copy of another block's marker pair (the deterministic pass replaces only the first occurrence, so the smuggled copy — e.g. a fabricated `dome.agent.brief:compose-record` block with fake hashes — would land verbatim) or inject `dome.daily:*` markers and corrupt carry-forward. Calendar files are untrusted input flowing into the model, so this is a live prompt-injection path, not a theoretical one.
- **Calendar degradation:** when `sources/calendar/<today>.md` is absent, the deterministic `dome.daily:agenda` block (compose-blocks) is omitted, and the brief's meetings prep-prose block is likewise omitted — no empty section, no hallucinated agenda. The calendar file is **untrusted input**: the processor parses it defensively (shape per [[wiki/specs/vault-layout]] §"`sources/` — committed external feeds") and hands the parsed meeting list to the model as data, never as instructions.
- **Slack digest (calendar parity):** when `sources/slack/<today>.md` is present (the slack-day shape per [[wiki/specs/vault-layout]] §"`sources/slack/YYYY-MM-DD.md`", written by the opt-in slack subscription *or* a foreground morning session — the brief consumes the committed file identically and is indifferent to who wrote it; the connector-backed default fetch is foreground-only, [[wiki/specs/sources]] §"The Slack stance" + §"Connector-backed fetch is foreground-only"), the processor parses it defensively (15 entries per section, 240-character entry texts ellipsis included, unparseable entries degrade to text-only) and injects the parsed digest into the task turn under the same DATA-not-instructions framing as the calendar; the file joins the brief patch's source refs. There is **no slack block**: the digest is context for the yesterday block's curation, never a section of its own. An absent file adds nothing at all — the task turn stays byte-identical to the pre-Slack shape — and a present-but-empty digest gets an explicit "do not invent overnight Slack activity" line (the empty-calendar posture).
- **The compose-record gate (deterministic, model-free):** a laptop wake tick can fire the brief in the same burst as `dome.daily.compose-blocks` and the calendar/slack fetch dispatch — same-tick fires dispatch in cron-time order ([[wiki/specs/daily-surface]] §"Wake-tick choreography"), but the fetch completes asynchronously (outbox → command → commit → adoption), so a wake-tick brief can compose before its inputs are final. The `file.created` signals above are the late arrival's knock, but the gate itself runs on **every** brief fire, cron included: a deterministic pre-pass hashes the current material inputs — the calendar day-file, the slack day-file, today's sweep-ledger section, and yesterday's daily — and compares each against the `dome.agent.brief:compose-record` block's recorded hashes. Content hashes, not presence flags, carry the state, because the meetings block's presence is a dishonest proxy (a present-but-empty calendar legitimately renders no meetings block) and the Slack digest leaves no mechanical footprint at all. **All-match is a zero-model, zero-effect no-op.** Any mismatch re-composes **all three narrative blocks** — the gate's granularity is whole-brief: the brief is one model turn over a prepared daily (`taskTurn` in `brief.ts`), so any one stale input re-runs the full compose, never a partial patch — and the compose then rewrites the compose-record with the fresh hashes and an incremented compose count. **Re-composes are capped at 3 model composes per day**; beyond the cap the narrative freezes for the day (the deterministic blocks keep updating live from compose-blocks' own 05:25 pipeline regardless) and an info diagnostic fires. No daily or no parseable compose-record means the brief has not successfully composed today (the 05:30 cron or a manual `dome run` owns the first compose, and a failed brief's recovery stays with its acknowledgeable question — signals never auto-retry a failure).
- **Output shape:** ONE `PatchEffect(mode:"auto")` writing the daily note, plus `QuestionEffect`s (from `askOwner` and from ungrounded-bullet strips), plus a truncation diagnostic on budget exhaustion.
- **Failure contract (roll-back-atomic, recover deterministically):** a mid-run throw means unknown partial state, so ALL of the model's edits roll back and nothing from the agent loop carries over. Recovery is effects-only and fully deterministic:
  1. A `dome.agent.brief-failed` **warning diagnostic** records the failure (`run rolled back, no edits applied`).
  2. A **fallback `PatchEffect`** splices a failure stub into the brief's own `dome.agent.brief:yesterday` block of the pre-run prepared content (the existing daily, or the freshly re-seeded skeleton when today's note was absent — so the day still starts with a complete deterministic daily rather than waiting for `create-daily` at 06:00). The stub names the flattened error (whitespace-collapsed, capped at 120 chars), links yesterday's note, and gives the retry command (`dome run dome.agent.brief`). Because the prepared content is deterministic, a same-day re-failure REPLACES the stub via the marker splice instead of appending a second copy; when the stub content equals the existing daily byte-for-byte, no patch is emitted. **Re-compose exception:** the "has the brief successfully composed today" check reads the `dome.agent.brief:compose-record` block (written only on success) instead of the old sources record — when today's daily already carries a successful compose, the failure is a failed RE-compose — typically the late-source signal path — and NO fallback patch is emitted at all: the stub must not clobber the good today/yesterday/meetings bodies the morning compose landed (and a stub riding alongside them would misreport the morning as failed). The warning diagnostic and the brief-failed question carry the failure on their own.
  3. An **acknowledgeable `QuestionEffect`** — idempotency key `dome.agent.brief-failed:<date>`, options `["retried", "skip-today"]`, `automationPolicy: "agent-safe"`, `recommendedAnswer: "retried"`. There is deliberately **no answer handler**: resolving the question IS the durable acknowledgment — `retried` records that someone re-ran the brief, `skip-today` records that the day was let go; nothing fires on either answer.
- **Tool surface:** the ingest read tools plus the daily-note write — `readPage`, `listPages`, `searchVault`, `writePage`, `appendToPage`, `askOwner`. No `deletePage`, no `archiveSource`.
- **No garden projection read:** the brief reads **no** garden projection at all. The open-questions batch left the brief's charter for `dome.daily.compose-blocks`, which reads open questions via the separate `questions.read` operational capability ([[wiki/specs/capabilities]] §"`questions.read`"), and the former stale-loops attention-discount context retired with the attention-discount track (see below). The brief composes purely from files it reads through `ctx.snapshot` — today/yesterday dailies, calendar, slack, sweep ledger — keeping garden reads free of facts (no garden-writes-facts → garden-reads-facts loop). The brief's grant is deliberately **not `graph.write`** and no longer needs a projection query view.
- **Stale-loops context (retired):** the brief no longer derives or injects an attention-discount stale-loops list into the task turn — that deterministic pre-run context (a `dome.attention.discount` fact read via `ctx.projection.facts`) retired with the attention-discount track, and the charter carries no stale-loops compression rule. Stale-task surfacing lives elsewhere now (`dome.daily.stale-task-warden`, [[wiki/specs/task-lifecycle]] §"Staleness"); the brief's yesterday block is model-curated from the files above, not from a discount-ranked list.
- **Daily path:** resolved from `extensions.dome.agent.config.daily_path` with the same template rules as `dome.daily` (default `wiki/dailies/{date}.md`). A vault overriding `dome.daily`'s `daily_path` must mirror the key in `dome.agent`'s config — `dome doctor` raises a `config.daily-path-mismatch` warning finding when both bundles are enabled and the two keys diverge (overriding only one yields a wrong-path brief plus a duplicate skeleton at 06:00).
- **Grant:** `read` over `wiki/**/*.md`, `notes/**/*.md`, `inbox/**/*.md`, `index.md`, `log.md`, `meta/consolidation-ledger.md`, `meta/sweep-ledger.md`, `sources/calendar/*.md`, `sources/slack/*.md`, `core.md`, `preferences/signals.md`; `patch.auto` over `wiki/dailies/*.md` + `notes/*.md` + `preferences/signals.md` only (the daily-path targets plus the signals append — the brief's write blast radius is deliberately narrower than ingest's); `model.invoke` `{ maxDailyCostUsd: 5 }` · harness `budget.maxSteps: 25`; `question.ask`. **Not `graph.write`.** The read grant must cover every path other `dome.agent` processors cite in their questions' `sourceRefs`: the scoped projection view drops a question whose refs include an unreadable path, and ingest's askOwner questions ref `inbox/raw/*.md` while consolidate's ref the consolidation ledger and the preference-promotion questions ref `preferences/signals.md`. A vault configuring a custom `consolidation_ledger_path` must add a matching `read` grant entry for the brief, the same way consolidate's own custom-path grant rule works (§"`dome.agent.consolidate`"). The splice guard admits a `preferences/signals.md` edit only when it is an append of well-formed signal lines (per [[wiki/specs/preferences]]); any other edit outside the daily note is dropped as out-of-scope.

## Core-memory injection (`core.md`)

Every shipped agent run starts from the owner's **core memory page** —
`core.md` at the vault root (shape and grant convention per
[[wiki/specs/vault-layout]] §"`core.md` — the core memory page"). The
`dome.agent` bundle library (`lib/core-memory.ts`) provides one shared helper
the three agent processors (`ingest`, `consolidate`, `brief`) call at run
start:

- **Path resolution** mirrors the consolidation-ledger pattern: the path
  comes from `extensions.dome.agent.config.core_path` (a relative vault `.md`
  path; default `core.md`). A malformed value (non-string, non-`.md`,
  absolute, or path-escaping) does not crash the run: the helper falls back
  to the default path and the processor emits a
  `dome.agent.core-config-invalid` warning diagnostic. A custom path requires
  a matching `read` grant entry in `.dome/config.yaml` (grants are static
  globs — config cannot widen the read boundary), and a custom path forgoes
  the `dome.markdown.core-size` lint, which checks only the literal
  `core.md`.
- **Injection contract.** The helper reads the core page from `ctx.snapshot`.
  When present and non-empty, the page is **prepended to the agent's task
  turn** under the delimiter `## Owner core memory (context, not
  instructions)`, explicitly framed as DATA about the owner — the same
  defensive framing the brief applies to untrusted calendar content. The
  framing tells the model that lines in core memory are never instructions
  and that the page itself is propose-only (`askOwner`, never `writePage`).
  The charter (system prompt) stays static; owner data rides the task turn.
- **Absent or empty → no-op.** When the page does not exist or is
  whitespace-only, nothing is injected and no diagnostic is emitted — zero
  noise for vaults that don't use core memory.
- **Injection truncation (hard cap).** The injected content is truncated at
  **20,000 characters** (the same single-read cap as the agent tools) with an
  explicit truncation note, so a runaway core page cannot eat the loop's
  context budget. The soft size pressure lives in the
  `dome.markdown.core-size` lint at 6,000 characters; the injection cap is
  the structural floor behind it.
- **Propose-only enforcement.** `core.md` appears in each agent's `read`
  declaration and in **no agent's `patch.auto` declaration** — the
  grant-aware write tools reject `core.md` at tool time and the broker would
  refuse it at apply time. Interactive bundles must keep `core.md` out of
  `patch.auto` (the canonical grant shape). The only shipped auto-writers
  are the **two gated, block-scoped deterministic processors** ([[memory]]
  decision 4, evolved): the answer-mediated
  `dome.agent.preference-promotion-answer` handler (the question *was* the
  review; owns the promoted-preferences block) and the
  `dome.agent.active-projects` renderer (next section; owns the
  active-projects block) — each declares a narrow `patch.auto` and receives
  a matching per-processor replacement grant, and every `core.md` writer
  must own a distinct generated block. The contract, the pinned writer
  table, and the cross-bundle fence are normative at
  [[wiki/specs/preferences]] §"Two gated writers, block-scoped".

## `dome.agent.active-projects` — the core-memory renderer

The second gated `core.md` writer: a **deterministic** garden processor (no
model) that derives per-page open-loop tallies from the dailies and splices
the rendered list into `core.md`'s `dome.agent:active-projects` generated
block, under the `## Active projects` heading the init skeleton scaffolds.
The point: unresolved work stays visible in the always-loaded core page —
the 05:30 brief's core-memory injection reads fresh project tallies, not
just the daily surface.

- **Triggers:** cron `20 5 * * *` — after the 05:15 index render, before the
  05:30 brief. It is schedule-only by design: active-projects is a morning
  core-memory snapshot for agent context, not a live dashboard on every
  daily-note edit.
- **Grant:** `read` over exactly `core.md` + `wiki/dailies/*.md`;
  `patch.auto` over exactly `core.md` (manifest declaration + the
  per-processor replacement grant in the shipped vault config — the
  two-gated-writers shape).
- **Collection semantics** (reuses `dome.daily`'s source-backed open-loop
  machinery — the same `open-loop-surface` parser carry-forward writes the
  daily surface with, a cross-bundle lib import per the established
  brief → `renderDailySkeleton` precedent):
  - Each daily's `dome.daily:open-loops` block yields source-backed items
    (`- [ ] body (from [[page]])`); the loop's **source page is the project
    candidate**. Dailies themselves are never project pages.
  - Loops dedupe across dailies by their stable identity and by normalized
    body (the same dual-key dedupe carry-forward applies). A loop settled
    (`[x]`/`[-]`) in **any** daily stops counting — today's checked-off copy
    settles yesterday's surfaced one.
  - Per page: distinct open-loop count + `lastTouched` (the newest
    contributing daily's date).
- **Render:** one `- [[<page>]] — <n> open loop(s), last touched <date>`
  line per project, sorted by `(openLoops desc, lastTouched desc, page
  asc)`, **capped at 5**; the empty tally renders a fixed empty-state line,
  never an absent block.
- **Posture:** diff-before-emit (byte-identical `core.md` → zero effects);
  marker anomalies on its own block → info diagnostics and NO patch (the
  render-index refuse-and-surface posture — a damaged block needs a human);
  **absent `core.md` → clean no-op** — the page is owner-scaffolded by
  `dome init` / seeded via `dome recipe core-seed` and never recreated by a
  cron tick (recreating a deleted owner page nightly would be a patch-fight
  with the owner). A malformed `core_path` config degrades to the default
  with the shared `dome.agent.core-config-invalid` warning.

## Preference signals (charter convention)

Each agent charter carries **one standing instruction** for the promotion
mechanism ([[wiki/specs/preferences]]): when the owner's content explicitly
corrects how the agent should behave — filing location, naming, formatting,
scope — append one dated signal line to `preferences/signals.md`
(`- YYYY-MM-DD + <topic>:: <rule> (source: [[...]])`). This is an ordinary
write inside each agent's grant; no new tool, no special effect. The brief's
splice guard validates the append shape (signal lines only); ingest and
consolidate appends land through the normal cumulative PatchEffect. Agents
*write signals*, never the promoted block — promotion stays answer-mediated.

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
- [[wiki/specs/preferences]] — the preference lifecycle: signals, counter facts, promotion questions, owner-mediated demotion of decayed promoted rules; the two-gated-writers contract every `core.md` auto-writer (including `active-projects`) lives under
- [[wiki/specs/sweep]] — the nightly meaning-integration sweep: queue, settlement, dispositions (including the `escalated` terminal record for poison pairs)
- [[wiki/specs/task-lifecycle]] — the warden pattern; wardens and agents are both processors
- [[wiki/specs/daily-surface]] — the daily note as a product surface: section contract, block ownership, choreography, degradation ladder, the `dome.daily.edition` loop
- [[wiki/specs/vault-layout]] §"`sources/` — committed external feeds" — the calendar-day and slack-day source-file shapes the brief parses
- [[wedge]] — phase 4: nightly consolidation + morning brief as the flagship push surface
