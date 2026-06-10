# Cohesive Architecture Review — Dome SDK (abstraction layers, types, encapsulation)

**Date:** 2026-06-10
**Scope:** whole repo, lens on abstraction layers, type design, encapsulation points, and whether OOP framing would help
**Reviewer:** `cohesive:review-codebase`

## TL;DR

**Verdict:** Cohesive but under-enforced

**Thesis:** The paradigm is right and the conceptual architecture is sound — the codebase already practices OOP-by-other-means (frozen object handles, branded types, Result-typed constructors, discriminated unions with exhaustive switches, grep-linter-enforced write boundaries), and converting to classes would buy little. The "messy, hard to extend" feeling traces to three structural facts: `src/engine/`'s real five-layer internal structure is unnamed (42 flat files described by one doc line), the protocol-neutral service layer is mis-homed inside `src/cli/` (MCP already imports CLI commands), and the orientation docs promise enforcement and layout that don't exist (no CI, a documentation-only linter, a stale repo-layout block).

**Top findings**

### 1. `src/engine/`'s real layering exists but is unnamed

**Evidence:** `AGENTS.md:66` — "`engine/ # adoption loop + effect application (the single applier)`" describes 42 flat files spanning six roles (adoption core, capability, garden routing ×5, question lifecycle ×3, model provider ×3, locks ×3, host/daemon, health). The import graph is already a clean DAG; erosion has started: `src/engine/question-answering.ts:19` (operational layer) imports `compiler-host` (top orchestrator).

**Change:** Name the layers — add `docs/wiki/matrices/engine-module-map.md` (module → role → allowed intra-engine dependencies, analogous to `extension-bundle-shape`) plus an import-direction lint test in the existing grep-linter style; optionally split into `engine/{core,garden,operational,host}` subdirectories. Repair `AGENTS.md` layout block and five-services map in the same pass.

### 2. The protocol-neutral surface layer lives inside `src/cli/`

**Evidence:** `src/mcp/server.ts:48-50` — MCP, a second consumer surface, imports `../cli/commands/*`; `src/cli/commands/` carries 21 distinct engine/store-internal imports; `src/cli/commands/view-shared.ts:82` is already protocol-neutral. `docs/wiki/specs/sdk-surface.md:478` admits `AbstractSurface` "does not exist yet" while `AGENTS.md:21` routes new surfaces to it unqualified.

**Change:** Rehome the protocol-neutral run-functions to `src/surface/`; keep Commander bindings + presenters in `src/cli/` and let MCP adapt over `src/surface/` instead of importing an adapter. Don't build the full `AbstractSurface` interface yet — just rehome. Update sdk-surface §"Consumer surfaces" with the interim rule and the protocol-adapter matrix.

### 3. Docs promise enforcement that doesn't exist

**Evidence:** `AGENTS.md:39` — "Re-exporting `model.invoke` or MCP machinery from `src/index.ts` fails CI" — but `.github/workflows/` does not exist; every structural fence runs only on local `bun test`. `docs/wiki/linters/no-retired-symbol-names.md:124` claims a test and script ("Integrated into CI") that were never created; invariants and gotchas have coverage-lockstep tests, linters have none — which is exactly how a doc-only linter shipped.

**Change:** Add `.github/workflows/test.yml` running `bun test`; ship `tests/integration/no-retired-symbol-names.test.ts`; add a linter-coverage lockstep test mirroring AC3 (`tests/integration/invariant-coverage.test.ts`) so a linter spec without an enforcing test fails the suite.

### Recommended next Cohesive skill

`cohesive:rewrite-specs` — the architecture holds; the layering names, seam homes, and enforcement promises need to be made true. **Files to edit:** `AGENTS.md` (layout block, five-services map, chokepoint gloss, CI wording, AbstractSurface qualifier); new `docs/wiki/matrices/engine-module-map.md`; `docs/wiki/specs/sdk-surface.md` (§Consumer surfaces interim rule + new "Type ownership and construction" section); `docs/wiki/specs/capabilities.md` (§"Adding a capability tier"); `docs/wiki/specs/effects.md` (§"Adding an effect kind"); `docs/wiki/gotchas/boundary-validation-via-zod.md` (zod-4 single-sourcing); `docs/index.md:51` (applier gloss). Slug: `engine-layering-and-surface-seam`.

## Executive thesis

