---
type: spec
created: 2026-05-27
updated: 2026-05-27
sources: ["[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]", "[[v1]]"]
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
  readonly triggers: Trigger[];     // signal / path / schedule / command
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
  readonly modelInvoke?: ModelInvokeFn;   // present iff capability `model.invoke` granted
  readonly sourceRef(path: string, range?: TextRange): SourceRef;  // helper for SourceRef construction
}
```

A `Processor` returns `Effect[]`. It does not call writers, git, sqlite, or any other mutation surface. The engine routes the returned effects through capability enforcement, then applies them. This is the structural fence behind [[wiki/invariants/EFFECTS_ARE_THE_ONLY_PROCESSOR_OUTPUT]].

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
- Never mutate state — `PatchEffect`, `DiagnosticEffect`, `FactEffect`, `JobEffect`, `ExternalActionEffect` from a view-phase processor are rejected by the broker as capability violations.

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

- **Adoption-phase processors** subscribe to `signal:*`, `path:*`. Not `schedule:*` or `command:*` — adoption is per-Proposal, not periodic or user-invoked.
- **Garden-phase processors** subscribe to `signal:*`, `path:*`, `schedule:*`. Not `command:*` — garden is autonomous, not user-driven.
- **View-phase processors** subscribe to `command:*` only. Views render on demand, not on signal.

## Capabilities

A processor declares its capabilities in its bundle's `manifest.yaml` ([[wiki/specs/capabilities]] §"Manifest schema"). The runtime resolves the grant against the vault's `config.yaml` policy; the broker enforces at effect-emission time.

Adoption-phase processors get a restricted capability set by default — no `model.invoke`, no `network`, narrow `patch.auto` paths. Garden-phase processors may be granted `model.invoke` and broader `patch.propose`. View-phase processors get only `read` (within declared paths) and `graph.read` (within declared namespaces). See [[wiki/specs/capabilities]] §"Capability tiers" for the full set.

## Idempotency

Every processor must be idempotent: running it twice on the same `(snapshot, input)` must produce equivalent effects. The engine deduplicates by `(processorId, processorVersion, snapshotCommit, triggerHash)` in the run ledger and may short-circuit a re-run when a cached run record matches.

Non-idempotent processors are a design defect, not a runtime exception. The engine treats them as if they were idempotent; non-determinism produces undefined behavior in the fixed-point loop. See [[wiki/gotchas/processor-idempotency]].

## Execution semantics

Every invocation is wrapped by the runtime contract in [[wiki/specs/processor-execution]]: one RunRecord, a bounded phase-specific timeout, schema validation for returned effects, typed model-invoke failures, and explicit retry/quarantine behavior for garden runs. This page defines what a processor is allowed to declare and return; the execution spec defines how the engine calls it and records the outcome.

## Registration

Processors register via the extension-bundle mechanism (per [[wiki/specs/sdk-surface]] §"Extension bundles"). A bundle's `processors/` directory contains TypeScript files exporting Processor objects. The runtime loads them at `openVault` time.

```ts
// assets/extensions/dome.intake/processors/extract-capture.ts
import { defineProcessor } from "@dome/sdk";
import type { Effect } from "@dome/sdk";

