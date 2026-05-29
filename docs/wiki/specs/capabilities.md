---
type: spec
created: 2026-05-27
updated: 2026-05-29
sources: ["[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]", "[[v1]]"]
---

# Capabilities

This spec is normative for Dome's capability broker — the one chokepoint that decides whether an [[wiki/specs/effects|Effect]] emitted by a [[wiki/specs/processors|Processor]] is applied or rejected. Every effect, regardless of source, passes through `enforceCapability(effect, processor.capabilities, grants)` before the engine applies it. This is pinned by [[wiki/invariants/EVERY_EFFECT_IS_CAPABILITY_CHECKED]].

## Why a capability broker

The four-concept v0.5 core enforced trust via the hook-source partition (`HookSource = "sdk" | "plugin" | "vault-local"` with `HookContext.privilegedWriter` only on the SDK source). That worked when first-party hooks were the only ones in the vault.

The v1 engine model treats every behavior as an extension — first-party `dome.*` bundles use the same registration path as third-party bundles. A trust partition by source is no longer sufficient; the design needs per-effect, per-path, per-namespace scoping. The capability broker is the answer: each processor declares what powers it needs; the vault config grants what powers it gets; the broker enforces the intersection at runtime.

## Capability tiers

Capabilities are about **effect power**, not arbitrary trust labels. Seventeen tiers cover every effect a processor can emit and every non-effect runtime power exposed through processor context:

```ts
type Capability =
  | { kind: "read";          paths: string[] }                  // glob patterns; allows content/metadata reads via ctx.snapshot
  | { kind: "patch.propose"; paths: string[] }                  // allows PatchEffect mode:"propose"
  | { kind: "patch.auto";    paths: string[] }                  // allows PatchEffect mode:"auto"
  | { kind: "owns.region";   regionIds: string[] }              // exclusive ownership of marker regions
  | { kind: "owns.path";     paths: string[] }                  // exclusive ownership of paths (e.g., index.md)
  | { kind: "graph.write";   namespaces: string[] }             // FactEffect namespaces
  | { kind: "search.write";  paths: string[] }                  // SearchDocumentEffect paths
  | { kind: "question.ask";  namespaces?: string[] }            // QuestionEffect namespaces / channels
  | { kind: "job.enqueue";   processors: string[] }             // JobEffect target processor ids or glob patterns
  | { kind: "model.invoke";  maxDailyCostUsd?: number; modelAllowlist?: string[] }
  | { kind: "external";      capability: string }               // ExternalActionEffect capabilities (e.g., "calendar.write")
  | { kind: "outbox.read";   statuses?: ("pending" | "sent" | "failed" | "abandoned")[] }
  | { kind: "outbox.recover"; actions: ("retry" | "abandon")[] } // OutboxRecoveryEffect actions
  | { kind: "quarantine.read" }
  | { kind: "quarantine.recover"; actions: Array<"reset"> }      // QuarantineRecoveryEffect actions
  | { kind: "run.read";      statuses?: ("queued" | "running" | "succeeded" | "failed" | "skipped" | "timed_out" | "cancelled")[] }
  | { kind: "run.recover";   actions: Array<"fail"> };           // RunRecoveryEffect actions
```

### `read`

Permits the processor to read paths matching the listed glob patterns via `ctx.snapshot`. This covers both content reads (`readFile`, `listMarkdownFiles`) and path metadata reads (`getFileInfo`). Paths outside the granted set return `null` from snapshot reads — the processor cannot accidentally observe data it has no business reading.

The same effective `read` grant also gates source provenance on emitted content/user-visible effects. If a processor emits a `DiagnosticEffect`, `FactEffect`, `SearchDocumentEffect`, `QuestionEffect`, `ExternalActionEffect`, `PatchEffect`, or `ViewEffect` scope containing a `SourceRef`, every referenced path must be readable by that processor. This keeps processors from bypassing `ctx.sourceRef()` by importing the raw `sourceRef()` constructor and attaching evidence from paths they cannot read.

Default for adoption-phase processors: the paths their triggers match (read what you react to). Garden-phase processors typically request broader read (whole `wiki/` to cross-reference).

### `patch.propose`

Permits `PatchEffect` with `mode: "propose"` for paths matching the glob. Propose-mode patches are **not applied** in the adoption phase — they emit a diagnostic naming the proposed patch. The review/apply UX is still a v1.x lint surface; until it ships, proposed patches are visible as diagnostics rather than silently mutating the vault. Safe-by-default for processors with broad write intent.