Dome's four-concept core (Vault, Proposal, Processor, Effect) is real in the code, not just the docs: effects are a discriminated union with exhaustive `kind` switches backed by `noFallthroughCasesInSwitch`, the applier and broker chokepoints exist where the invariants say they do, store directories keep `.raw` database access inside themselves, and the public surface is pinned by a shape test. The question the user asked — "would better OOP framing help?" — gets a precise answer: the codebase already has the *benefits* OOP encapsulation would provide, achieved through frozen handles, branded types, validating constructors, and grep-shaped linters; classes would forfeit exhaustive narrowing and structural round-tripping through sqlite/JSON for no gain. What it lacks is *named layering*: `src/engine/` grew from "adoption loop + applier" into six distinguishable subsystems without the substrate noticing; the protocol-adapter story acquired a second consumer (MCP) that imports the first (CLI) instead of a shared seam; and the enforcement story (CI, linter lockstep) lags the documentation that cites it. All of this is repairable with doc-shaped and seam-naming work — no architectural rework — which is why the verdict is under-enforcement, not architecture risk. Development can scale without founder memory *if* the engine map, the surface seam, and the extension recipes (capability tier, effect kind) land; today those four live in founder memory.

## Spec-prior review

### Docs read

- `AGENTS.md`, `CLAUDE.md`, `architecture.md`, `README.md`
- `docs/index.md`, `docs/VISION.md`, `docs/v1.md`, `docs/wedge.md`
- `docs/wiki/specs/` (sdk-surface, effects, processors, processor-execution, adoption, proposals, capabilities, cli, mcp-surface, harnesses, projection-store, run-ledger)
- `docs/wiki/matrices/` (all 8), `docs/wiki/invariants/` (20), `docs/wiki/gotchas/` (sampled), `docs/wiki/linters/` (5)

### Claimed architectural priors