export default defineProcessor({
  id: "dome.intake.extract-capture",
  version: "1.0.0",
  phase: "garden",
  triggers: [
    { kind: "signal", name: "file.created", pathPattern: "inbox/raw/**" },
  ],
  capabilities: [
    { kind: "read", paths: ["inbox/raw/**", "wiki/**"] },
    { kind: "patch.propose", paths: ["wiki/**", "inbox/processed/**"] },
    { kind: "model.invoke", maxDailyCostUsd: 5.00 },
  ],
  async run(ctx): Promise<Effect[]> {
    // read the new capture file from ctx.snapshot
    // call ctx.modelInvoke to compile it to wiki updates
    // return PatchEffect[] + FactEffect[]
  },
});
```

`defineProcessor` is a type-narrowing identity function. Adding a new processor is one file edit (in the bundle's `processors/` directory) plus a row in the bundle's `manifest.yaml`'s `processors:` block.

## First-party processors (the `dome.*` bundles)

Every behavior Dome ships out of the box is a first-party extension bundle under `assets/extensions/dome.*`. The current set:

| Bundle | Phase × processors | What it does |
|---|---|---|
| `dome.markdown` | adoption: parse, validate-wikilinks | Parses markdown structure; emits DiagnosticEffect on broken wikilinks and frontmatter schema violations. |
| `dome.index` | adoption: update-index | Maintains `index.md` as a committed projection of `wiki/`. Owns the `index.md` path. |
| `dome.log` | adoption: append-log | Maintains `log.md` from the run ledger. Owns the `log.md` path. |
| `dome.links` | garden: cross-reference | On entity-page creation, finds mentions in other wiki pages and emits PatchEffect to add backlinks. |
| `dome.intake` | garden: extract-capture | On `inbox/raw/*` creation, calls the LLM to compile the capture into wiki updates. |
| `dome.daily` | garden: create-daily, carry-forward; view: today, week-review | Creates daily/weekly notes; carries unfinished tasks forward; renders agenda views. |
| `dome.lint` | view: lint-report | Walks the wiki, emits DiagnosticEffect for each finding, renders the report. |
| `dome.search` | adoption: index-text; view: semantic-search | Maintains the FTS5 + embedding projection; answers query requests. |

The full map (which contribution kind comes from which bundle) is at [[wiki/matrices/built-in-extensions-x-phase]].

The bundles ship in the SDK at `assets/extensions/dome.*/`. `dome init` does not copy first-party bundle code into the vault; it writes activations and grants in `<vault>/.dome/config.yaml`, and the runtime resolves shipped bundles from the SDK package. Users disable a first-party bundle with `enabled: false` in `<vault>/.dome/config.yaml`; `<vault>/.dome/extensions/` is reserved for vault-local third-party bundles or overrides.

## What a processor cannot do

- **Mutate state directly.** No filesystem writes, no git calls, no SQLite writes. The engine is the only applier. Pinned by [[wiki/invariants/ENGINE_IS_THE_ONLY_APPLIER]].
- **Emit effects beyond its declared capabilities.** Every effect passes through `enforceCapability(effect, processor.capabilities)` at the engine boundary. Pinned by [[wiki/invariants/EVERY_EFFECT_IS_CAPABILITY_CHECKED]].
- **Run outside its declared phase.** An adoption-phase processor cannot be triggered by a `schedule:` cron; a view-phase processor cannot emit a `PatchEffect`. Phase × effect compatibility is enforced at registration time and re-checked at effect-emission time.
- **Call other processors directly.** Processors emit effects; the engine may dispatch follow-on processors based on effects, but a processor cannot synchronously invoke another. This is what keeps the snapshot-in-effects-out boundary clean.

## Run ledger

Every processor invocation, regardless of outcome, writes one `RunRecord` row to the run ledger ([[wiki/specs/run-ledger]]). The record captures `runId`, `processorId`, `processorVersion`, `phase`, `proposalId?`, `inputCommit`, `outputCommit?` (for adoption-phase processors that contributed to a closure commit), `status` (queued / running / succeeded / failed / skipped), `effectHashes`, `capabilityUses`, `cost?`, `error?`, `startedAt`, `finishedAt?`. Pinned by [[wiki/invariants/EVERY_PROCESSOR_RUN_IS_LEDGERED]].

## Implementation status

The v1 engine completion sequence (see [[cohesive/brainstorms/2026-05-27-v1-engine-completion]]) lands the three-phase model in stages:

| Phase | What ships | Status |
|---|---|---|
| Adoption-phase runner | `adoptionRunner` (`src/processors/runtime.ts`) fires adoption-phase processors inside the fixed-point loop | **Shipped** (Phase 3) |
| Garden-phase runner | `gardenRunner` fires post-adoption garden-phase processors against signal + path triggers; the engine constructs sub-Proposals from garden-emitted PatchEffects with a depth cap (`garden.cascade-cap` diagnostic on hit) | **Shipped** (Phases 4a + 4a') |
| View-phase runner | `viewRunner` (`src/processors/runtime.ts`) + `runViewCommand` dispatcher (`src/engine/commands.ts`) — command-driven view processors fire; non-View effect emissions are phase-rejected | **Shipped** (Phase 4b) |
| Scheduler | `schedule:` triggers fire on cron from `dome serve` and `dome sync` via the `projection.db.schedule_cursors` table | Phase 4c |
| Engine signal pub/sub | `signal: "engine.<name>"` namespace (terminal-failure, processor-quarantined, etc.) + the `answer` trigger kind | Phase 4d |
| JobEffect runtime | `scheduled_jobs` table + in-memory dispatcher firing due jobs as garden-phase work | Phase 4e |

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