### `patch.auto`

Permits `PatchEffect` with `mode: "auto"` for paths matching the glob. Auto-mode patches are applied directly inside the adoption loop. Granted narrowly — typically only to processors that own a region or path.

**Downgrade behavior:** a `mode: "auto"` PatchEffect whose touched paths exceed `patch.auto` capability is downgraded to `mode: "propose"` and emits a [[wiki/gotchas/capability-downgrade-surprise]] diagnostic. In adoption, that proposed patch then blocks for review; outside adoption it follows the phase's propose route.

### `owns.region`

Marker-delimited region ownership. A processor that `owns.region: ["dome.daily.morning_brief"]` is the only one allowed to write inside `<!-- dome:region id="dome.daily.morning_brief" --> ... <!-- /dome:region -->` markers. Another processor's patch that touches the region is rejected.

Implementation status: the capability kind and manifest/config schema exist, but region parsing and enforcement are not shipped yet. Current v1 enforcement covers `owns.path`; `owns.region` remains a planned generated-region boundary and should not be used as a shipped safety claim until the parser and harness coverage land.

### `owns.path`

Whole-file ownership. `dome.index` owns `index.md`; `dome.log` owns `log.md`. Other processors' PatchEffects touching these paths are rejected.

Path ownership replaces v0.5's `INDEX_AND_LOG_ARE_DISPATCHER_OWNED` invariant — same property, expressed as a capability rather than a hard-coded refusal in the writer layer.

### `graph.write`

Permits writing FactEffects for the named namespaces. A namespace is the dotted prefix before the predicate (`dome.tasks.dueDate` → namespace `dome.tasks`).

A processor with `graph.write: ["dome.tasks.*"]` can emit FactEffects with `predicate: "dome.tasks.dueDate"`, `predicate: "dome.tasks.priority"`, etc. — but not `predicate: "dome.people.attendee"`. Cross-namespace writes are isolation-by-construction.

### `search.write`

Permits writing SearchDocumentEffects for paths matching the listed globs.
This is the only processor-facing authority for the shared FTS projection:
`dome.search.index-text` can index `**/*.md`, but it cannot write arbitrary
SQLite rows or index paths outside its grant. The projection sink owns the
FTS5 upsert/delete SQL.

### `question.ask`

Permits emitting QuestionEffects. Questions are a user-interruption channel, so the power is separate from `graph.write`: extracting facts does not automatically authorize asking the user to make an operational decision. The `namespaces` field is accepted in manifests/config as the planned scope shape, but the current `QuestionEffect` has no namespace/channel field to enforce against, so v1 enforcement is binary (`question.ask` present or absent). Operational recovery answer handlers must separately bind their `answer` triggers to the originating question processor plus the idempotency-key prefix; that is the current confused-deputy guard for privileged recovery flows.

### `job.enqueue`

Permits emitting JobEffects. The `processors` list scopes which target processor ids can be scheduled; entries may be exact ids (`dome.daily.refresh-brief`) or bundle-level globs (`dome.daily.*`). Same-bundle enqueue can be granted by default in shipped first-party manifests, but it is still represented as a capability so scheduled follow-on work is explicit and ledgered.

### `model.invoke`

Permits the processor to call LLMs via `ctx.modelInvoke`. Adoption-phase processors **never** get this capability — the loader rejects `model.invoke` in adoption manifests at registration time. Garden- and view-phase processors receive a model handle only when the capability is both declared and granted. The handle is provider-neutral: core receives an injected `ModelProvider`, not a direct import of a vendor SDK.

Optional fields:
- `maxDailyCostUsd: number` — cap on per-processor LLM spend per day. The run ledger already records provider-reported run-local cost; daily cap enforcement is the next policy layer.
- `modelAllowlist: string[]` — restrict to specific model identifiers (e.g., `["claude-3-5-sonnet"]`); default allows the harness's configured default.

The runtime enforces the intersection of the declared and granted allowlists before any provider call. The model handle shares the processor invocation signal, so processor timeout/cancellation aborts in-flight provider calls. Provider responses are validated inside the model boundary before processor code receives them. Structured output uses `ctx.modelInvoke.structured({ schemaName, parse })`; parse failures become nominal runtime-created `model.output.*` run errors rather than generic `processor.threw`. Processor-thrown or provider-thrown objects cannot opt into model execution codes by shape.

