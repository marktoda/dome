---
type: spec
created: 2026-05-27
updated: 2026-06-12
sources:
  - "[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"
  - "[[v1]]"
---

# Processors

This spec is normative for Dome's behavior-extension surface. A **Processor** is a typed function that reads a vault snapshot and returns effects. Every behavior Dome ships — auto-update-index, auto-cross-reference, intake compilation, daily-note generation, lint, search-indexing — is a Processor.

Processors replace the three-primitives surface of v0.5 (Tools as mutation, Hooks as observers, Workflows as agent loops). The substrate concept is one: snapshot in, effects out.

## The Processor type

```ts
interface Processor<TInput = unknown> {
  readonly id: string;              // canonical identifier; e.g., "dome.markdown.render-index", "acme.calendar.sync"
  readonly version: string;         // semver; participates in projection cache keys
  readonly phase: ProcessorPhase;   // "adoption" | "garden" | "view"
  readonly triggers: Trigger[];     // signal / path / schedule / answer / command
  readonly capabilities: Capability[];  // declared in manifest; enforced at effect-emission time
  readonly inspection?: InspectionScope; // optional stale-projection cleanup scope
  run(ctx: ProcessorContext<TInput>): Promise<Effect[]>;
}

type ProcessorPhase = "adoption" | "garden" | "view";

type InspectionScope =
  | { kind: "changed-paths" }
  | { kind: "all-readable-markdown" };

interface ProcessorContext<TInput = unknown> {
  readonly snapshot: Snapshot;            // immutable tree at the candidate commit
  readonly changedPaths: ReadonlyArray<string>;  // paths changed in base..candidate
  readonly proposal: Proposal | null;     // present for adoption-phase + garden-PatchEffect-derived runs
  readonly runId: string;                 // matches the RunRecord row's id
  readonly input: TInput;                 // trigger-specific payload (e.g., Signal, ClockTick, CommandArgs)
  readonly now: () => Date;               // stable host-clock timestamp for this invocation
  readonly signal: AbortSignal;           // runtime-owned cancellation signal
  readonly capabilities: CapabilityToken; // opaque token; the broker resolves on effect emission
  readonly extensionConfig: ExtensionConfig; // opaque config from extensions.<id>.config
  readonly modelInvoke?: ModelInvokeFn;   // present iff non-adoption run has effective `model.invoke`; supports text + structured JSON
  readonly projection?: ProjectionQueryView; // present iff the runtime wired one (view-phase contexts require it; garden contexts receive a scoped read-only view; adoption never does)
  readonly operational?: OperationalQueryView; // present iff the processor has operational read grants
  readonly pageTypes?: PageTypeRegistry; // default + bundle page-type declarations; vault-local schemas stay in ctx.snapshot
  readonly sourceRef(path: string, range?: TextRange, stableId?: string): SourceRef;  // helper for SourceRef construction
}

interface Snapshot {
  readonly commit: CommitOid;
  readonly tree: TreeOid;
  readFile(path: string): Promise<string | null>;
  listMarkdownFiles(): Promise<ReadonlyArray<string>>;
  getFileInfo(path: string): Promise<SnapshotFileInfo | null>;
}

interface SnapshotFileInfo {
  readonly lastChangedCommit: CommitOid;
  readonly lastChangedAt: string; // ISO timestamp from the git commit that last changed the path
}

// The read surface view-phase and garden-phase processors consume to query
// the projection store. Adoption-phase processors read from `ctx.snapshot`
// (markdown content at the candidate commit) and the field stays undefined —
// the fixed-point loop must not depend on derived state. View-phase
// processors require the field — they answer queries by joining facts,
// diagnostics, and committed markdown content. Garden-phase processors
// receive the same scoped read-only view when the runtime has an open
// projection (e.g. `dome.agent.brief` reads the open-question batch); garden
// runs over adopted state, so reading adopted-state projections is safe.
interface ProjectionQueryView {
  facts(filter?: {
    predicate?: string;
    subjectKind?: "page" | "task" | "entity";
    subjectId?: string;
  }): ReadonlyArray<FactEffect>;
  diagnostics(filter?: {
    severity?: "info" | "warning" | "error" | "block";
    processorId?: string;
  }): ReadonlyArray<DiagnosticEffect>;
  questions(filter?: { resolved?: boolean }): ReadonlyArray<ProjectionQuestion>;
  searchDocuments(filter: {
    query: string;
    category?: string;
    type?: string;
    limit?: number;
  }): ReadonlyArray<SearchDocumentResult>;
  documentsByPath(paths: ReadonlyArray<string>): ReadonlyArray<SearchDocumentResult>;
}

type ProjectionQuestion = QuestionEffect & {
  readonly id: number;              // durable projection row id for `dome resolve`
  readonly processorId: string;
  readonly adoptedCommit: CommitOid;
  readonly askedAt: string;
  readonly answeredAt: string | null;
  readonly answer: string | null;
};

// ProjectionQuestion includes optional QuestionEffect.metadata, so view
// processors can distinguish agent/model-safe resolution work from
// owner-needed decisions without reading SQLite directly.
```

