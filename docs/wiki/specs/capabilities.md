---
type: spec
created: 2026-05-27
updated: 2026-06-10
sources:
  - "[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"
  - "[[v1]]"
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
  | { kind: "question.ask" }                                    // QuestionEffect emission
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

The same effective `read` grant also gates source provenance on emitted content/user-visible effects. If a processor emits a `DiagnosticEffect`, `FactEffect`, `SearchDocumentEffect`, `QuestionEffect`, `ExternalActionEffect`, `PatchEffect`, or `ViewEffect` scope containing a `SourceRef`, every referenced path must be readable by that processor. This keeps processors from bypassing `ctx.sourceRef()` by importing the raw `sourceRef()` constructor and attaching evidence from paths they cannot read. For processors with an effective `model.invoke` grant, PatchEffects must include at least one SourceRef before routing; the executor rejects source-less model-generated writes with `processor.invalid-output`, then the broker checks those refs against effective `read`.

Default for adoption-phase processors: the paths their triggers match (read what you react to). Garden-phase processors typically request broader read (whole `wiki/` to cross-reference).

### `patch.propose`

Permits `PatchEffect` with `mode: "propose"` for paths matching the glob. Propose-mode patches are **not applied** in the adoption phase — they emit a diagnostic naming the proposed patch. The review/apply UX is still a v1.x lint surface; until it ships, proposed patches are visible as diagnostics rather than silently mutating the vault. Safe-by-default for processors with broad write intent.

### `patch.auto`

Permits `PatchEffect` with `mode: "auto"` for paths matching the glob. Auto-mode patches are applied directly inside the adoption loop. Granted narrowly — typically only to processors that own a region or path.

**Downgrade behavior:** a `mode: "auto"` PatchEffect whose touched paths exceed `patch.auto` capability is downgraded to `mode: "propose"` and emits a [[wiki/gotchas/capability-downgrade-surprise]] diagnostic. In adoption, that proposed patch then blocks for review; outside adoption it follows the phase's propose route.

**Raw exception:** `raw/**` is not grantable write territory in v1. The broker denies both `patch.auto` and `patch.propose` effects touching `raw/**` even when a processor has otherwise broad path reach. Direct committed raw mutations are blocked separately by [[wiki/invariants/RAW_IS_IMMUTABLE]]'s adoption processor.

### `owns.region`

Marker-delimited region ownership. A processor that `owns.region: ["dome.daily.morning_brief"]` is the only one allowed to write inside `<!-- dome:region id="dome.daily.morning_brief" --> ... <!-- /dome:region -->` markers. Another processor's patch that touches the region is rejected.

Implementation status: the core type exists as a planned API, but region parsing and enforcement are not shipped yet. V1 runtime manifests and config reject `owns.region`, and the broker denies hand-built PatchEffect routing that carries it, rather than pretending the generated-region boundary is safe. Current v1 enforcement covers `owns.path`; `owns.region` can be enabled only after parser-backed broker enforcement and harness coverage land.

### `owns.path`

Whole-file ownership. For example, a future `dome.index` bundle can own `index.md`, and a future `dome.log` bundle can own `log.md`. Other processors' PatchEffects touching those owned paths are rejected once the owning bundle and grants are present.

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

Permits emitting QuestionEffects. Questions are a user-interruption channel, so the power is separate from `graph.write`: extracting facts does not automatically authorize asking the user to make an operational decision. V1 enforcement is binary (`question.ask` present or absent) because `QuestionEffect` has no namespace/channel field. Namespaced question grants are deliberately rejected until the effect shape carries a real scope. Operational recovery answer handlers must separately bind their `answer` triggers to the originating question processor plus the idempotency-key prefix; that is the current confused-deputy guard for privileged recovery flows.

### `job.enqueue`