### `external`

Permits emitting `ExternalActionEffect` with the named capability. Each external capability is a separate grant — `external: "calendar.write"` does not imply `external: "notify.push"`.

External capabilities are registered as handlers at the runtime boundary; the engine looks up the injected handler at outbox dispatch time. Bundle-discovered handler directories are planned, but v1 currently supports caller-injected handlers only, so missing handlers fail explicitly in `outbox.db` rather than disappearing.

### `outbox.read`

Permits reading operational outbox rows through `ctx.operational.outbox()`.
The runtime exposes this query view only to non-adoption processors whose
declaration and vault grant both include `outbox.read`; optional `statuses`
scope which row states are visible. This is a read power, not a mutation
power: processors still recover rows only by emitting `OutboxRecoveryEffect`.

### `outbox.recover`

Permits emitting `OutboxRecoveryEffect` for the listed actions. This is a narrow operational capability for answer-handler and health processors: `retry` re-queues a failed outbox row; `abandon` marks a failed row as no longer actionable. It does not permit arbitrary outbox reads or writes.

### `quarantine.read`

Permits reading processor quarantine rows through `ctx.operational.quarantines()`. This is intentionally separate from outbox access: a health processor can see which processor trigger is quarantined without receiving arbitrary projection, ledger, or outbox write power.

### `quarantine.recover`

Permits emitting `QuarantineRecoveryEffect` for the listed actions. Today the only action is `reset`, which clears one quarantine generation after the user approves a `dome.health` recovery question. It does not permit direct mutation of processor execution state.

### `run.read`

Permits reading orphaned running rows through `ctx.operational.orphanRuns()`.
The runtime exposes this query view only to non-adoption processors whose
declaration and vault grant both include `run.read` with visibility of
`status: "running"`. This is a read power, not a mutation power: processors
recover stuck runs only by emitting `RunRecoveryEffect`.

### `run.recover`

Permits emitting `RunRecoveryEffect` for the listed actions. Today the only
action is `fail`, which marks one exact running-row generation failed after
the user approves a `dome.health` recovery question. It does not permit
arbitrary run-ledger mutation.

## Manifest schema

A bundle declares its processors' capabilities in `manifest.yaml`:

```yaml
id: dome.intake
version: 1.0.0
description: "Compile raw captures into wiki updates."

processors:
  - id: extract-capture
    version: 1.0.0
    phase: garden
    capabilities:
      - kind: read
        paths: ["inbox/raw/**", "wiki/**", "notes/**"]
      - kind: patch.propose
        paths: ["**"]
      - kind: patch.auto
        paths: ["wiki/generated/intake/**", "inbox/processed/**"]
      - kind: graph.write
        namespaces: ["dome.tasks", "dome.people"]
      - kind: model.invoke
        maxDailyCostUsd: 5.00

  - id: detect-capture
    version: 1.0.0
    phase: adoption
    capabilities:
      - kind: read
        paths: ["inbox/raw/**"]
      - kind: patch.auto
        paths: ["inbox/raw/**"]   # only for adding stable IDs to the capture frontmatter
```

The schema is validated by Zod at bundle load. A capability with an unknown `kind`, a malformed `paths` pattern, or a `model.invoke` requested by an adoption-phase processor fails the load with a `bundle-load-failed` error (per [[wiki/specs/sdk-surface]] §"Bundle-loader error taxonomy").

## Vault grants

The vault's `<vault>/.dome/config.yaml` grants capabilities to specific extensions:

```yaml
extensions:
  dome.intake:
    enabled: true
    grants:
      model.invoke: true
      patch.auto:
        - wiki/generated/intake/**
        - inbox/processed/**
      external:
        - calendar.write   # if the user wants intake to write calendar events
    config:
      confidence_threshold: 0.82

  acme.calendar-sync:
    enabled: true
    grants:
      external:
        - calendar.write
        - calendar.read
        - network.post
```

With a config file present, `extensions.<bundle>.enabled: true` is the activation boundary: omitted bundles and `enabled: false` bundles are not registered into the runtime. The broker then enforces the **intersection** of declared capabilities (in `manifest.yaml`) and granted capabilities (in `config.yaml`) for active processors. A processor that declared `patch.auto: ["**"]` but was granted only `patch.auto: ["wiki/generated/**"]` has effective auto-patch reach of `wiki/generated/**` only.