A `Processor` returns `Effect[]`. It does not call writers, git, sqlite, or any other mutation surface. Commit-bound content and git-derived path metadata are exposed only through `ctx.snapshot`, and the runtime scopes both by the processor's effective `read` grant. Per-extension config is exposed as an opaque frozen map on `ctx.extensionConfig`; the capability-policy loader validates only that `extensions.<id>.config` is a YAML mapping, and each extension owns its own schema. Config participates in the projection cache key because it may change emitted facts, patches, and views. The engine routes the returned effects through capability enforcement, then applies them. This is the structural fence behind [[wiki/invariants/EFFECTS_ARE_THE_ONLY_PROCESSOR_OUTPUT]].

## The three phases

### Adoption phase — bounded, deterministic, merge-blocking

Adoption-phase processors run **inside** the fixed-point loop. They:

- See a candidate snapshot (the proposed merge tree).
- Return effects that may patch the candidate (PatchEffect with `mode: "auto"`) or block the merge (DiagnosticEffect with `severity: "block"`).
- Must be deterministic — the same snapshot + input must return the same effects. The loop's convergence depends on this.
- Must be bounded in cost — adoption-phase processors run on every Proposal, so latency adds directly to the adoption loop wall clock.
- Must not call LLMs. The `modelInvoke` capability is never granted to adoption-phase processors. Adoption is the deterministic merge gate; LLM calls live in the garden phase.

Examples: markdown-syntax validation, wikilink-target resolution, stable-id insertion, generated-region checksum maintenance, schema validation.

### Garden phase — async, possibly LLM-backed, may emit Proposals

Garden-phase processors run **after** adoption. They:

- See the just-adopted snapshot (the new trusted state).
- May call LLMs if granted `model.invoke`.
- May emit any effect kind, including `PatchEffect` — which the engine routes back through adoption as a garden-emitted Proposal (per [[wiki/specs/proposals]] §"Garden-emitted Proposals").
- May be slow; the engine schedules them asynchronously.
- May fail; the run ledger records the failure; adopted state is unaffected.

Examples: capture-to-wiki compilation (LLM), entity cross-referencing, daily-brief generation, embedding refresh, calendar-event extraction.

### View phase — read-only, renders answers from adopted state

View-phase processors run **on demand** when a query, CLI render, or UI request triggers them. They:

- See the adopted snapshot.
- Read from the projection store ([[wiki/specs/projection-store]]) for indexed facts.
- Return `ViewEffect` (the rendered output) or no effects.
- Never mutate adopted state — `PatchEffect`, `FactEffect`,
  `SearchDocumentEffect`, `QuestionEffect`, `JobEffect`, and
  external/operational recovery effects from a view-phase processor are
  rejected by the broker as phase mismatches. Non-blocking
  `DiagnosticEffect`s are allowed for view/report findings; block-severity
  diagnostics are rejected because views have no merge gate.

