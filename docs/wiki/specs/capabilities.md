---
type: spec
created: 2026-05-27
updated: 2026-05-27
sources: ["[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]", "[[v1]]"]
---

# Capabilities

This spec is normative for Dome's capability broker — the one chokepoint that decides whether an [[wiki/specs/effects|Effect]] emitted by a [[wiki/specs/processors|Processor]] is applied or rejected. Every effect, regardless of source, passes through `enforceCapability(effect, processor.capabilities, grants)` before the engine applies it. This is pinned by [[wiki/invariants/EVERY_EFFECT_IS_CAPABILITY_CHECKED]].

## Why a capability broker

The four-concept v0.5 core enforced trust via the hook-source partition (`HookSource = "sdk" | "plugin" | "vault-local"` with `HookContext.privilegedWriter` only on the SDK source). That worked when first-party hooks were the only ones in the vault.

The v1 engine model treats every behavior as an extension — first-party `dome.*` bundles use the same registration path as third-party bundles. A trust partition by source is no longer sufficient; the design needs per-effect, per-path, per-namespace scoping. The capability broker is the answer: each processor declares what powers it needs; the vault config grants what powers it gets; the broker enforces the intersection at runtime.

## Capability tiers

Capabilities are about **effect power**, not arbitrary trust labels. Ten tiers cover every effect a processor can emit:

```ts
type Capability =
  | { kind: "read";          paths: string[] }                  // glob patterns; allows reading via ctx.snapshot
  | { kind: "patch.propose"; paths: string[] }                  // allows PatchEffect mode:"propose"
  | { kind: "patch.auto";    paths: string[] }                  // allows PatchEffect mode:"auto"
  | { kind: "owns.region";   regionIds: string[] }              // exclusive ownership of marker regions
  | { kind: "owns.path";     paths: string[] }                  // exclusive ownership of paths (e.g., index.md)
  | { kind: "graph.write";   namespaces: string[] }             // FactEffect namespaces
  | { kind: "question.ask";  namespaces?: string[] }            // QuestionEffect namespaces / channels
  | { kind: "job.enqueue";   processors: string[] }             // JobEffect target processor ids or glob patterns
  | { kind: "model.invoke";  maxDailyCostUsd?: number; modelAllowlist?: string[] }
  | { kind: "external";      capability: string };              // ExternalActionEffect capabilities (e.g., "calendar.write")
```

### `read`

Permits the processor to read paths matching the listed glob patterns via `ctx.snapshot`. Paths outside the granted set return `null` from snapshot reads — the processor cannot accidentally observe data it has no business reading.

Default for adoption-phase processors: the paths their triggers match (read what you react to). Garden-phase processors typically request broader read (whole `wiki/` to cross-reference).

### `patch.propose`

Permits `PatchEffect` with `mode: "propose"` for paths matching the glob. Propose-mode patches are **not applied** in the adoption phase — they emit a diagnostic naming the proposed patch; the user reviews and applies via `dome lint --apply`. Safe-by-default for processors with broad write intent.

### `patch.auto`

Permits `PatchEffect` with `mode: "auto"` for paths matching the glob. Auto-mode patches are applied directly inside the adoption loop. Granted narrowly — typically only to processors that own a region or path.

**Downgrade behavior:** a `mode: "auto"` PatchEffect whose touched paths exceed `patch.auto` capability is downgraded to `mode: "propose"` and emits a [[wiki/gotchas/capability-downgrade-surprise]] diagnostic. The diagnostic surfaces the mismatch to the user without breaking the loop.

### `owns.region`

Marker-delimited region ownership. A processor that `owns.region: ["dome.daily.morning_brief"]` is the only one allowed to write inside `<!-- dome:region id="dome.daily.morning_brief" --> ... <!-- /dome:region -->` markers. Another processor's patch that touches the region is rejected.

Region ownership is checked at patch application — the engine parses the candidate tree's regions, identifies which regions the patch modifies, and asserts each modified region is owned by the emitting processor.

### `owns.path`

Whole-file ownership. `dome.index` owns `index.md`; `dome.log` owns `log.md`. Other processors' PatchEffects touching these paths are rejected.

Path ownership replaces v0.5's `INDEX_AND_LOG_ARE_DISPATCHER_OWNED` invariant — same property, expressed as a capability rather than a hard-coded refusal in the writer layer.

### `graph.write`

Permits writing FactEffects for the named namespaces. A namespace is the dotted prefix before the predicate (`dome.tasks.dueDate` → namespace `dome.tasks`).

A processor with `graph.write: ["dome.tasks.*"]` can emit FactEffects with `predicate: "dome.tasks.dueDate"`, `predicate: "dome.tasks.priority"`, etc. — but not `predicate: "dome.people.attendee"`. Cross-namespace writes are isolation-by-construction.

### `question.ask`