Extension config and grant blocks are validated fail-loudly when the runtime opens the vault: unknown extension-level keys, unknown capability keys, malformed scalar/list shapes, invalid operational enum values, ambiguous `grant`/`grants` aliases, non-map `config`, or non-boolean `enabled` values abort runtime construction instead of silently reducing the effective grant set. The extension-level keys are closed to `enabled`, `grant`, `grants`, and opaque per-extension `config`.

Shipped-default grants (the ones a fresh `dome init` writes): currently shipped first-party bundles receive their declared capabilities. `dome.markdown` is granted markdown/image reads, markdown auto-patches, and `question.ask` for duplicate-detection questions; `dome.graph` is granted markdown reads and `dome.graph.*` fact writes; `dome.daily` is granted wiki-page reads, auto-patches only for `wiki/dailies/*.md`, `dome.daily.*` fact writes, and `question.ask`; `dome.search` is granted markdown reads and `search.write` for `**/*.md`; `dome.health` is granted broad read for failed-row source provenance, failed-row `outbox.read`, `outbox.recover`, `quarantine.read`, `quarantine.recover`, running-row `run.read`, `run.recover`, and `question.ask`; `dome.lint` needs no grants today. Third-party bundles default to inactive until the user explicitly opts in.

## Enforcement chokepoint

The single function that enforces capabilities:

```ts
// src/capabilities/enforce.ts
function enforceCapability(
  effect: Effect,
  declared: Capability[],
  granted: Capability[],
): EnforcementResult;

type EnforcementResult =
  | { kind: "allow" }
  | { kind: "downgrade"; rewrittenEffect: Effect; diagnostic: DiagnosticEffect }
  | { kind: "deny";     diagnostic: DiagnosticEffect };
```

Called exactly once at the engine effect-routing boundary before an effect can mutate state or write projections. Adoption, view, and non-patch garden effects call it through `src/engine/apply-effect.ts`; garden PatchEffects call it through `src/engine/garden-patch-dispatch.ts` / `src/engine/garden-patch-router.ts` because their route target is sub-Proposal construction. No code outside the engine reaches `enforceCapability` or the application layer. This is the structural fence behind [[wiki/invariants/EVERY_EFFECT_IS_CAPABILITY_CHECKED]] and [[wiki/invariants/ENGINE_IS_THE_ONLY_APPLIER]].

`tests/integration/capability-enforcement.test.ts` ships positive and negative cases for every capability kind × every effect kind. The matrix at [[wiki/matrices/effect-x-capability]] enumerates the pairs.

## Capability uses are ledgered

Every effect attempt with a capability dimension records a `CapabilityUse` row in the run ledger's `RunRecord` (per [[wiki/specs/run-ledger]] §"CapabilityUse"), including allowed, downgraded, and denied attempts. This is the audit surface for "what did this processor try to reach" and the input to per-extension cost / quota tracking.

## Why seventeen tiers, not more

The seventeen cover every effect kind and the non-effect runtime powers (`model.invoke`, operational outbox reads, operational quarantine reads, and operational run reads). Three properties drive the closed set:

1. **Effect/runtime-power coverage.** Each effect kind in [[wiki/specs/effects]] has a corresponding required capability per [[wiki/matrices/effect-x-capability]], and non-effect runtime powers (`model.invoke`, `outbox.read`, `quarantine.read`, `run.read`) have explicit context gates. Adding capabilities beyond the seventeen would mean inventing effects or runtime powers without a routing target.
2. **Trust dimensions are about effect power, not source.** Distinguishing "trusted plugin" from "untrusted plugin" via tier doesn't help; what matters is what the plugin can *do*. `external: "calendar.write"` is the trust dimension; the plugin is whoever holds it.
3. **The enforcement code stays simple.** Seventeen cases across effect enforcement and context gating are auditable. A more granular set would push enforcement into per-effect-kind validators, dispersing the trust contract.

## Related

- [[wiki/specs/processors]] — declarations live in the processor manifest
- [[wiki/specs/effects]] — effects are what capabilities gate
- [[wiki/specs/run-ledger]] §"CapabilityUse" — audit surface
- [[wiki/matrices/effect-x-capability]] — the per-effect-kind requirement table
- [[wiki/invariants/EVERY_EFFECT_IS_CAPABILITY_CHECKED]] — structural fence
- [[wiki/gotchas/capability-downgrade-surprise]] — auto→propose downgrade UX