Examples: `dome query`, agenda-for-person render, weekly-rollup view, semantic search response.

## Triggers and signals

A processor declares one or more triggers. The runtime fires the processor when any of its triggers match.

```ts
type Trigger =
  | { kind: "signal";   name: string;  pathPattern?: string }
  | { kind: "path";     pattern: string }
  | { kind: "schedule"; cron: string }
  | { kind: "command";  name: string };

type Signal =
  | "file.created"             // path created in candidate that didn't exist in base
  | "file.modified"            // path changed in candidate vs base
  | "file.deleted"             // path existed in base but not candidate
  | "document.changed"         // any of the above for a markdown file
  | "frontmatter.changed"      // frontmatter delta in a markdown file
  | "region.changed"           // marker-delimited region delta
  | "link.added" | "link.removed";  // wikilink added/removed
```

Signals are synthesized by the engine from `compileRange(base, candidate)` ([[wiki/specs/adoption]] §"Compile range"). The engine never asks a processor "what signals fire" — it computes them once per Proposal and routes them to all subscribers.

### Phase × trigger matrix

The full mapping is at [[wiki/matrices/processor-phase-x-trigger]]. Summary:

- **Adoption-phase processors** subscribe to `signal:*`, `path:*`. Not `schedule:*`, `answer:*`, or `command:*` — adoption is per-Proposal, not periodic, answer-mediated, or user-invoked.
- **Garden-phase processors** subscribe to `signal:*`, `path:*`, `schedule:*`, and `answer:*`. Answer triggers may bind to the processor that originally asked the question, so privileged answer handlers cannot be invoked by a forged idempotency-key prefix from another bundle.
- **View-phase processors** subscribe to `command:*`. Views never react
  directly to vault-write signals, schedules, or answer events. Periodic work
  belongs in garden so its effects have a durable route.

## Capabilities

A processor declares its triggers, capabilities, and optional execution policy in its bundle's `manifest.yaml` ([[wiki/specs/capabilities]] §"Manifest schema"). The loader binds that manifest-reviewed metadata onto the loaded processor; the runtime resolves the grant against the vault's `config.yaml` policy; the broker enforces at effect-emission time.

Adoption-phase processors get a restricted capability set by default — no `model.invoke`, no network, narrow `patch.auto` paths. Garden-phase processors may be granted `model.invoke`, broader `patch.propose`, and operational recovery reads. View-phase processors are read-only at the effect boundary: they may render `ViewEffect` values, and any source refs they return must be covered by effective `read` grants. See [[wiki/specs/capabilities]] §"Capability tiers" for the full set.

## Idempotency

Every processor must be idempotent: running it twice on the same `(snapshot, input)` must produce equivalent effects. The engine deduplicates by `(processorId, processorVersion, snapshotCommit, triggerHash)` in the run ledger and may short-circuit a re-run when a cached run record matches.

Non-idempotent processors are a design defect, not a runtime exception. The engine treats them as if they were idempotent; non-determinism produces undefined behavior in the fixed-point loop. See [[wiki/gotchas/processor-idempotency]].

## Execution semantics

Every invocation is wrapped by the runtime contract in [[wiki/specs/processor-execution]]: one RunRecord, a bounded phase-specific timeout, schema validation for returned effects, typed model-invoke failures, and explicit retry/quarantine behavior for garden runs. Processor authors mark a known transient processor failure by throwing `transientProcessorError(message)`; arbitrary thrown shapes are not trusted. This page defines what a processor is allowed to declare and return; the execution spec defines how the engine calls it and records the outcome.

## Registration

Processors register via the extension-bundle mechanism (per [[wiki/specs/sdk-surface]] §"Extension bundles"). A bundle's `manifest.yaml` owns static metadata: id, version, phase, triggers, capabilities, execution policy, inspection scope, and module path. A bundle's `processors/` directory contains TypeScript files exporting implementation objects with a `run(ctx)` function. The loader binds manifest metadata onto each implementation at `openVault` time.