- Sealed four-concept core: Vault, Proposal, Processor, Effect; no Tool/Hook/Workflow primitives.
- Five conceptual services in one Bun process; protocol adapters (CLI/MCP/future HTTP/voice) over one runtime/view boundary; "the engine doesn't know which surface is calling."
- Chokepoints pinned by axiom invariants: single applier, capability broker on every effect, proposals the only write path, no LLM/MCP dependency in core.
- Markdown + git are source of truth; projections rebuildable; operational state durable.
- Future direction: wedge plan (five surface-in phases, evolve-don't-rebuild), memory-quality plan, daily-surface plan.

### Spec inconsistencies

- `AGENTS.md:38` and `docs/index.md:51` gloss the applier as "single chokepoint at `apply-effect.ts`", contradicting the canonical `ENGINE_IS_THE_ONLY_APPLIER.md:14,23` (garden PatchEffects are rejected at `apply-effect.ts:31-34` and route via `garden-patch-dispatch.ts`). The canonical doc is right; the glosses an agent reads first are wrong.
- `AGENTS.md:139` maps "Processor Runtime (`src/processors/`) — scheduler", but the scheduler is `src/engine/scheduler.ts` (self-described "the engine subsystem"); view machinery in `engine/operational-query-view.ts` and `engine/view-command.ts` is absent from the service map.
- `AGENTS.md:60-92` repo layout omits `src/sqlite/`, `src/answers/`, `src/mcp/`, and six root modules.
- `AGENTS.md:39` and `no-retired-symbol-names.md:124` cite CI that doesn't exist.

Below the 3-blocking-issue gate threshold — the canonical substrate (invariants, specs, matrices) is internally coherent; drift concentrates in orientation glosses. Proceeded to full review.

### Recommended spec changes (independent of code review)

- Reword both applier glosses to the two-route formulation ("engine routing layer: generic effects via `apply-effect.ts`; garden patches via `garden-patch-dispatch.ts`").
- Correct the five-services → directory mapping; update the layout block with the four missing directories and one-line ownership each.
- Qualify `AGENTS.md:21`'s `AbstractSurface` route with "(planned; today: wrap the CLI command handlers as `src/mcp/server.ts` does)".

## System cohesion scorecard

| Area | Rating | Summary |
|---|---:|---|
| Spec coherence | Mostly healthy | Canonical substrate agrees with itself; inline counts ("eleven", "seventeen") in 9 docs are drift-prone; count-drift linter deferred |
| Code/spec alignment | Drifting | Drift concentrated in the most-read docs: AGENTS.md layout/services/chokepoint glosses and CI claims misstate reality; canonical invariant docs are accurate |
| Domain model clarity | Mostly healthy | Four-concept core crisp; Capability has a spec + matrix but no module (buried in `processor.ts:312`); engine's six internal roles unnamed |
| Invariant enforcement | Under-enforced | 19/19 shipped invariants have lockstep tests, but no CI runs them; one linter is documentation-only; linters have no coverage lockstep |
| Test guarantees | Mostly healthy | AC3 + gotcha-coverage lockstep, closed-set arrays, public-surface pin are exemplary; effect matrices pinned only by test comments |
| Locality and seams | Drifting | Store directories encapsulate well; engine is a 42-file flat namespace with upward-import erosion begun; MCP imports CLI (adapter-imports-adapter) |
| Library-native alignment | Mostly healthy | Near-zero type circumvention; bun:sqlite/Commander used natively; the zod 3 pin is the single root cause of every documented type-system fight |
| Agent-readiness | Mostly healthy | Add-processor/add-CLI recipes genuinely bounded; capability-tier and effect-kind additions lack recipes; engine interior requires file-by-file discovery |
| Future extensibility | Mostly healthy | Wedge-phase work lands in obvious places; each new consumer surface pays the CLI-import tax until the seam is rehomed |

## Highest-leverage findings

### 1. `src/engine/`'s real layering exists but is unnamed

**Severity:** High
**Category:** Locality
**Why it matters:** A contributor or agent must read the whole 42-file directory to learn what the import graph already encodes (vault-shape/runner-contract → apply/capability core → garden routing → operational work → host). Changes predictably land in the wrong layer (e.g. routing edits in `garden.ts` vs `garden-run-routing.ts`), and upward imports have already appeared.

**Evidence:**
- `AGENTS.md:66` — one line describing 42 files
- `src/engine/question-answering.ts:19` — operational-layer module importing `compiler-host` (top orchestrator)
- Directory listing: adoption, capability ×3, garden ×5, question ×3, model-provider ×3, locks ×3, host/daemon ×3, health

**Recommended fix:** Engine-module map (module → role → allowed intra-engine dependencies) + an import-direction lint test in the grep-linter house style; optionally subdirectories `engine/{core,garden,operational,host}`.

**Substrate artifact to add or update:** New `docs/wiki/matrices/engine-module-map.md`; new linter spec + test; `AGENTS.md` layout/services repair.

### 2. The protocol-neutral surface layer is mis-homed inside `src/cli/`

**Severity:** High
**Category:** Locality / seam
**Why it matters:** The planned `AbstractSurface` seam is no longer speculative — it has two consumers today (CLI, MCP) and a third planned (HTTP). MCP importing `../cli/commands/*` is the wrong dependency direction; every future surface pays the same tax, and `src/cli/commands/` accumulating 21 engine/store-internal imports makes the CLI the de-facto service layer.

**Evidence:**
- `src/mcp/server.ts:48-50` — imports from `../cli/commands/*`
- `src/cli/commands/view-shared.ts:82` — already protocol-neutral code living in an adapter
- `docs/wiki/specs/sdk-surface.md:478` — "`AbstractSurface` … does not exist yet"

**Recommended fix:** Rehome protocol-neutral run-functions to `src/surface/`; Commander bindings + presenters stay in `src/cli/`; MCP adapts over `src/surface/`. Defer the full `AbstractSurface` interface.

**Substrate artifact to add or update:** `docs/wiki/specs/sdk-surface.md` §Consumer surfaces (interim rule); `docs/wiki/matrices/protocol-adapter.md`.

### 3. Docs promise enforcement that doesn't exist (CI + doc-only linter)

**Severity:** High
**Category:** Invariant enforcement
**Why it matters:** An agent that trusts "fails CI" and skips the local run ships invariant violations silently. The `no-retired-symbol-names` linter exists only as documentation — retired vocabulary (Tool/Hook/Workflow) can re-enter normative docs unnoticed. Invariants and gotchas have coverage lockstep; linters don't, which is exactly how the gap shipped.

**Evidence:**
- `AGENTS.md:39` — "fails CI"; no `.github/workflows/` exists
- `docs/wiki/linters/no-retired-symbol-names.md:124` — cites `tests/integration/no-retired-symbol-names.test.ts` and `scripts/check-retired-symbols.sh`; neither exists
- `docs/index.md:109` lists the linter as *(v1)* shipped

**Recommended fix:** `.github/workflows/test.yml` running `bun test`; ship the missing linter test; add linter-coverage lockstep mirroring AC3.

**Substrate artifact to add or update:** CI workflow; semantic linter test; linter-coverage lockstep test; `AGENTS.md:39` wording.

### 4. The zod 3 pin is the root cause of every documented type-system fight

**Severity:** High
**Category:** Library alignment
**Why it matters:** Three separate documented workarounds trace to zod v3 limitations: hand-written dual-sourced Effect types (TS union + parallel Zod schemas, because v3 `.optional()` collides with `exactOptionalPropertyTypes`), the `as unknown as Manifest` cast, and the `superRefine` re-application because v3 `discriminatedUnion` rejects refined members. Zod 4 fixed both root causes; the codebase already uses `z.infer` in 11 places and wants single-sourcing.

**Evidence:**
- `package.json:45` — `"zod": "^3.23.0"`
- `src/core/effect.ts:20-23` — house note: "Downstream code should type from the `Effect` union, not `z.infer`"
- `src/extensions/manifest-schema.ts:297` — `shapeResult.data as unknown as Manifest`
- `src/core/effect.ts:719-723` — `FactEffectObjectSchema` split + `superRefine`

**Recommended fix:** Migrate to zod 4 (or `zod/v4` subpath via ^3.25 incrementally); derive `Effect`/`Manifest` via `z.infer`; interim, add per-kind compile-time assignability assertions (runtime round-trips in `tests/core/effect.test.ts:122` catch only value-level drift).

**Substrate artifact to add or update:** Rewrite `docs/wiki/gotchas/boundary-validation-via-zod.md`; retire the effect.ts dual-sourcing house note.

### 5. Capability is a documented core concept without a module

**Severity:** Medium
**Category:** Domain model
**Why it matters:** The 17-tier capability taxonomy has its own spec and matrix but lives at `src/core/processor.ts:230-340` inside a 980-line file that also carries ModelInvoke and query-view types. The code's carving doesn't match the substrate's carving — an agent looking for "the capability type" greps, rather than navigating.

**Evidence:** `src/core/processor.ts:312` — `export type Capability =` inside processor.ts.

**Recommended fix:** Split `src/core/capability.ts`, keeping types + Zod schemas co-resident (the co-residence convention is serving locality well — keep it).

**Substrate artifact to add or update:** `docs/wiki/specs/sdk-surface.md` new §"Type ownership and construction".

### 6. Five stores hand-roll the same six-step open lifecycle

**Severity:** Medium
**Category:** Locality (missing concept, not premature centralization)
**Why it matters:** mkdir → open+configure → schema-hash read → mismatch policy → DDL+shape-validate → meta row repeats across four `open*Db` functions, and `health.ts` hand-rolls a sixth readonly probe. The contract is real and stable; the only divergence (refuse vs rebuild on mismatch) is a parameter. Each new store re-implements and re-tests the same lifecycle.

**Evidence:** `src/ledger/db.ts:329-415`, `src/outbox/db.ts:191-367`, `src/answers/db.ts:119-151`, `src/projections/db.ts:600+`, `src/engine/health.ts:1493` — identical step comments and error kinds.

**Recommended fix:** `openOperationalStore({ddl, mismatchPolicy})` in `src/sqlite/` (which already owns `configureSqliteConnection`).

**Substrate artifact to add or update:** Store-module convention spec; add `src/sqlite/` to the `AGENTS.md` layout block.

### 7. `VaultRuntime` exposes whole store handles

**Severity:** Medium
**Category:** Domain model / encapsulation
**Why it matters:** Every holder of the runtime gets raw `projectionDb`/`answersDb`/`outboxDb`/`ledgerDb`; write discipline rests on a doc comment ("NOT for use outside the ledger layer", `src/ledger/db.ts:240`) plus a grep linter. This is the one place class-private enforcement would genuinely pay — and the same payoff is available cheaper by narrowing the exposed field types to the `ProjectionQueryView`/`OperationalQueryView` interfaces the runtime already defines.

**Evidence:** `src/engine/vault-runtime.ts:129-156`.

**Recommended fix:** Type the public fields as the narrow query-view interfaces; expose full handles only to the engine layer that constructs the runtime. No class needed.

**Substrate artifact to add or update:** Same §"Type ownership and construction" section as finding 5.

### 8. Adding a capability tier has no recipe — the only extension shape without one

**Severity:** Medium
**Category:** Agent-readiness
**Why it matters:** Processor/CLI/invariant/bundle additions all have numbered recipes; a capability tier touches ~8 sites (type union, manifest schema, broker, policy, default vault config, closed-set test array, capabilities.md "seventeen" prose, effect-x-capability matrix). The compiler finds the broker switches; an agent predictably misses the manifest schema, default grants, and doc sites.

**Evidence:** `docs/wiki/specs/capabilities.md` lines 14–317 — no "Adding a…" section.

**Recommended fix:** capabilities.md §"Adding a capability tier" enumerating compile-found vs manual sites.

**Substrate artifact to add or update:** `docs/wiki/specs/capabilities.md`.

### 9. Effect-kind addition: code sites compiler-pinned, doc sites unpinned

**Severity:** Medium
**Category:** Agent-readiness / spec coherence
**Why it matters:** Code routing is exemplary (`never`-checks at `apply-effect.ts:754`, `effect-capability-use.ts:91`, `capability-broker.ts:197,245`; closed-set arrays in `coverage-matrix.test.ts:204`). But "eleven" is inlined in 9 docs, the effect matrices are pinned only by test comments, and the count-drift linter is deferred. An agent adding kind 12 satisfies the compiler and ships nine stale docs.

**Evidence:** `grep -rln "eleven" docs/` → 9 files; `docs/wiki/specs/effects.md:35` names only two of the required route files.

**Recommended fix:** effects.md §"Adding an effect kind" checklist (all compile/test/doc sites); convert "eleven-kind" prose to categorical references per the repo's own link-to-canonical convention.

**Substrate artifact to add or update:** `docs/wiki/specs/effects.md`; extend `docs/wiki/gotchas/substrate-count-drift.md` covered-consts list.

### 10. Orientation glosses contradict the canonical applier invariant and service map

**Severity:** Medium
**Category:** Spec drift
**Why it matters:** `AGENTS.md:38` calls `apply-effect.ts` "the single chokepoint" (the broker is `capability-broker.ts`, called from three sites); `docs/index.md:51` says mutation happens in exactly one module while garden patches route via `garden-patch-dispatch.ts`; `AGENTS.md:139` places the scheduler in `src/processors/` when it lives at `src/engine/scheduler.ts`. The canonical invariant doc states the two-route reality correctly — the summaries an agent reads first misstate it.

**Evidence:** `ENGINE_IS_THE_ONLY_APPLIER.md:14,23` vs `AGENTS.md:38`, `docs/index.md:51`; `src/engine/scheduler.ts:1-7` vs `AGENTS.md:135-144`.

**Recommended fix:** Reword both glosses to the two-route formulation; correct the service → directory mapping.

**Substrate artifact to add or update:** `AGENTS.md`; `docs/index.md`.

### 11. Block-anchor ids are bare strings while every sibling identity is branded

**Severity:** Low
**Category:** Library alignment / type design
**Why it matters:** `VaultPath`, `CommitOid`, `BlobOid`, `TreeOid`, `CapabilityToken` all use `__brand` with validating constructors. Block-anchor ids — the move-stable identity the task-lifecycle and warden direction lean on — are `readonly id: string`; a raw string can flow into `NodeRef.stableId` unvalidated against `BLOCK_ANCHOR_RE`.

**Evidence:** `src/core/block-anchor.ts:18-22` vs `src/core/vault-path.ts:11`; `src/core/effect.ts:396` — `stableId: z.string().min(1)`.

**Recommended fix:** `BlockAnchorId` brand + constructor reusing `BLOCK_ANCHOR_RE`; thread through the `NodeRef` task variant.

**Substrate artifact to add or update:** §"Type ownership and construction" (list which identities are branded and who constructs them).

### 12. Small library-native cleanups

**Severity:** Low
**Category:** Library alignment
**Why it matters / Evidence / Fix:**
- `ProcessorPhase` re-spelled inline as `"adoption" | "garden" | "view"` at `src/core/processor.ts:538,553` — the substrate-count-drift failure mode in type form. Fix: `PROCESSOR_PHASES` const array + `(typeof PROCESSOR_PHASES)[number]`.
- `combineAbortSignals` (`src/processors/runtime.ts:625-651`) reinvents native `AbortSignal.any()`. Fix: replace, delete the `CombinedAbortSignal` cleanup protocol.
- The module-orientation-header convention (spec citations atop `adopt.ts:1-18`, `runtime.ts:1-12`, `health.ts:1-6`) is what makes the 1,500-line files bounded-context-viable — and it's unwritten. Fix: name it as a linter-shaped convention for files >400 lines.

**Substrate artifact to add or update:** `docs/wiki/gotchas/substrate-count-drift.md`; new `docs/wiki/linters/module-orientation-headers.md`.

## Confusing or weak concepts

| Concept | Issue | Recommendation |
|---|---|---|
| Engine (as one concept) | One name covering six roles; doc line says two | Name the internal layers (matrix + optional subdirs) |
| Capability | Spec + matrix exist; no module — buried in `processor.ts` | Split `src/core/capability.ts` |
| AbstractSurface | Routed-to by AGENTS.md but doesn't exist; interim rule implicit | State the interim rule; rehome `src/surface/` first |
| `src/sqlite/` | Real shared infrastructure, absent from the repo-layout map | Document ownership; grow `openOperationalStore` there |
| Service map | Five-services prose doesn't match module homes (scheduler, view) | Correct the mapping in AGENTS.md |

## Invariants that should be named

| Invariant | Current enforcement | Recommended enforcement |
|---|---|---|
| Engine intra-module import direction (layers only import downward) | None (convention visible only in the import graph) | Engine-module-map matrix + grep-style import-direction lint test |
| Store handles don't escape their layer raw | Doc comments + `no-direct-mutation` linter | Narrow `VaultRuntime` field types to query-view interfaces |
| Every linter spec has an enforcing test | None (invariants/gotchas have lockstep; linters don't) | Linter-coverage lockstep test mirroring AC3 |

## Test guarantee gaps

| Behavior | Current coverage | Risk | Recommended test |
|---|---|---|---|
| Retired symbol names stay out of normative docs | None (doc-only linter) | Vocabulary regression | `tests/integration/no-retired-symbol-names.test.ts` |
| Effect/capability matrices match code | Test comments only | Silent matrix staleness | Pin matrix rows to the closed-set arrays |
| TS Effect union ≡ Zod schemas | Runtime round-trips only | Compile-time shape drift | Per-kind assignability assertions (until zod 4 lands) |

## Locality and abstraction review

- `src/core/` — co-residence of types + Zod + helpers is serving locality; the split that matters is by *concept* (capability out of processor.ts), not by *kind* (types vs schemas).
- `src/engine/` — clean DAG, flat namespace; the layering is real and derivable, so the fix is naming + fencing, not redesign.
- Stores (`projections/`, `ledger/`, `outbox/`, `answers/`, `quarantine`) — encapsulation discipline is real; duplication of the open lifecycle is the missing-concept signal.
- `src/cli/` — carrying the de-facto service layer; rehome to `src/surface/`.

## Library-native alignment opportunities

- zod 3 → 4 migration unlocks `z.infer` single-sourcing, deletes two casts, collapses the superRefine layering (finding 4).
- `AbortSignal.any()` replaces the hand-rolled combiner.
- Discriminated unions over class hierarchies confirmed as the right call: exhaustive narrowing, structural round-tripping, Zod boundary validation. Do not convert to classes.
- `as unknown` discipline is exemplary (~6 sites, each with documented type-system-shaped rationale).

## Agent-readiness

- Add-processor and add-CLI-command tasks are genuinely bounded (4 and 3 edits, recipe-documented, lockstep-fenced).
- Capability-tier and effect-kind additions need recipes (findings 8, 9); the compiler pins code sites, nothing pins doc sites.
- The 1,000+-line modules are viable because of orientation headers citing specs/invariants; name that convention before the next large module omits it.
- `src/engine/` interior requires file-by-file discovery until the module map lands.

## Substrate improvements

### Specs to rewrite
- `AGENTS.md` — layout block (+4 directories, 6 root modules), five-services mapping, applier gloss, "fails CI" wording, AbstractSurface qualifier
- `docs/wiki/specs/sdk-surface.md` — §Consumer surfaces interim rule; new §"Type ownership and construction" (branded identities, constructor ownership, type/schema co-residence convention, why no classes)
- `docs/wiki/specs/capabilities.md` — §"Adding a capability tier"
- `docs/wiki/specs/effects.md` — §"Adding an effect kind" checklist; categorical "eleven-kind" references
- `docs/index.md:51` — applier gloss
- `docs/wiki/gotchas/boundary-validation-via-zod.md` — drop dual-sourcing convention after zod 4

### Behavior matrices to add
- `docs/wiki/matrices/engine-module-map.md` — module → role → allowed intra-engine dependencies

### Semantic linters to add
- Engine import-direction lint (grep-style test)
- `no-retired-symbol-names` test (ship the documented one)
- Linter-coverage lockstep (mirror AC3)
- `module-orientation-headers` convention

### Gotchas to document
- Local-only enforcement window (if CI stays deferred)
- Extend `substrate-count-drift` covered-consts with `PROCESSOR_PHASES`

## Phased roadmap

### First: repair substrate
1. `AGENTS.md` repairs (layout, services, glosses, CI wording, AbstractSurface qualifier) + `docs/index.md:51`.
2. `engine-module-map` matrix; capability-tier and effect-kind recipes; sdk-surface type-ownership section + interim consumer-surface rule.

### Then: simplify architecture
1. Rehome protocol-neutral run-functions to `src/surface/`; MCP adapts over it.
2. Split `src/core/capability.ts`; `openOperationalStore` factory in `src/sqlite/`; narrow `VaultRuntime` exposed handles.
3. zod 4 migration; derive Effect/Manifest via `z.infer`; brand `BlockAnchorId`; `PROCESSOR_PHASES`; `AbortSignal.any()`.

### Then: strengthen enforcement
1. `.github/workflows/test.yml` running `bun test`.
2. Ship `no-retired-symbol-names` test; linter-coverage lockstep; engine import-direction lint.
3. Per-kind Effect assignability assertions (drop after zod 4 single-sourcing).

## Appendices (linked)

- Substrate discovery report: `docs/cohesive/substrate-discovery/2026-06-10-oop-abstraction-layers.md`
- Per-reviewer raw findings: returned inline by the four reviewer agents (structure, library-native, substrate-alignment, agent-readiness) during the 2026-06-10 session; key findings merged above with attribution preserved in evidence lines.

## History

### Predecessors

- Pass 1 review: `docs/cohesive/reviews/2026-05-26-dome-v0.5-cohesion-architecture-review.md` — verdict: Cohesive but under-enforced
- Pass 2 review: `docs/cohesive/reviews/2026-05-26-dome-v0.5-cohesion-architecture-review-pass-2.md` — verdict: Cohesive but under-enforced
- Readiness review: `docs/cohesive/reviews/2026-05-26-dome-v0.5-to-v1-readiness-architecture-review.md` — verdict: Cohesive but under-enforced

### Disposition of prior findings

Not re-derived row-by-row this pass: the 2026-05-27 v1 engine-model rewrite superseded the v0.5-era finding set (Tools/Hooks/Workflows vocabulary, pre-engine module layout), and the intervening implementation audit (`2026-06-02-dome-v1-implementation-audit.md`) tracked closure of that era's items. This pass's findings are treated as a fresh baseline for the v1 shape.

### Verdict trajectory

| Pass | Date | Verdict | Highest-leverage observation |
|---|---|---|---|
| 1 | 2026-05-26 | Cohesive but under-enforced | Core-SDK vs consumer-shell boundary half-built |
| 2 | 2026-05-26 | Cohesive but under-enforced | Core/shell seal real; labels on the new seam lagging |
| readiness | 2026-05-26 | Cohesive but under-enforced | Rules depend on reviewer memory; promote to structure |
| this | 2026-06-10 | Cohesive but under-enforced | Engine layering unnamed; surface seam mis-homed in CLI; enforcement promises (CI, linter) unkept |

### Notes for the next iteration

- The consumer-surface concern is the same finding family pass 1 raised about core-vs-shell; it has now concretized as MCP-imports-CLI. If `src/surface/` lands, the next review should check no engine-internal imports leak into it.
- Re-check the zod pin: if AI SDK or MCP SDK majors force a zod 4 peer anyway, the migration cost drops.
- `docs/wedge.md` Phase 5 (MCP server) shipped; HTTP is the next surface — review the seam before it lands, not after.