Permits emitting JobEffects. The `processors` list scopes which target processor ids can be scheduled; entries may be exact ids (`dome.daily.refresh-brief`) or bundle-level globs (`dome.daily.*`). Same-bundle enqueue can be granted by default in shipped first-party manifests, but it is still represented as a capability so scheduled follow-on work is explicit and ledgered.

### `model.invoke`

Permits the processor to call LLMs via `ctx.modelInvoke`. Adoption-phase processors **never** get this capability — the loader rejects `model.invoke` in adoption manifests at registration time. Garden- and view-phase processors receive a model handle only when the capability is both declared and granted. The handle is provider-neutral: core receives an injected `ModelProvider` or a vault-configured command provider, not a direct import of a vendor SDK.

Optional fields:
- `maxDailyCostUsd: number` — cap on bundle-level LLM spend per
  local day. The runtime sums provider-reported `cost_usd` rows for the
  processor's extension-id prefix since local midnight, adds the
  current run's in-memory cost, and denies further calls with
  `model.invoke.denied` once the effective cap is reached. The effective
  cap is min(declared, granted); a vault grant raised above the manifest
  declaration cannot take effect, so `dome doctor` / `dome check` raise a
  `model.budget-grant-capped` warning naming both numbers and the binding
  side whenever a grant exceeds the declaration.
- `modelAllowlist: string[]` — restrict to specific model identifiers (e.g., `["claude-3-5-sonnet"]`); default allows the harness's configured default.

The runtime enforces the intersection of the declared and granted allowlists before any provider call, and records each model-call attempt in `capability_uses` with `capability = "model.invoke"` and the resolved model as the resource when known. It also enforces the stricter defined `maxDailyCostUsd` from declaration and grant: before a provider call it denies when the cap is already spent; after a provider-reported cost is recorded it denies the output if that call pushed spend over the cap. The model handle shares the processor invocation signal, so processor timeout/cancellation aborts in-flight provider calls. Provider responses are validated inside the model boundary before processor code receives them. A command provider is configured in `.dome/config.yaml` as `model_provider: { kind: "command", command: [...] }`; it runs from the vault root, receives a `dome.model-provider.request/v1` JSON object on stdin, and must return `{ "text": string, "model"?: string, "costUsd"?: number }` on stdout. The same command may also receive a `dome.model-provider.step/v1` envelope (the tool-use step seam, see [[wiki/specs/autonomous-agents]]) and a `dome.model-provider.probe/v1` envelope. The probe envelope is `{ "schema": "dome.model-provider.probe/v1" }`; a probe-aware provider answers `{ "schema": "dome.model-provider.probe/v1", "ok": true, "provider"?: string, "keyPresent"?: boolean, "defaultModel"?: string }` on stdout and exits 0 **without making any network or paid API call** — `keyPresent` reports whether the provider's credential environment variable is set, and the probe must succeed even when it is not. Providers that predate the probe envelope may reject it with a non-zero exit; the prober treats that as "alive but probe-unsupported", not as a failure. `dome doctor` reports a read-only preflight warning when active processors both declare and receive `model.invoke` but no model provider is configured or injected into the host, and probes a configured command provider (spawnable? probe-responsive? credential present?) per [[wiki/specs/cli]] §"dome doctor". Structured output uses `ctx.modelInvoke.structured({ schemaName, parse })`; parse failures become nominal runtime-created `model.output.*` run errors rather than generic `processor.threw`. Processor-thrown or provider-thrown objects cannot opt into model execution codes by shape. Model-capable PatchEffects are additionally required to carry SourceRefs at the executor boundary so LLM-written vault changes are evidence-backed before capability routing.

### `external`

Permits emitting `ExternalActionEffect` with the named capability. Each external capability is a separate grant — `external: "calendar.write"` does not imply `external: "notify.push"`.