```ts
// assets/extensions/dome.agent/processors/ingest.ts
import { defineProcessorImplementation } from "@dome/sdk";
import type { Effect } from "@dome/sdk";

export default defineProcessorImplementation({
  async run(ctx): Promise<Effect[]> {
    // read the raw capture file from ctx.snapshot
    // run the agent loop via ctx.modelInvoke.step (tool-calling step)
    // return one PatchEffect (all edits) + any QuestionEffects
  },
});
```

`defineProcessorImplementation` is a type-narrowing identity function. Adding a new processor is one implementation file in the bundle's `processors/` directory plus a row in the bundle's `manifest.yaml` `processors:` block. Legacy modules that export a full `Processor` are still accepted, but new bundle code should not duplicate manifest metadata.

## Maintenance loops

Loops declare in two homes and compose at runtime: bundle-scoped loops in
the bundle's `manifest.yaml` `loops:` block (required processors must be the
bundle's own; settlement checks are always the standard five), and
cross-bundle composition loops in the core registry
(`src/extensions/maintenance-loops.ts`). Status/check read the composed set
from the runtime — a vault-local or third-party bundle's loop appears
automatically. See [[wiki/specs/sdk-surface]] §"Adding a maintenance loop".

A **maintenance loop** is the V1 automation design unit above processors. It is
metadata, not a new executable primitive:

```txt
Processor = executable compiler pass
Loop      = desired-state objective maintained by processors
```

The runtime still dispatches processors by phase and trigger. A loop groups one
or more processors under a goal, evidence set, surfaces, settlement rule, and
known risks so status surfaces can explain what background maintenance is
trying to keep true.

Processors default to `inspection: { kind: "changed-paths" }`: projection
cleanup resolves stale diagnostics, questions, and page facts only for the
readable changed paths the processor was asked to inspect. A processor that
actually walks the whole readable markdown set may declare
`inspection: { kind: "all-readable-markdown" }` in its manifest. The runtime
then leaves `ctx.changedPaths` as the real readable delta, but reports every
readable markdown path as `RunnerResult.inspectedPaths` so stale projection
rows anchored in unchanged source files can resolve. This is required for
whole-vault validators such as `dome.markdown.validate-wikilinks`: creating a
new target page can make an old broken link resolve even though the source note
did not change.

The V1 first-party loop registry lives in
`src/extensions/maintenance-loops.ts`. It intentionally does not call
processors, sequence processors, or add a workflow engine. It references
existing processor ids and command surfaces, and tests validate that those
references stay in lockstep with the shipped bundles. The registry validator
also rejects malformed loop ids, empty required metadata, duplicate processor
references, invalid path patterns, unsupported projection/status names, and
stale command surfaces.

Required loop metadata:

- `id` — stable namespaced identifier.
- `goal` — the desired condition in plain language.
- `evidence` — paths, projections, or operational rows the loop reads.
- `processors` — required processor ids that implement the loop.
- `optionalProcessors` — optional processor ids from opt-in bundles that can
  contribute evidence or answers without making the loop partial when disabled.
- `questionScope` — optional question attribution scope. Defaults to
  `processors`; the cross-cutting question-continuity loop uses `all` so every
  open question remains visible there even when it was emitted by another
  loop's processor.
- `surfaces` — markdown paths, CLI/view commands, projections, or status
  surfaces the loop feeds.
- `settlement` — stable identity and no-op rule.
- `risks` — known failure modes, especially LLM churn or destructive edits.

The shipped V1 loops are:

- `dome.capture.digest`
- `dome.open-loop.continuity`
- `dome.link-concept.coherence`
- `dome.context.packet`
- `dome.question.continuity`

Future third-party loops may move this metadata into bundle manifests. That
change must preserve the same boundary: loops describe maintenance objectives;
processors execute.

Adding a first-party loop follows [[wiki/specs/sdk-surface]] §"Adding a
maintenance loop": implement the processors, add one registry row, cover it in
`tests/extensions/maintenance-loops.test.ts`, update the specs, and avoid adding
a new CLI command unless a command-triggered view surface is actually needed.

