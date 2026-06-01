---
type: spec
created: 2026-05-27
updated: 2026-05-29
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
  readonly id: string;              // canonical identifier; e.g., "dome.index.update", "acme.calendar.sync"
  readonly version: string;         // semver; participates in projection cache keys
  readonly phase: ProcessorPhase;   // "adoption" | "garden" | "view"
  readonly triggers: Trigger[];     // signal / path / schedule / answer / command
  readonly capabilities: Capability[];  // declared in manifest; enforced at effect-emission time
  run(ctx: ProcessorContext<TInput>): Promise<Effect[]>;
}

type ProcessorPhase = "adoption" | "garden" | "view";

interface ProcessorContext<TInput = unknown> {
  readonly snapshot: Snapshot;            // immutable tree at the candidate commit
  readonly changedPaths: ReadonlyArray<string>;  // paths changed in base..candidate
  readonly proposal: Proposal | null;     // present for adoption-phase + garden-PatchEffect-derived runs
  readonly runId: string;                 // matches the RunRecord row's id
  readonly input: TInput;                 // trigger-specific payload (e.g., Signal, ClockTick, CommandArgs)
  readonly capabilities: CapabilityToken; // opaque token; the broker resolves on effect emission
  readonly modelInvoke?: ModelInvokeFn;   // present iff non-adoption run has effective `model.invoke`; supports text + structured JSON
  readonly projection?: ProjectionQueryView; // present iff the runtime wired one (view-phase contexts require it)
  readonly pageTypes?: PageTypeRegistry; // default + bundle page-type declarations; vault-local schemas stay in ctx.snapshot
  readonly sourceRef(path: string, range?: TextRange): SourceRef;  // helper for SourceRef construction
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

// The read surface view-phase processors consume to query the projection store.
// Adoption-phase processors typically read from `ctx.snapshot` (markdown
// content at the candidate commit) and the field stays undefined; view-phase
// processors require the field — they answer queries by joining facts,
// diagnostics, and committed markdown content.
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
  questions(filter?: { resolved?: boolean }): ReadonlyArray<QuestionEffect>;
  searchDocuments(filter: {
    query: string;
    category?: string;
    type?: string;
    limit?: number;
  }): ReadonlyArray<SearchDocumentResult>;
}
```

A `Processor` returns `Effect[]`. It does not call writers, git, sqlite, or any other mutation surface. Commit-bound content and git-derived path metadata are exposed only through `ctx.snapshot`, and the runtime scopes both by the processor's effective `read` grant. The engine routes the returned effects through capability enforcement, then applies them. This is the structural fence behind [[wiki/invariants/EFFECTS_ARE_THE_ONLY_PROCESSOR_OUTPUT]].

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

Processors register via the extension-bundle mechanism (per [[wiki/specs/sdk-surface]] §"Extension bundles"). A bundle's `manifest.yaml` owns static metadata: id, version, phase, triggers, capabilities, execution policy, and module path. A bundle's `processors/` directory contains TypeScript files exporting implementation objects with a `run(ctx)` function. The loader binds manifest metadata onto each implementation at `openVault` time.

```ts
// assets/extensions/dome.intake/processors/extract-capture.ts
import { defineProcessorImplementation } from "@dome/sdk";
import type { Effect } from "@dome/sdk";