External capabilities are registered as handlers at the runtime boundary; the engine looks up the registered handler at outbox dispatch time, and a missing handler fails explicitly in `outbox.db` rather than disappearing. Handlers arrive two ways: **caller-injected** registries (hosts, tests) and **bundle-discovered** `external-handlers/<capability>.ts` modules, bound by filename stem per [[wiki/matrices/extension-bundle-shape]] — `openVaultRuntime` wraps each bundle handler to inject the absolute vault root into its input (caller-injected handlers are not wrapped). The first shipped bundle handler is `dome.sources`' `sources.fetch` ([[wiki/specs/sources]]). Each handler attempt is bounded by `engine.external_handler_timeout_ms` (default 30 000 ms) — the dispatch `AbortSignal` fires at the bound and the attempt lands in normal outbox retry.

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
id: dome.agent
version: 1.0.0
description: "Autonomous-agent processors for vault-wide ingest and maintenance."

processors:
  - id: dome.agent.ingest
    version: 1.0.0
    phase: garden
    capabilities:
      - kind: read
        paths:
          - "wiki/**/*.md"
          - "notes/**/*.md"
          - "inbox/**/*.md"
          - "index.md"
          - "log.md"
      - kind: patch.auto
        paths:
          - "wiki/**/*.md"
          - "notes/**/*.md"
          - "index.md"
          - "log.md"
          - "inbox/processed/*.md"
          - "inbox/raw/*.md"
      - kind: model.invoke
        maxDailyCostUsd: 5
      - kind: question.ask

  - id: dome.agent.inbox-stale-check
    version: 0.1.0
    phase: garden
    capabilities:
      - kind: read
        paths: ["inbox/**/*.md"]
```

The schema is validated by Zod at bundle load. A capability with an unknown `kind`, a malformed `paths` pattern, or a `model.invoke` requested by an adoption-phase processor fails the load with a `bundle-load-failed` error (per [[wiki/specs/sdk-surface]] §"Bundle-loader error taxonomy").

## Vault grants

The vault's `<vault>/.dome/config.yaml` grants capabilities to specific extensions:

```yaml
extensions:
  dome.agent:
    enabled: true
    grant:
      read:
        - wiki/**/*.md
        - notes/**/*.md
        - inbox/**/*.md
        - index.md
        - log.md
      patch.auto:
        - wiki/**/*.md
        - notes/**/*.md
        - index.md
        - log.md
        - inbox/processed/*.md
        - inbox/raw/*.md
      model.invoke:
        maxDailyCostUsd: 5
      question.ask: true

  dome.daily:
    enabled: true
    config:
      daily_path: notes/{date}.md
    grant:
      read:
        - wiki/**/*.md
        - notes/*.md
      patch.auto:
        - wiki/**/*.md
        - notes/*.md
      graph.write:
        - dome.daily.*
      question.ask: true

  dome.markdown:
    enabled: true
    grant:
      read:
        - wiki/**/*.md
      patch.auto:
        - wiki/**/*.md
      question.ask: true
    processors:
      dome.markdown.validate-wikilinks:
        grant:
          read:
            - "**/*.md"
          patch.auto:
            - "wiki/**/*.md"

  acme.calendar-sync:
    enabled: true
    grants:
      external:
        - calendar.write
        - calendar.read
        - network.post