## First-party processors (the `dome.*` bundles)

Every behavior Dome ships out of the box is a first-party extension bundle under `assets/extensions/dome.*`. The current set:

| Bundle | Phase × processors | What it does |
|---|---|---|
| `dome.markdown` | adoption: validate-wikilinks, normalize-frontmatter, lint-frontmatter, page-status, lint-supersession, broken-images, duplicate-detection, stale-dates, raw-immutable; garden: ambiguous-wikilink-answer, repair-wikilinks, simplify-indexes, render-index, duplicate-detection-answer, refresh-updated; view: orphan-pages | Keeps markdown pages well-formed; normalizes frontmatter and refreshes managed `updated:` dates during adoption; schedules source-preserving refreshes for stale adopted-state `updated:` drift; emits DiagnosticEffect on ambiguous broken curated-page wikilinks, informational broken note-draft and imported-source body wikilinks, missing local image embeds, informational optional-root unknown page types, informational remaining stale adopted `updated:` dates, frontmatter issues, and raw-file mutations; handles common Obsidian link forms such as heading fragments, self-heading links, unique title-to-slug matches, pathful aliases that uniquely resolve by basename, high-confidence typo repairs during adoption, scheduled high-confidence repairs and canonical target rewrites for historical broken or aliased links, source-backed stub creation for explicit missing `wiki/concepts/...` / `wiki/entities/...` links with no plausible existing target, and small generated child-page blocks in existing wiki indexes; treats wikilink validation as a full-readable-markdown inspection so new target pages can resolve stale broken-link diagnostics in unchanged source notes; asks agent-safe questions when a broken managed wikilink has multiple plausible existing repair targets and patches the chosen target when that question is answered; asks about high-confidence duplicate canonical content pages and records answered merge decisions as source-preserving duplicate review syntheses; emits rebuildable `dome.page.status` / `dome.page.superseded_by` / `dome.page.description` facts from managed-page frontmatter (the description fact backs the index render); nudges wiki pages missing a one-line `description:` with the info `dome.markdown.missing-description` lint; compiles `index.md` and per-category shards as generated renders from `description:` frontmatter via `render-index` (cron `15 5 * * *` + wiki create/delete signals; `index: false` opt-out; explicit empty `index_categories: {}` disables; per NO_ACCRETING_REGISTRIES); warns when a superseded page lacks a resolvable forward link and surfaces informational link-to-superseded hints (with the forward target) outside `## Superseded` history sections; provides the orphan-pages view. |
| `dome.graph` | adoption: links, tag-index | Emits page facts for wikilinks and tags under the `dome.graph` namespace. |
| `dome.health` | garden: recovery question emitters and answer handlers | Surfaces and recovers failed outbox rows, quarantines, and orphaned runs through metadata-annotated QuestionEffect answers. |
| `dome.daily` | adoption: task-index; garden: create-daily, carry-forward; view: hidden compatibility daily views | Creates daily notes in the V1 work-surface shape, seeds and refreshes a small source-backed `## Start Here` context block from yesterday's daily note, seeds and refreshes a filtered `## Open Loops` block from source-backed loops, targets scheduled/current daily surfaces rather than changed historical daily notes, ranks daily-note source loops by the configured daily date instead of the file's maintenance commit timestamp, folds repeated and near-duplicate open-loop rows in rendered daily surfaces while retaining representative source refs, renders compact evidence labels that show both daily surface rows and backing source locations, preserves settled generated rows as `### Resolved Today` (`[x]`) or `### Dismissed Today` (`[-]`) evidence so completed or dismissed source-backed loops stop resurfacing, indexes user-authored task/followup facts while ignoring Dome-generated daily blocks, frontmatter metadata, and blockquoted evidence, treats open generated source-backed rows as the target day's daily surface in compatibility daily views while deduping them against backing facts, gives each extracted open loop a stable semantic SourceRef id so line moves do not create a new open-loop identity, asks agent-safe ambiguous-followup questions, and keeps deterministic daily action/planning views available for tests/debugging while `query` / `export-context` remain the recommended foreground-agent surfaces. The daily surface defaults to `wiki/dailies/{date}.md` and can be moved with `extensions.dome.daily.config.daily_path` such as `notes/{date}.md`. |
| `dome.agent` | garden: ingest, inbox-stale-check, consolidate, sweep, sweep-answer, brief, preference-signals, preference-promotion, preference-promotion-answer, active-projects | Runs autonomous-agent processors via a tool-use loop backed by `ctx.modelInvoke.step`; `dome.agent.ingest` handles `inbox/raw/*.md` — reads the raw source, creates/updates wiki pages (source, entities, concepts), wires bidirectional wikilinks, sets the `description:` frontmatter the index renders from, routes action-items to daily or entity surfaces, and archives the raw file — all as one `PatchEffect` (+ `QuestionEffect`s) with a single capability grant as the write boundary; `dome.agent.inbox-stale-check` emits `inbox.stale` warnings for files lingering under active inbox buckets past the 168-hour threshold; `dome.agent.consolidate` is the nightly recent-drift janitor, `dome.agent.sweep` (+ its deterministic `sweep-answer` handler) the nightly meaning integrator ([[wiki/specs/sweep]]), and `dome.agent.brief` the morning-brief composer. The bundle's deterministic processors — the three preference processors (`preference-signals` counter facts, `preference-promotion` owner-needed questions, `preference-promotion-answer` — gated `core.md` writer owning the promoted-preferences block) per [[wiki/specs/preferences]], plus `active-projects` (the other gated `core.md` writer, owning the active-projects block) — round out the bundle. See [[wiki/specs/autonomous-agents]]. |
| `dome.lint` | view: report | Adopted-state lint report over diagnostics and deterministic checks; future apply behavior remains planned. |
| `dome.search` | adoption: index-text; view: query, export-context | Maintains the FTS5 projection; answers adopted-state query and context-packet requests by ranking expanded FTS candidates with source-backed page-type, graph, open-loop, decision, question, and diagnostic signals. Both query surfaces also recall exact-path documents whose projection memory has topic-matched open loops, decisions, questions, or diagnostics even when the page text itself misses FTS; daily-intent topics additionally recall date-named daily surfaces from the adopted snapshot. `export-context` renders the richer handoff packet with read-first overviews, recall signals, topic-relevant open loops, decisions, questions, diagnostics, source-backed match detail, and daily-surface open-loop overview rows for daily-intent packets, preserving both daily line refs and backing source refs for generated rows. |