export default defineProcessorImplementation({
  async run(ctx): Promise<Effect[]> {
    // read the new capture file from ctx.snapshot
    // call ctx.modelInvoke to compile it to generated capture markdown
    // return a source-ref-backed PatchEffect
  },
});
```

`defineProcessorImplementation` is a type-narrowing identity function. Adding a new processor is one implementation file in the bundle's `processors/` directory plus a row in the bundle's `manifest.yaml` `processors:` block. Legacy modules that export a full `Processor` are still accepted, but new bundle code should not duplicate manifest metadata.

## First-party processors (the `dome.*` bundles)

Every behavior Dome ships out of the box is a first-party extension bundle under `assets/extensions/dome.*`. The current set:

| Bundle | Phase × processors | What it does |
|---|---|---|
| `dome.markdown` | adoption: validate-wikilinks, normalize-frontmatter, lint-frontmatter, broken-images, duplicate-detection, stale-dates, raw-immutable; view: orphan-pages | Keeps markdown pages well-formed; emits DiagnosticEffect on broken wikilinks, missing local image embeds, stale `updated:` dates, frontmatter issues, and raw-file mutations; asks about high-confidence duplicate canonical content pages; provides the orphan-pages view. |
| `dome.graph` | adoption: links, tag-index | Emits page facts for wikilinks and tags under the `dome.graph` namespace. |
| `dome.health` | garden: recovery question emitters and answer handlers | Surfaces and recovers failed outbox rows, quarantines, and orphaned runs through QuestionEffect answers. |
| `dome.daily` | adoption: task-index; garden: create-daily, carry-forward; view: today, prep | Creates daily notes, carries unfinished markdown checkbox tasks forward, indexes source-ref-backed wiki-page task/followup facts, and renders daily action/planning surfaces. |
| `dome.intake` | adoption: capture-index; garden: extract-capture, inbox-stale-check, low-confidence-answer, synthesize-capture, synthesize-rollup | Compiles `inbox/raw/*.md` captures into generated capture pages plus processed archives, writes source-linked synthesis pages and the cross-capture rollup from generated captures, warns on stale inbox files, asks before tracking low-confidence items, applies accepted answers through garden sub-Proposals, and indexes confidence-carrying `dome.intake.*` facts from generated capture metadata. |
| `dome.lint` | view: report | Adopted-state lint report over diagnostics and deterministic checks; future apply behavior remains planned. |
| `dome.search` | adoption: index-text; view: query, export-context | Maintains the FTS5 projection; answers adopted-state query and context-packet requests. |

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

The v1 engine completion sequence (see [[cohesive/brainstorms/2026-05-27-v1-engine-completion]]) lands the three-phase model in stages:

| Phase | What ships | Status |
|---|---|---|
| Adoption-phase runner | `adoptionRunner` (`src/processors/runtime.ts`) fires adoption-phase processors inside the fixed-point loop | **Shipped** (Phase 3) |
| Garden-phase runner | `gardenRunner` fires post-adoption garden-phase processors against signal + path triggers; the engine constructs sub-Proposals from garden-emitted PatchEffects with a depth cap (`garden.cascade-cap` diagnostic on hit) | **Shipped** (Phases 4a + 4a') |
| View-phase runner | `viewRunner` (`src/processors/runtime.ts`) + `runViewCommand` dispatcher (`src/engine/commands.ts`) — command-driven view processors fire; non-View effect emissions are phase-rejected | **Shipped** (Phase 4b) |
| Scheduler | `schedule:` triggers fire on cron from `dome serve` and `dome sync` via the `projection.db.schedule_cursors` table; minimal in-tree cron evaluator (`src/engine/cron.ts`); clock injection via `runOneAdoption({ now })` for deterministic harness testing | **Shipped** (Phase 4c) |
| Answer-trigger dispatch | `dome resolve` / `dome answer` records a QuestionEffect answer, then garden-phase processors with matching `answer` triggers run through normal effect routing. Recovery handlers bind triggers to the originating question processor as well as idempotency-key prefixes. | **Shipped** |
| Engine signal pub/sub | `signal: "engine.<name>"` namespace (terminal-failure, processor-quarantined, etc.) | Phase 4d |
| JobEffect runtime | `scheduled_jobs` table + `runQueuedJobs` dispatcher firing due jobs as garden-phase work with retry/backoff | **Shipped** (Phase 4e) |

See the brainstorm doc for the full plan including dependencies, tests, and the question-answer surface.

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