```

With a config file present, `extensions.<bundle>.enabled: true` is the activation boundary: omitted bundles and `enabled: false` bundles are not registered into the runtime. The broker then enforces the **intersection** of declared capabilities (in `manifest.yaml`) and granted capabilities (in `config.yaml`) for active processors. A processor that declared `patch.auto: ["**"]` but was granted only `patch.auto: ["wiki/generated/**"]` has effective auto-patch reach of `wiki/generated/**` only.

Processor-specific grants live under `extensions.<bundle>.processors.<processor-id>.grant` (or `grants`). A processor override is a **replacement** for the bundle grant, not an additive patch. Processors without an override inherit the bundle grant. This lets one bundle hold processors with different natural scopes: for example, a wikilink resolver may need to read all markdown to resolve targets while a frontmatter normalizer in the same bundle may be granted patches only under `wiki/**/*.md`.

Extension config and grant blocks are validated fail-loudly when the runtime opens the vault: unknown extension-level keys, unknown processor-level keys, unknown capability keys, malformed scalar/list shapes, invalid operational enum values, ambiguous `grant`/`grants` aliases, non-map `config`, non-map `processors`, or non-boolean `enabled` values abort runtime construction instead of silently reducing the effective grant set. The extension-level keys are closed to `enabled`, `grant`, `grants`, `processors`, and opaque per-extension `config`. Processor-level keys are closed to `grant` and `grants`.

`dome doctor` also reports active processors whose declared capability kinds
are entirely missing from their effective vault grants. This is a read-only
configuration-drift probe for older or hand-edited `.dome/config.yaml` files:
it catches cases where an enabled processor would later skip, degrade, or
block during capability enforcement because the bundle was installed without
the matching grant kind.

Shipped-default grants (the ones a fresh `dome init` writes): default-on first-party bundles receive their declared capabilities. `dome.markdown` is granted markdown/image reads, markdown auto-patches for frontmatter normalization, high-confidence existing-page wikilink repair, explicit source-backed concept/entity stub creation, and stale managed `updated:` metadata refresh, synthesis-page auto-patches for source-preserving duplicate reviews, and `question.ask` for duplicate-detection plus ambiguous-link questions; `dome.graph` is granted markdown reads and `dome.graph.*` fact writes; `dome.daily` is granted `wiki/**/*.md` plus root `notes/*.md` reads, matching auto-patches for daily creation, daily open-loop surfacing, and accepted follow-up answers, `dome.daily.*` fact writes, and `question.ask`; `dome.search` is granted markdown reads and `search.write` for `**/*.md`; `dome.health` is granted broad read for failed-row source provenance, failed-row `outbox.read`, `outbox.recover`, `quarantine.read`, `quarantine.recover`, running-row `run.read`, `run.recover`, and `question.ask`; `dome.lint` is granted markdown reads for its adopted-state report. `dome.agent` is shipped with an opt-in disabled grant skeleton because it needs a vault-configured `ModelProvider`; when enabled, it also receives `question.ask`, broad wiki/notes/inbox reads, matching `patch.auto` for wiki/notes/index/log/inbox-processed/inbox-raw paths, and `model.invoke` so the ingest agent can integrate raw captures and the stale-check can inspect active inbox buckets. The `patch.auto` grant covers `notes/**` by design — the capability grant is the single write boundary, and `raw/**` is explicitly absent (see [[wiki/invariants/RAW_IS_IMMUTABLE]]). Third-party bundles default to inactive until the user explicitly opts in.

`tests/integration/default-vault-config.test.ts` keeps broad shipped-default
path grants in lockstep. Any new default path grant over `**`, `**/*`, or
`raw/**` territory must update that explicit list, which forces review instead
of letting broad read/write reach appear incidentally.

## Enforcement chokepoint

The single function that enforces capabilities:

```ts
// src/engine/core/capability-broker.ts
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

Called exactly once at the engine effect-routing boundary before an effect can mutate state or write projections. Adoption, view, and non-patch garden effects call it through `src/engine/core/apply-effect.ts`; garden PatchEffects call it through `src/engine/garden/garden-patch-dispatch.ts` / `src/engine/garden/garden-patch-router.ts` because their route target is sub-Proposal construction. No code outside the engine reaches `enforceCapability` or the application layer. This is the structural fence behind [[wiki/invariants/EVERY_EFFECT_IS_CAPABILITY_CHECKED]] and [[wiki/invariants/ENGINE_IS_THE_ONLY_APPLIER]].

`tests/engine/capability-broker.test.ts`, `tests/engine/apply-effect.test.ts`, and `tests/engine/garden-patch-router.test.ts` ship positive and negative cases across broker enforcement and routing. The matrix at [[wiki/matrices/effect-x-capability]] enumerates the pairs.

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