The full shipped/planned map is at [[wiki/matrices/built-in-extensions-x-phase]].

The bundles ship in the SDK at `assets/extensions/dome.*/`. `dome init` does not copy first-party bundle code into the vault; it writes activations and grants in `<vault>/.dome/config.yaml`, and the runtime resolves shipped bundles from the SDK package. Users disable a first-party bundle with `enabled: false` in `<vault>/.dome/config.yaml`; `<vault>/.dome/extensions/` is reserved for vault-local third-party bundles or overrides.

## What a processor cannot do

- **Mutate state directly.** No filesystem writes, no git calls, no SQLite writes. The engine is the only applier. Pinned by [[wiki/invariants/ENGINE_IS_THE_ONLY_APPLIER]].
- **Emit effects beyond its declared capabilities.** Every effect passes through `enforceCapability(effect, processor.capabilities)` at the engine boundary. Pinned by [[wiki/invariants/EVERY_EFFECT_IS_CAPABILITY_CHECKED]].
- **Run outside its declared phase.** An adoption-phase processor cannot be triggered by a `schedule:` cron; a view-phase processor cannot be triggered by cron or emit a `PatchEffect`. Phase × trigger compatibility is enforced at registration time, and phase × effect compatibility is re-checked at effect-emission time.
- **Call other processors directly.** Processors emit effects; the engine may dispatch follow-on processors based on effects, but a processor cannot synchronously invoke another. This is what keeps the snapshot-in-effects-out boundary clean.