Permits emitting QuestionEffects. Questions are a user-interruption channel, so the power is separate from `graph.write`: extracting facts does not automatically authorize asking the user to make an operational decision. Optional `namespaces` scope which question families the processor may create (for example `dome.intake` content questions vs `dome.health` operational questions). When omitted, the grant applies to the processor's own bundle namespace only.

### `job.enqueue`

Permits emitting JobEffects. The `processors` list scopes which target processor ids can be scheduled; entries may be exact ids (`dome.daily.refresh-brief`) or bundle-level globs (`dome.daily.*`). Same-bundle enqueue can be granted by default in shipped first-party manifests, but it is still represented as a capability so scheduled follow-on work is explicit and ledgered.

### `model.invoke`

Permits the processor to call LLMs via `ctx.modelInvoke`. Adoption-phase processors **never** get this capability — the broker rejects `model.invoke` in adoption manifests at registration time. Garden-phase processors typically request it.

Optional fields:
- `maxDailyCostUsd: number` — cap on per-processor LLM spend per day; engine tracks via the run ledger's `cost` field.
- `modelAllowlist: string[]` — restrict to specific model identifiers (e.g., `["claude-3-5-sonnet"]`); default allows the harness's configured default.

### `external`

Permits emitting `ExternalActionEffect` with the named capability. Each external capability is a separate grant — `external: "calendar.write"` does not imply `external: "notify.push"`.

External capabilities are registered as handlers in the SDK (or in a plugin bundle); the engine looks up the handler at outbox dispatch time. Capability handlers live at `src/external-handlers/<capability>.ts` for first-party (calendar, notify, network); plugin-contributed handlers register through their bundle's `external-handlers/` directory.

## Manifest schema

A bundle declares its processors' capabilities in `manifest.yaml`:

```yaml
name: dome.intake
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
      - kind: question.ask
        namespaces: ["dome.intake"]
      - kind: job.enqueue
        processors: ["dome.daily.*"]
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

The schema is validated by Zod at bundle load. A capability with an unknown `kind`, a malformed `paths` pattern, or a `model.invoke` requested by an adoption-phase processor fails the load with a `bundle-load-failure` error (per [[wiki/specs/sdk-surface]] §"Bundle-loader error taxonomy").

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

The broker enforces the **intersection** of declared capabilities (in `manifest.yaml`) and granted capabilities (in `config.yaml`). A processor that declared `patch.auto: ["**"]` but was granted only `patch.auto: ["wiki/generated/**"]` has effective auto-patch reach of `wiki/generated/**` only.

Shipped-default grants (the ones a fresh `dome init` writes): `dome.markdown`, `dome.index`, `dome.log`, `dome.links`, `dome.intake`, `dome.daily`, `dome.lint`, `dome.search` all receive their declared capabilities. Third-party bundles default to `enabled: false` until the user explicitly opts in.

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

Called from `src/engine/apply-effect.ts` exactly once per effect, before any routing. No code outside `src/engine/apply-effect.ts` reaches `enforceCapability`; no code outside the engine reaches the application layer at all. This is the structural fence behind [[wiki/invariants/EVERY_EFFECT_IS_CAPABILITY_CHECKED]] and [[wiki/invariants/ENGINE_IS_THE_ONLY_APPLIER]].

`tests/integration/capability-enforcement.test.ts` ships positive and negative cases for every capability kind × every effect kind. The matrix at [[wiki/matrices/effect-x-capability]] enumerates the pairs.

## Capability uses are ledgered

Every effect that passes enforcement records a `CapabilityUse` row in the run ledger's `RunRecord` (per [[wiki/specs/run-ledger]] §"CapabilityUse"). This is the audit surface for "what did this processor actually do" and the input to per-extension cost / quota tracking.

## Why ten tiers, not more

The ten cover every effect kind and the one non-effect power (`model.invoke`). Three properties drive the closed set:

1. **Effect coverage.** Each effect kind in [[wiki/specs/effects]] has a corresponding required capability per [[wiki/matrices/effect-x-capability]]. Adding capabilities beyond the ten would mean inventing effects or runtime powers without a routing target.
2. **Trust dimensions are about effect power, not source.** Distinguishing "trusted plugin" from "untrusted plugin" via tier doesn't help; what matters is what the plugin can *do*. `external: "calendar.write"` is the trust dimension; the plugin is whoever holds it.
3. **The enforcement code stays simple.** Ten cases in `enforceCapability` is auditable. A more granular set would push enforcement into per-effect-kind validators, dispersing the trust contract.

## Related

- [[wiki/specs/processors]] — declarations live in the processor manifest
- [[wiki/specs/effects]] — effects are what capabilities gate
- [[wiki/specs/run-ledger]] §"CapabilityUse" — audit surface
- [[wiki/matrices/effect-x-capability]] — the per-effect-kind requirement table
- [[wiki/invariants/EVERY_EFFECT_IS_CAPABILITY_CHECKED]] — structural fence
- [[wiki/gotchas/capability-downgrade-surprise]] — auto→propose downgrade UX