## Run ledger

Every processor invocation, regardless of outcome, writes one `RunRecord` row to the run ledger ([[wiki/specs/run-ledger]]). The record captures `runId`, `processorId`, `processorVersion`, `phase`, `proposalId?`, `inputCommit`, `outputCommit?` (for adoption-phase processors that contributed to a closure commit), `status` (queued / running / succeeded / failed / skipped / timed_out / cancelled), `effectHashes`, `capabilityUses`, `cost?`, `error?`, `startedAt`, `finishedAt?`. Pinned by [[wiki/invariants/EVERY_PROCESSOR_RUN_IS_LEDGERED]].

## Implementation status

The three-phase model is now implemented enough to support the automation-first
plan in [[v1]]. Current status:

| Phase | What ships | Status |
|---|---|---|
| Adoption-phase runner | `adoptionRunner` (`src/processors/runtime.ts`) fires adoption-phase processors inside the fixed-point loop | **Shipped** (Phase 3) |
| Garden-phase runner | `gardenRunner` fires post-adoption garden-phase processors against signal + path triggers; the engine constructs sub-Proposals from garden-emitted PatchEffects with a depth cap (`garden.cascade-cap` diagnostic on hit) | **Shipped** (Phases 4a + 4a') |
| View-phase runner | `viewRunner` (`src/processors/runtime.ts`) + `runViewCommand` dispatcher (`src/engine/core/commands.ts`) — command-driven view processors fire; non-View effect emissions are phase-rejected | **Shipped** (Phase 4b) |
| Scheduler | `schedule:` triggers fire on cron from `dome serve` and `dome sync` via the `projection.db.schedule_cursors` table; minimal in-tree cron evaluator (`src/engine/operational/cron.ts`); clock injection via `runOneAdoption({ now })` for deterministic harness testing. Same-tick ordering contract: all due processors are evaluated before any is dispatched, then dispatched in cron-time order — each fire's computed due time, processor id as the tiebreak; a brand-new processor (no cursor, no ledger history) became due "now" and sorts after every missed cron — so a wake-tick burst replays the overnight choreography in order, never registry order ([[wiki/specs/daily-surface]] §"Wake-tick choreography") | **Shipped** (Phase 4c) |
| Answer-trigger dispatch | `dome resolve` / `dome answer` records a QuestionEffect answer, then garden-phase processors with matching `answer` triggers run through normal effect routing. Recovery handlers bind triggers to the originating question processor as well as idempotency-key prefixes. | **Shipped** |
| Engine signal pub/sub | `signal: "engine.<name>"` namespace (terminal-failure, processor-quarantined, etc.) | Phase 4d |
| JobEffect runtime | `scheduled_jobs` table + `runQueuedJobs` dispatcher firing due jobs as garden-phase work with retry/backoff | **Shipped** (Phase 4e) |

The reset V1 plan now treats this substrate as shipped foundation and moves
future work toward more useful automation, agent-resolvable decisions, and
semantic garden processors.

## Related

- [[wiki/specs/effects]] — what processors return
- [[wiki/specs/processor-execution]] — how processor invocations run, fail, retry, and drain
- [[wiki/specs/adoption]] — when adoption-phase processors run
- [[wiki/specs/capabilities]] — what limits a processor's effect reach
- [[wiki/specs/projection-store]] — what view-phase processors read
- [[wiki/specs/run-ledger]] — RunRecord shape
- [[wiki/matrices/processor-phase-x-trigger]] — phase × trigger compatibility
- [[wiki/matrices/built-in-extensions-x-phase]] — the `dome.*` bundle map
- [[wiki/gotchas/processor-fixed-point-divergence]] — when adoption-phase processors fail to converge
- [[wiki/gotchas/processor-idempotency]] — failure mode of non-idempotent processors
- [[wiki/gotchas/processor-version-drift]] — projection cache invalidation on version change
